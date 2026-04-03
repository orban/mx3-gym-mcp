import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../src/db.js';
import { getChanges, getTrends, getPopularity } from '../src/analytics.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
const FIXED_TODAY = '2026-02-10';

function today(): string {
  return FIXED_TODAY;
}

function daysAgo(n: number): string {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function seedData(db: Database.Database) {
  const date1 = daysAgo(1); // yesterday
  const date2 = today();

  // Insert 2 poll runs
  db.prepare("INSERT INTO poll_runs (id, started_at, finished_at, dates_polled, slot_count) VALUES (?, ?, ?, ?, ?)")
    .run(1, `${date1}T06:00:00Z`, `${date1}T06:01:00Z`, JSON.stringify([date1]), 10);
  db.prepare("INSERT INTO poll_runs (id, started_at, finished_at, dates_polled, slot_count) VALUES (?, ?, ?, ?, ?)")
    .run(2, `${date2}T06:00:00Z`, `${date2}T06:01:00Z`, JSON.stringify([date2]), 10);

  // Snapshots for Noe 1 (140) and Open Gym 1 (144) across both dates
  // poll 1: date1 snapshots
  const snapshots1 = [
    // Noe 1, date1
    { poll_id: 1, station_id: 140, date: date1, time: '5:00am', status: 'available', polled_at: `${date1}T06:00:00Z` },
    { poll_id: 1, station_id: 140, date: date1, time: '6:00am', status: 'reserved', polled_at: `${date1}T06:00:00Z` },
    { poll_id: 1, station_id: 140, date: date1, time: '7:00am', status: 'available', polled_at: `${date1}T06:00:00Z` },
    // Open Gym 1, date1
    { poll_id: 1, station_id: 144, date: date1, time: '5:00am', status: 'reserved', polled_at: `${date1}T06:00:00Z` },
    { poll_id: 1, station_id: 144, date: date1, time: '6:00am', status: 'available', polled_at: `${date1}T06:00:00Z` },
  ];

  // poll 2: date2 snapshots
  const snapshots2 = [
    // Noe 1, date2
    { poll_id: 2, station_id: 140, date: date2, time: '5:00am', status: 'reserved', polled_at: `${date2}T06:00:00Z` },
    { poll_id: 2, station_id: 140, date: date2, time: '6:00am', status: 'available', polled_at: `${date2}T06:00:00Z` },
    { poll_id: 2, station_id: 140, date: date2, time: '7:00am', status: 'reserved', polled_at: `${date2}T06:00:00Z` },
    // Open Gym 1, date2
    { poll_id: 2, station_id: 144, date: date2, time: '5:00am', status: 'available', polled_at: `${date2}T06:00:00Z` },
    { poll_id: 2, station_id: 144, date: date2, time: '6:00am', status: 'reserved', polled_at: `${date2}T06:00:00Z` },
  ];

  const insertSnap = db.prepare(
    'INSERT INTO snapshots (poll_id, station_id, date, time, status, polled_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const s of [...snapshots1, ...snapshots2]) {
    insertSnap.run(s.poll_id, s.station_id, s.date, s.time, s.status, s.polled_at);
  }

  // Changes: bookings and cancellations
  const changes = [
    // date1: Noe 1 6:00am was booked
    { poll_id: 1, station_id: 140, date: date1, time: '6:00am', from_status: 'available', to_status: 'reserved', detected_at: `${date1}T06:00:00Z` },
    // date1: Open Gym 1 5:00am was booked
    { poll_id: 1, station_id: 144, date: date1, time: '5:00am', from_status: 'available', to_status: 'reserved', detected_at: `${date1}T06:00:30Z` },
    // date2: Noe 1 5:00am was booked
    { poll_id: 2, station_id: 140, date: date2, time: '5:00am', from_status: 'available', to_status: 'reserved', detected_at: `${date2}T06:00:00Z` },
    // date2: Noe 1 6:00am was cancelled
    { poll_id: 2, station_id: 140, date: date2, time: '6:00am', from_status: 'reserved', to_status: 'available', detected_at: `${date2}T06:00:00Z` },
    // date2: Noe 1 7:00am was booked
    { poll_id: 2, station_id: 140, date: date2, time: '7:00am', from_status: 'available', to_status: 'reserved', detected_at: `${date2}T06:00:30Z` },
    // date2: Open Gym 1 5:00am was cancelled
    { poll_id: 2, station_id: 144, date: date2, time: '5:00am', from_status: 'reserved', to_status: 'available', detected_at: `${date2}T06:01:00Z` },
    // date2: Open Gym 1 6:00am was booked
    { poll_id: 2, station_id: 144, date: date2, time: '6:00am', from_status: 'available', to_status: 'reserved', detected_at: `${date2}T06:01:00Z` },
  ];

  const insertChange = db.prepare(
    'INSERT INTO changes (poll_id, station_id, date, time, from_status, to_status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const c of changes) {
    insertChange.run(c.poll_id, c.station_id, c.date, c.time, c.from_status, c.to_status, c.detected_at);
  }
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedData(db);
});

// --- getChanges ---

