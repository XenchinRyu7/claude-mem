import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';

// SQLite configuration constants
const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; // 256MB
const SQLITE_CACHE_SIZE_PAGES = 10_000;

// Maximum number of malformed schema objects to repair in one open cycle.
// Prevents infinite recursion if every repair attempt yields a new corrupt object.
const MAX_SCHEMA_REPAIR_ITERATIONS = 10;

/**
 * Python script that drops a named schema object and resets migration versions,
 * allowing the migration runner to recreate the object cleanly.
 *
 * Extracted as a constant so it is written to disk as-is rather than being
 * reconstructed on every repair call.
 */
const SCHEMA_REPAIR_SCRIPT = `\
import sqlite3, sys
db_path = sys.argv[1]
obj_name = sys.argv[2]
c = sqlite3.connect(db_path)
c.execute('PRAGMA writable_schema = ON')
c.execute('DELETE FROM sqlite_master WHERE name = ?', (obj_name,))
c.execute('PRAGMA writable_schema = OFF')
# Reset migration versions so affected migrations re-run.
# Guard with existence check: schema_versions may not exist on a very fresh DB.
has_sv = c.execute(
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_versions'"
).fetchone()[0]
if has_sv:
  c.execute('DELETE FROM schema_versions')
c.commit()
c.close()
`;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

let dbInstance: Database | null = null;

/**
 * Repair malformed database schema before migrations run.
 *
 * This handles the case where a database is synced between machines running
 * different claude-mem versions. A newer version may have added columns and
 * indexes that an older version (or even the same version on a fresh install)
 * cannot process. SQLite throws "malformed database schema" when it encounters
 * an index referencing a non-existent column, which prevents ALL queries —
 * including the migrations that would fix the schema.
 *
 * The fix: use Python's sqlite3 module (which supports writable_schema) to
 * drop the orphaned schema objects, then let the migration system recreate
 * them properly. bun:sqlite doesn't allow DELETE FROM sqlite_master even
 * with writable_schema = ON.
 */
function repairMalformedSchema(db: Database): void {
  try {
    // Quick test: if we can query sqlite_master, the schema is fine
    db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('malformed database schema')) {
      throw error;
    }

    logger.warn('DB', 'Detected malformed database schema, attempting repair', { error: message });

    // Extract the problematic object name from the error message
    // Format: "malformed database schema (object_name) - details"
    const match = message.match(/malformed database schema \(([^)]+)\)/);
    if (!match) {
      logger.error('DB', 'Could not parse malformed schema error, cannot auto-repair', { error: message });
      throw error;
    }

    const objectName = match[1];
    logger.info('DB', `Dropping malformed schema object: ${objectName}`);

    // Get the DB file path. For file-based DBs, we can use Python to repair.
    // For in-memory DBs, we can't shell out — just re-throw.
    const dbPath = db.filename;
    if (!dbPath || dbPath === ':memory:' || dbPath === '') {
      logger.error('DB', 'Cannot auto-repair in-memory database');
      throw error;
    }

    // Close the connection so Python can safely modify the file
    db.close();

    // Verify python3 is available before attempting the repair.
    // The check is a best-effort guard: it throws early with a clear message
    // rather than letting execFileSync fail with an opaque ENOENT error.
    try {
      execFileSync('python3', ['--version'], { timeout: 5000, stdio: 'ignore' });
    } catch {
      throw new Error(
        `Schema repair requires python3, but it was not found on PATH. ` +
        `Run \`python3 --version\` in your terminal to verify installation, then retry.` +
        ` Alternatively, manually delete ${dbPath} to start fresh.`
      );
    }

    // Use Python's sqlite3 module to drop the orphaned object and reset
    // related migration versions so they re-run and recreate things properly.
    // bun:sqlite doesn't support DELETE FROM sqlite_master even with writable_schema.
    //
    // We write a temp script rather than using -c to avoid shell escaping issues
    // with paths containing spaces or special characters. execFileSync passes
    // args directly without a shell, so dbPath and objectName are safe.
    const scriptPath = join(tmpdir(), `claude-mem-repair-${Date.now()}.py`);
    try {
      writeFileSync(scriptPath, SCHEMA_REPAIR_SCRIPT);
      execFileSync('python3', [scriptPath, dbPath, objectName], { timeout: 10000 });
      logger.info('DB', `Dropped orphaned schema object "${objectName}" and reset migration versions via Python sqlite3. All migrations will re-run (they are idempotent).`);
    } catch (pyError: unknown) {
      const pyMessage = pyError instanceof Error ? pyError.message : String(pyError);
      logger.error('DB', 'Python sqlite3 repair failed', { error: pyMessage });
      throw new Error(`Schema repair failed: ${message}. Python repair error: ${pyMessage}`);
    } finally {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    }
  }
}

