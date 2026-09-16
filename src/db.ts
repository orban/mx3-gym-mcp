import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '..', 'data', 'mx3.db');

export interface PollRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  dates_polled: string; // JSON array
  slot_count: number;
  error: string | null;
}

export interface SnapshotRow {
  id: number;
  poll_id: number;
  station_id: number;
  date: string;
  time: string;
  status: string;
  polled_at: string;
}

export interface ChangeRow {
  id: number;
  poll_id: number;
  station_id: number;
  date: string;
  time: string;
  from_status: string;
  to_status: string;
  detected_at: string;
}

export interface WatchRow {
  id: number;
  station_pattern: string;
  time_from: string | null;
  time_to: string | null;
  days_of_week: string | null; // JSON array e.g. '["Mon","Tue"]'
  active: number; // 0 or 1
  created_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS poll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    dates_polled TEXT NOT NULL DEFAULT '[]',
    slot_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL REFERENCES poll_runs(id),
    station_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT NOT NULL,
    polled_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
    ON snapshots (station_id, date, time, poll_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_poll
    ON snapshots (poll_id);

  CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL REFERENCES poll_runs(id),
    station_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    detected_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_changes_detected
    ON changes (detected_at);
  CREATE INDEX IF NOT EXISTS idx_changes_lookup
    ON changes (station_id, date, time);

  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_pattern TEXT NOT NULL DEFAULT '*',
    time_from TEXT,
    time_to TEXT,
    days_of_week TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
`;

export function openDatabase(dbPath?: string): Database.Database {
  const path = dbPath ?? DEFAULT_DB_PATH;

  // Ensure data directory exists (unless using :memory:)
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  return db;
}

// --- Typed helpers ---

export function insertPollRun(db: Database.Database, startedAt: string): number {
  const stmt = db.prepare('INSERT INTO poll_runs (started_at) VALUES (?)');
  const result = stmt.run(startedAt);
  return result.lastInsertRowid as number;
}

export function finishPollRun(
  db: Database.Database,
  pollId: number,
  finishedAt: string,
  datesList: string[],
  slotCount: number,
  error: string | null = null,
): void {
  db.prepare(
    'UPDATE poll_runs SET finished_at = ?, dates_polled = ?, slot_count = ?, error = ? WHERE id = ?'
  ).run(finishedAt, JSON.stringify(datesList), slotCount, error, pollId);
}

export function insertSnapshots(
  db: Database.Database,
  pollId: number,
  rows: Array<{ stationId: number; date: string; time: string; status: string; polledAt: string }>,
): void {
  const stmt = db.prepare(
    'INSERT INTO snapshots (poll_id, station_id, date, time, status, polled_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    stmt.run(pollId, r.stationId, r.date, r.time, r.status, r.polledAt);
  }
}

export function insertChanges(
  db: Database.Database,
  pollId: number,
  events: Array<{ stationId: number; date: string; time: string; fromStatus: string; toStatus: string; detectedAt: string }>,
): void {
  const stmt = db.prepare(
    'INSERT INTO changes (poll_id, station_id, date, time, from_status, to_status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const e of events) {
    stmt.run(pollId, e.stationId, e.date, e.time, e.fromStatus, e.toStatus, e.detectedAt);
  }
}

export function getPreviousSnapshots(
  db: Database.Database,
  date: string,
  beforePollId: number,
): SnapshotRow[] {
  // Find the most recent poll that captured this date, before the current poll
  const prevPoll = db.prepare(`
    SELECT MAX(poll_id) as poll_id FROM snapshots
    WHERE date = ? AND poll_id < ?
  `).get(date, beforePollId) as { poll_id: number | null } | undefined;

  if (!prevPoll?.poll_id) return [];

  return db.prepare(
    'SELECT * FROM snapshots WHERE poll_id = ? AND date = ?'
  ).all(prevPoll.poll_id, date) as SnapshotRow[];
}

export function getActiveWatches(db: Database.Database): WatchRow[] {
  return db.prepare('SELECT * FROM watches WHERE active = 1').all() as WatchRow[];
}

export function addWatch(
  db: Database.Database,
  watch: { stationPattern: string; timeFrom?: string; timeTo?: string; daysOfWeek?: string[]; },
): number {
  const stmt = db.prepare(
    'INSERT INTO watches (station_pattern, time_from, time_to, days_of_week, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(
    watch.stationPattern,
    watch.timeFrom ?? null,
    watch.timeTo ?? null,
    watch.daysOfWeek ? JSON.stringify(watch.daysOfWeek) : null,
    new Date().toISOString(),
  );
  return result.lastInsertRowid as number;
}

export function removeWatch(db: Database.Database, watchId: number): boolean {
  const result = db.prepare('UPDATE watches SET active = 0 WHERE id = ? AND active = 1').run(watchId);
  return result.changes > 0;
}

export function listWatches(db: Database.Database): WatchRow[] {
  return db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as WatchRow[];
}
