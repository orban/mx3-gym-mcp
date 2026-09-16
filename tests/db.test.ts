import { describe, it, expect } from 'vitest';
import {
  openDatabase,
  insertPollRun,
  finishPollRun,
  insertSnapshots,
  insertChanges,
  getPreviousSnapshots,
  getActiveWatches,
  addWatch,
  removeWatch,
  listWatches,
} from '../src/db.js';

describe('db', () => {
  function createDb() {
    return openDatabase(':memory:');
  }

  describe('schema creation', () => {
    it('creates all tables', () => {
      const db = createDb();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const names = tables.map(t => t.name);
      expect(names).toContain('poll_runs');
      expect(names).toContain('snapshots');
      expect(names).toContain('changes');
      expect(names).toContain('watches');
    });

    it('sets WAL mode (skipped for :memory: dbs)', () => {
      // WAL mode can't be set on :memory: databases — SQLite silently ignores it.
      // Verify the pragma call doesn't throw; real WAL is tested via file-based DBs.
      const db = createDb();
      const result = db.pragma('journal_mode') as { journal_mode: string }[];
      // :memory: always reports 'memory' — just verify it didn't error
      expect(result[0].journal_mode).toBe('memory');
    });
  });

  describe('poll_runs', () => {
    it('inserts and finishes a poll run', () => {
      const db = createDb();
      const id = insertPollRun(db, '2025-01-01T00:00:00Z');
      expect(id).toBe(1);

      finishPollRun(db, id, '2025-01-01T00:01:00Z', ['2025-01-01', '2025-01-02'], 100);

      const row = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(id) as any;
      expect(row.finished_at).toBe('2025-01-01T00:01:00Z');
      expect(JSON.parse(row.dates_polled)).toEqual(['2025-01-01', '2025-01-02']);
      expect(row.slot_count).toBe(100);
      expect(row.error).toBeNull();
    });

    it('records errors', () => {
      const db = createDb();
      const id = insertPollRun(db, '2025-01-01T00:00:00Z');
      finishPollRun(db, id, '2025-01-01T00:01:00Z', [], 0, 'Network timeout');

      const row = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(id) as any;
      expect(row.error).toBe('Network timeout');
    });
  });

  describe('snapshots', () => {
    it('inserts and retrieves snapshots', () => {
      const db = createDb();
      const pollId = insertPollRun(db, '2025-01-01T00:00:00Z');
      insertSnapshots(db, pollId, [
        { stationId: 140, date: '2025-01-01', time: '9:00am', status: 'available', polledAt: '2025-01-01T00:00:00Z' },
        { stationId: 141, date: '2025-01-01', time: '9:00am', status: 'reserved', polledAt: '2025-01-01T00:00:00Z' },
      ]);

      const rows = db.prepare('SELECT * FROM snapshots WHERE poll_id = ?').all(pollId);
      expect(rows).toHaveLength(2);
    });
  });

  describe('getPreviousSnapshots', () => {
    it('returns snapshots from the most recent previous poll for same date', () => {
      const db = createDb();
      const poll1 = insertPollRun(db, '2025-01-01T00:00:00Z');
      insertSnapshots(db, poll1, [
        { stationId: 140, date: '2025-01-01', time: '9:00am', status: 'available', polledAt: '2025-01-01T00:00:00Z' },
      ]);

      const poll2 = insertPollRun(db, '2025-01-01T00:05:00Z');
      insertSnapshots(db, poll2, [
        { stationId: 140, date: '2025-01-01', time: '9:00am', status: 'reserved', polledAt: '2025-01-01T00:05:00Z' },
      ]);

      const poll3 = insertPollRun(db, '2025-01-01T00:10:00Z');

      // Should get poll2's data (most recent before poll3)
      const prev = getPreviousSnapshots(db, '2025-01-01', poll3);
      expect(prev).toHaveLength(1);
      expect(prev[0].status).toBe('reserved');
      expect(prev[0].poll_id).toBe(poll2);
    });

    it('returns empty for first poll of a date', () => {
      const db = createDb();
      const pollId = insertPollRun(db, '2025-01-01T00:00:00Z');
      const prev = getPreviousSnapshots(db, '2025-01-01', pollId);
      expect(prev).toHaveLength(0);
    });
  });

  describe('changes', () => {
    it('inserts change events', () => {
      const db = createDb();
      const pollId = insertPollRun(db, '2025-01-01T00:00:00Z');
      insertChanges(db, pollId, [
        { stationId: 140, date: '2025-01-01', time: '9:00am', fromStatus: 'available', toStatus: 'reserved', detectedAt: '2025-01-01T00:00:00Z' },
      ]);

      const rows = db.prepare('SELECT * FROM changes').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].from_status).toBe('available');
      expect(rows[0].to_status).toBe('reserved');
    });
  });

  describe('watches', () => {
    it('adds and lists watches', () => {
      const db = createDb();
      const id = addWatch(db, { stationPattern: 'Noe *', timeFrom: '5:00pm', timeTo: '8:00pm', daysOfWeek: ['Mon', 'Wed'] });
      expect(id).toBe(1);

      const watches = listWatches(db);
      expect(watches).toHaveLength(1);
      expect(watches[0].station_pattern).toBe('Noe *');
      expect(watches[0].time_from).toBe('5:00pm');
      expect(JSON.parse(watches[0].days_of_week!)).toEqual(['Mon', 'Wed']);
    });

    it('deactivates a watch', () => {
      const db = createDb();
      const id = addWatch(db, { stationPattern: '*' });
      expect(removeWatch(db, id)).toBe(true);

      const active = getActiveWatches(db);
      expect(active).toHaveLength(0);

      // Can't remove again
      expect(removeWatch(db, id)).toBe(false);
    });

    it('getActiveWatches only returns active watches', () => {
      const db = createDb();
      addWatch(db, { stationPattern: 'Noe 1' });
      const id2 = addWatch(db, { stationPattern: 'Noe 2' });
      addWatch(db, { stationPattern: 'Noe 3' });
      removeWatch(db, id2);

      const active = getActiveWatches(db);
      expect(active).toHaveLength(2);
      expect(active.map(w => w.station_pattern)).toEqual(expect.arrayContaining(['Noe 1', 'Noe 3']));
    });
  });
});