/**
 * Wrapper that handles the close/reopen cycle needed for schema repair.
 * Returns a (possibly new) Database connection.
 *
 * Caps iterations at MAX_SCHEMA_REPAIR_ITERATIONS to prevent infinite
 * recursion when repeated repairs keep uncovering additional corrupt objects.
 *
 * @param dbPath  Path to the SQLite database file.
 * @param db      Current database connection.
 * @param iteration  Current recursion depth; defaults to 0 on the initial call.
 */
function repairMalformedSchemaWithReopen(dbPath: string, db: Database, iteration = 0): Database {
  try {
    db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
    return db;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('malformed database schema')) {
      throw error;
    }

    if (iteration >= MAX_SCHEMA_REPAIR_ITERATIONS) {
      logger.error('DB', `Schema repair exceeded ${MAX_SCHEMA_REPAIR_ITERATIONS} iterations — giving up to prevent infinite loop`, { error: message });
      throw new Error(`Schema repair failed after ${MAX_SCHEMA_REPAIR_ITERATIONS} attempts: ${message}`);
    }

    // repairMalformedSchema closes the DB internally for Python access
    repairMalformedSchema(db);

    // Reopen and check for additional malformed objects
    const newDb = new Database(dbPath, { create: true, readwrite: true });
    return repairMalformedSchemaWithReopen(dbPath, newDb, iteration + 1);
  }
}

/**
 * ClaudeMemDatabase - New entry point for the sqlite module
 *
 * Replaces SessionStore as the database coordinator.
 * Sets up bun:sqlite with optimized settings and runs all migrations.
 *
 * Usage:
 *   const db = new ClaudeMemDatabase();  // uses default DB_PATH
 *   const db = new ClaudeMemDatabase('/path/to/db.sqlite');
 *   const db = new ClaudeMemDatabase(':memory:');  // for tests
 */
export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists (skip for in-memory databases)
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    // Create database connection
    this.db = new Database(dbPath, { create: true, readwrite: true });

    // Repair any malformed schema before applying settings or running migrations.
    // Must happen first — even PRAGMA calls can fail on a corrupted schema.
    // This may close and reopen the connection if repair is needed.
    this.db = repairMalformedSchemaWithReopen(dbPath, this.db);

    // Apply optimized SQLite settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Run all migrations
    const migrationRunner = new MigrationRunner(this.db);
    migrationRunner.runAllMigrations();
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * SQLite Database singleton with migration support and optimized settings
 * @deprecated Use ClaudeMemDatabase instead for new code
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * Register a migration to be run during initialization
   */
  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    // Keep migrations sorted by version
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Initialize database connection with optimized settings
   */
  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    // Ensure the data directory exists
    ensureDir(DATA_DIR);

    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    // Repair any malformed schema before applying settings or running migrations.
    // Must happen first — even PRAGMA calls can fail on a corrupted schema.
    this.db = repairMalformedSchemaWithReopen(DB_PATH, this.db);

    // Apply optimized SQLite settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Initialize schema_versions table
    this.initializeSchemaVersions();

    // Run migrations
    this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  /**
   * Get the current database connection
   */
  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a function within a transaction
   */
  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  /**
   * Initialize the schema_versions table
   */
  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Run all pending migrations
   */
  private runMigrations(): void {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  /**
   * Get current schema version
   */
  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

/**
 * Get the global database instance (for compatibility)
 */
export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

/**
 * Initialize and get database manager
 */
export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

// Re-export bun:sqlite Database type
export { Database };

// Re-export MigrationRunner for external use
export { MigrationRunner } from './migrations/runner.js';

// Re-export all module functions for convenient imports
export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';