describe('getChanges', () => {
  it('returns all changes, most recent first', () => {
    const results = getChanges(db);
    expect(results.length).toBe(7);
    // Most recent detected_at should be first
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].detectedAt >= results[i].detectedAt).toBe(true);
    }
  });

  it('filters by station name', () => {
    const results = getChanges(db, { station: 'Noe 1' });
    expect(results.every(r => r.stationName === 'Noe 1')).toBe(true);
    expect(results.length).toBe(4); // 3 bookings + 1 cancellation for Noe 1
  });

  it('filters by transition type (booked)', () => {
    const results = getChanges(db, { transition: 'booked' });
    expect(results.every(r => r.toStatus === 'reserved')).toBe(true);
    // 5 bookings total: Noe 1 x3, Open Gym 1 x2
    expect(results.length).toBe(5);
  });

  it('filters by transition type (cancelled)', () => {
    const results = getChanges(db, { transition: 'cancelled' });
    expect(results.every(r => r.fromStatus === 'reserved' && r.toStatus === 'available')).toBe(true);
    // 2 cancellations: Noe 1 6:00am date2, Open Gym 1 5:00am date2
    expect(results.length).toBe(2);
  });

  it('respects limit', () => {
    const results = getChanges(db, { limit: 3 });
    expect(results.length).toBe(3);
  });

  it('returns station name for unknown station name filter', () => {
    const results = getChanges(db, { station: 'Nonexistent' });
    expect(results.length).toBe(0);
  });
});

// --- getTrends ---

describe('getTrends', () => {
  it('returns daily booking/cancellation counts', () => {
    const results = getTrends(db, { now: FIXED_TODAY });
    expect(results.length).toBe(2);

    // date1 (daysAgo(1)): 2 bookings, 0 cancellations
    const day1 = results.find(r => r.date === daysAgo(1));
    expect(day1).toBeDefined();
    expect(day1!.bookings).toBe(2);
    expect(day1!.cancellations).toBe(0);
    expect(day1!.netBookings).toBe(2);

    // date2 (today): 3 bookings (Noe 1 5am, Noe 1 7am, Open Gym 1 6am), 2 cancellations
    const day2 = results.find(r => r.date === today());
    expect(day2).toBeDefined();
    expect(day2!.bookings).toBe(3);
    expect(day2!.cancellations).toBe(2);
    expect(day2!.netBookings).toBe(1);
  });

  it('filters by daysBack', () => {
    const results = getTrends(db, { daysBack: 0, now: FIXED_TODAY });
    // Only today's changes should appear
    expect(results.every(r => r.date >= today())).toBe(true);
  });

  it('filters by station', () => {
    const results = getTrends(db, { station: 'Open Gym 1', now: FIXED_TODAY });
    // date1: 1 booking; date2: 1 booking, 1 cancellation
    expect(results.length).toBe(2);

    const day1 = results.find(r => r.date === daysAgo(1));
    expect(day1!.bookings).toBe(1);
    expect(day1!.cancellations).toBe(0);

    const day2 = results.find(r => r.date === today());
    expect(day2!.bookings).toBe(1);
    expect(day2!.cancellations).toBe(1);
  });
});

// --- getPopularity ---

describe('getPopularity', () => {
  it('groups by station with correct counts', () => {
    const results = getPopularity(db, { groupBy: 'station', now: FIXED_TODAY });
    expect(results.length).toBeGreaterThanOrEqual(2);

    const noe1 = results.find(r => r.group === 'Noe 1');
    expect(noe1).toBeDefined();
    expect(noe1!.bookingCount).toBe(3); // 3 booking events for Noe 1
    expect(noe1!.cancellationCount).toBe(1);
    expect(noe1!.utilizationPct).toBeGreaterThan(0);

    const og1 = results.find(r => r.group === 'Open Gym 1');
    expect(og1).toBeDefined();
    expect(og1!.bookingCount).toBe(2);
    expect(og1!.cancellationCount).toBe(1);
  });

  it('groups by time', () => {
    const results = getPopularity(db, { groupBy: 'time', now: FIXED_TODAY });
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Every result should have a time-like group value
    for (const r of results) {
      expect(r.group).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);
    }

    // 5:00am: 2 bookings (Noe1 date2, OG1 date1), 1 cancellation (OG1 date2)
    const fiveAm = results.find(r => r.group === '5:00am');
    expect(fiveAm).toBeDefined();
    expect(fiveAm!.bookingCount).toBe(2);
    expect(fiveAm!.cancellationCount).toBe(1);
  });

  it('groups by day_of_week', () => {
    const results = getPopularity(db, { groupBy: 'day_of_week', now: FIXED_TODAY });
    expect(results.length).toBeGreaterThanOrEqual(1);

    // All groups should be day names
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const r of results) {
      expect(dayNames).toContain(r.group);
    }
  });

  it('filters by stationType', () => {
    const results = getPopularity(db, { groupBy: 'station', stationType: 'open_gym', now: FIXED_TODAY });
    // Should only contain Open Gym stations
    for (const r of results) {
      expect(r.group).toMatch(/^Open Gym/);
    }
    expect(results.length).toBe(1); // Only Open Gym 1 has data
  });

  it('returns sorted by bookingCount descending', () => {
    const results = getPopularity(db, { groupBy: 'station', now: FIXED_TODAY });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].bookingCount).toBeGreaterThanOrEqual(results[i].bookingCount);
    }
  });
});
