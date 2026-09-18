import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS host_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  upload_token_hash TEXT, projector_token_hash TEXT,
  upload_token TEXT, projector_token TEXT,
  expires_at INTEGER NOT NULL,
  source_artifact_id TEXT, selected_run_id TEXT,
  replay INTEGER NOT NULL DEFAULT 0,
  auto_reveal INTEGER NOT NULL DEFAULT 1,
  revealed TEXT NOT NULL DEFAULT '[]',
  current_stage INTEGER NOT NULL DEFAULT 0,
  compare INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, artifact_id TEXT NOT NULL, origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', transformations TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, rel_path TEXT, text TEXT, mime TEXT, byte_size INTEGER, hash TEXT,
  width INTEGER, height INTEGER, duration_sec REAL, producing_attempt_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, snapshot TEXT NOT NULL, source_artifact_id TEXT NOT NULL,
  status TEXT NOT NULL, status_reason TEXT, current_step_index INTEGER NOT NULL DEFAULT 0,
  single_step INTEGER NOT NULL DEFAULT 0, pause_requested INTEGER NOT NULL DEFAULT 0,
  budget_usd REAL, imported INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS step_executions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_index INTEGER NOT NULL, definition_id TEXT NOT NULL,
  predecessor_artifact_id TEXT, status TEXT NOT NULL DEFAULT 'pending', successful_attempt_id TEXT,
  artifact_id TEXT, started_at INTEGER, finished_at INTEGER,
  UNIQUE(run_id, step_index)
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL, status TEXT NOT NULL,
  provider_request_id TEXT, provider_upload_ref TEXT,
  submitted_at INTEGER NOT NULL, finished_at INTEGER,
  error TEXT, error_kind TEXT, usage TEXT, cost_usd REAL, cost_status TEXT NOT NULL DEFAULT 'unknown',
  provider_model TEXT, provider_name TEXT, expanded_prompt TEXT, inference_sec REAL,
  request_snapshot TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_tests (
  model_id TEXT NOT NULL, step_type TEXT NOT NULL, state TEXT NOT NULL, note TEXT, elapsed_ms INTEGER, tested_at INTEGER NOT NULL,
  PRIMARY KEY (model_id, step_type)
);
`;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const now = () => Date.now();

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet<T>(db: DB, key: string): { value: T; updatedAt: number } | null {
  const row = db.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(key) as any;
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
}
export function kvSet(db: DB, key: string, value: unknown) {
  db.prepare(
    'INSERT INTO kv(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
  ).run(key, JSON.stringify(value), now());
}
