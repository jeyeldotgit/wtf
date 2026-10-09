import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      investigation_id TEXT,
      command_display TEXT NOT NULL,
      cwd TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      exit_code INTEGER,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      stdout_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stdout_bytes >= 0),
      stderr_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stderr_bytes >= 0),
      UNIQUE (project_id, id),
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      trigger_run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('investigating', 'awaiting_user', 'resolved', 'dismissed', 'failed')),
      diagnosis TEXT,
      model_version TEXT,
      prompt_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, id),
      FOREIGN KEY (trigger_run_id, project_id) REFERENCES runs(id, project_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE IF NOT EXISTS log_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS investigation_evidence (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK (source_type IN ('run_log', 'historical_log', 'project_file', 'tool_result')),
      source_id TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      relative_path TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (investigation_id, id),
      CHECK ((source_type = 'project_file' AND relative_path IS NOT NULL) OR (source_type <> 'project_file' AND relative_path IS NULL))
    );

    CREATE TABLE IF NOT EXISTS investigation_tool_calls (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      round INTEGER NOT NULL CHECK (round >= 0),
      tool_name TEXT NOT NULL CHECK (tool_name IN ('getRecentLogs', 'searchLogs', 'getProjectContext', 'invalid')),
      request_hash TEXT NOT NULL,
      outcome_status TEXT NOT NULL CHECK (outcome_status IN ('ok', 'empty', 'limited', 'unavailable', 'error')),
      safe_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (investigation_id, request_hash)
    );

    CREATE TABLE IF NOT EXISTS fix_proposals (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      summary TEXT NOT NULL DEFAULT '',
      files_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'applied', 'stale')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_proposals (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_project_start ON runs(project_id, start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id, id);
    CREATE INDEX IF NOT EXISTS idx_log_events_run_sequence ON log_events(run_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_investigations_project_updated ON investigations(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON investigation_evidence(investigation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_investigation_round ON investigation_tool_calls(investigation_id, round);

    CREATE TRIGGER IF NOT EXISTS investigations_updated_at
    AFTER UPDATE OF status, diagnosis, model_version, prompt_version ON investigations
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE investigations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS runs_investigation_project_insert
    BEFORE INSERT ON runs
    FOR EACH ROW
    WHEN NEW.investigation_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM investigations i WHERE i.id = NEW.investigation_id AND i.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'run investigation project mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS runs_investigation_project_update
    BEFORE UPDATE OF investigation_id, project_id ON runs
    FOR EACH ROW
    WHEN NEW.investigation_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM investigations i WHERE i.id = NEW.investigation_id AND i.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'run investigation project mismatch');
    END;
  `,
};

export function migrateDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error(`Database schema ${row.user_version} is newer than supported schema ${SCHEMA_VERSION}`);
  }
  for (let version = row.user_version + 1; version <= SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS[version];
    if (!migration) throw new Error(`Missing database migration ${version}`);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration);
      database.exec(`PRAGMA user_version = ${version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
