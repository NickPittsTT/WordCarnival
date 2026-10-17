/**
 * Database driver abstraction.
 *
 * The app ships with the real expo-sqlite driver, but every data-layer
 * function is written against this tiny interface so unit tests can run the
 * exact same SQL through an in-memory JS stub (no native module needed).
 */

export type SqlValue = string | number | null;

export interface DbResult {
  rows: Record<string, SqlValue>[];
  /** insertId for INSERT statements (0 when not applicable). */
  insertId?: number;
  /** rowsAffected for INSERT/UPDATE/DELETE. */
  changes?: number;
}

export interface DbDriver {
  execAsync(sql: string, params?: SqlValue[]): Promise<void>;
  runAsync(sql: string, params?: SqlValue[]): Promise<DbResult>;
  getAllAsync<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  getFirstAsync<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  closeAsync(): Promise<void>;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_set (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_item (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES content_set(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS child (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT 'star',
  created_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS child_set (
  child_id TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL REFERENCES content_set(id),
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (child_id, set_id)
);
CREATE TABLE IF NOT EXISTS rating (
  child_id TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES content_item(id),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 4),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (child_id, item_id)
);
-- Attempts are APPEND-ONLY: never UPDATE/DELETE rows here (principle 9/10).
CREATE TABLE IF NOT EXISTS attempt (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES child(id),
  item_id TEXT NOT NULL REFERENCES content_item(id),
  game TEXT NOT NULL,
  correct INTEGER NOT NULL,
  first_try INTEGER NOT NULL,
  helped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attempt_child_date ON attempt(child_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempt_item ON attempt(item_id);
CREATE INDEX IF NOT EXISTS idx_attempt_unsynced ON attempt(synced) WHERE synced = 0;
CREATE TABLE IF NOT EXISTS daily_summary (
  child_id TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  date TEXT NOT NULL,          -- YYYY-MM-DD (device local)
  item_id TEXT NOT NULL REFERENCES content_item(id),
  right INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (child_id, date, item_id)
);
CREATE TABLE IF NOT EXISTS reward (
  child_id TEXT PRIMARY KEY REFERENCES child(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL DEFAULT 0,
  stickers_json TEXT NOT NULL DEFAULT '[]'
);
-- Recorded human audio for sound pieces (Phase 4 fills content).
CREATE TABLE IF NOT EXISTS sound_clip (
  id TEXT PRIMARY KEY,
  piece TEXT NOT NULL,         -- grapheme key, e.g. "ai"
  audio_url TEXT,              -- Supabase Storage URL once synced
  local_uri TEXT,              -- on-device cached file
  recorded_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_piece ON sound_clip(piece);
-- Voice templates for the Say It matcher (Phase 5 fills content).
CREATE TABLE IF NOT EXISTS voice_template (
  child_id TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES content_item(id),
  speaker TEXT NOT NULL DEFAULT 'child',
  features BLOB,
  created_at TEXT NOT NULL,
  PRIMARY KEY (child_id, item_id, speaker)
);
`;
