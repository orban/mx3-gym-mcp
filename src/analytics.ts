import type Database from 'better-sqlite3';
import { STATIONS } from './types.js';

// --- Types ---

export interface ChangeRecord {
  stationName: string;
  date: string;
  time: string;
  fromStatus: string;
  toStatus: string;
  detectedAt: string;
}

export interface TrendRecord {
  date: string;
  bookings: number;
  cancellations: number;
  netBookings: number;
}

export interface PopularityRecord {
  group: string;
  bookingCount: number;
  cancellationCount: number;
  utilizationPct: number;
}

// --- Helpers ---

const stationIdByName = new Map<string, number>(
  Object.values(STATIONS).map(s => [s.name.toLowerCase(), s.id]),
);

function stationName(id: number): string {
  return STATIONS[id]?.name ?? `Station ${id}`;
}

function resolveStationId(name: string): number | undefined {
  return stationIdByName.get(name.toLowerCase());
}

/** Map day abbreviation ("Mon"…"Sun") to SQLite strftime('%w') value ("0"…"6"). */
const DAY_TO_STRFTIME: Record<string, string> = {
  sun: '0',
  mon: '1',
  tue: '2',
  wed: '3',
  thu: '4',
  fri: '5',
  sat: '6',
};

/** Inverse: strftime('%w') → day name */
const STRFTIME_TO_DAY: Record<string, string> = {
  '0': 'Sun',
  '1': 'Mon',
  '2': 'Tue',
  '3': 'Wed',
  '4': 'Thu',
  '5': 'Fri',
  '6': 'Sat',
};

function stationIdsForType(stationType: string): number[] {
  return Object.values(STATIONS)
    .filter(s => s.type === stationType)
    .map(s => s.id);
}

// --- Public API ---

export function getChanges(
  db: Database.Database,
  opts: {
    station?: string;
    transition?: 'booked' | 'cancelled' | 'all';
    since?: string;
    limit?: number;
  } = {},
): ChangeRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.station) {
    const sid = resolveStationId(opts.station);
    if (sid === undefined) return [];
    clauses.push('station_id = ?');
    params.push(sid);
  }

  if (opts.transition === 'booked') {
    clauses.push("to_status = 'reserved'");
  } else if (opts.transition === 'cancelled') {
    clauses.push("from_status = 'reserved' AND to_status = 'available'");
  }

  if (opts.since) {
    clauses.push('detected_at >= ?');
    params.push(opts.since);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT station_id, date, time, from_status, to_status, detected_at
       FROM changes ${where}
       ORDER BY detected_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    station_id: number;
    date: string;
    time: string;
    from_status: string;
    to_status: string;
    detected_at: string;
  }>;

  return rows.map(r => ({
    stationName: stationName(r.station_id),
    date: r.date,
    time: r.time,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    detectedAt: r.detected_at,
  }));
}

export function getTrends(
  db: Database.Database,
  opts: {
    station?: string;
    dayOfWeek?: string;
    daysBack?: number;
  } = {},
): TrendRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const daysBack = opts.daysBack ?? 7;
  clauses.push("detected_at >= date('now', ?)");
  params.push(`-${daysBack} days`);

  if (opts.station) {
    const sid = resolveStationId(opts.station);
    if (sid === undefined) return [];
    clauses.push('station_id = ?');
    params.push(sid);
  }

  if (opts.dayOfWeek) {
    const dow = DAY_TO_STRFTIME[opts.dayOfWeek.toLowerCase().slice(0, 3)];
    if (dow !== undefined) {
      clauses.push("strftime('%w', date) = ?");
      params.push(dow);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT
         date,
         SUM(CASE WHEN to_status = 'reserved' THEN 1 ELSE 0 END) AS bookings,
         SUM(CASE WHEN from_status = 'reserved' AND to_status = 'available' THEN 1 ELSE 0 END) AS cancellations
       FROM changes
       ${where}
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(...params) as Array<{
    date: string;
    bookings: number;
    cancellations: number;
  }>;

  return rows.map(r => ({
    date: r.date,
    bookings: r.bookings,
    cancellations: r.cancellations,
    netBookings: r.bookings - r.cancellations,
  }));
}

export function getPopularity(
  db: Database.Database,
  opts: {
    groupBy: 'station' | 'time' | 'day_of_week';
    stationType?: string;
    daysBack?: number;
  },
): PopularityRecord[] {
  const daysBack = opts.daysBack ?? 7;

  // Build station filter for stationType
  let stationFilter = '';
  const stationParams: number[] = [];
  if (opts.stationType) {
    const ids = stationIdsForType(opts.stationType);
    if (ids.length === 0) return [];
    stationFilter = `AND station_id IN (${ids.map(() => '?').join(',')})`;
    stationParams.push(...ids);
  }

  // Determine the group expression and label for each groupBy mode
  let groupExpr: string;
  let groupLabel: string;
  if (opts.groupBy === 'station') {
    groupExpr = 'station_id';
    groupLabel = 'station_id';
  } else if (opts.groupBy === 'time') {
    groupExpr = 'time';
    groupLabel = 'time';
  } else {
    // day_of_week
    groupExpr = "strftime('%w', date)";
    groupLabel = 'dow';
  }

  // Utilization from snapshots: use the most recent snapshot per (station, date, time)
  const utilizationRows = db
    .prepare(
      `SELECT ${groupExpr} AS grp,
              SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved_count,
              COUNT(*) AS total_count
       FROM (
         SELECT station_id, date, time, status,
                ROW_NUMBER() OVER (PARTITION BY station_id, date, time ORDER BY poll_id DESC) AS rn
         FROM snapshots
         WHERE polled_at >= date('now', ?)
           ${stationFilter}
       )
       WHERE rn = 1
       GROUP BY grp`,
    )
    .all(
      `-${daysBack} days`,
      ...stationParams,
    ) as Array<{ grp: string | number; reserved_count: number; total_count: number }>;

  // Booking/cancellation counts from changes
  const changeRows = db
    .prepare(
      `SELECT ${groupExpr} AS grp,
              SUM(CASE WHEN to_status = 'reserved' THEN 1 ELSE 0 END) AS booking_count,
              SUM(CASE WHEN from_status = 'reserved' AND to_status = 'available' THEN 1 ELSE 0 END) AS cancel_count
       FROM changes
       WHERE detected_at >= date('now', ?)
         ${stationFilter}
       GROUP BY grp`,
    )
    .all(
      `-${daysBack} days`,
      ...stationParams,
    ) as Array<{ grp: string | number; booking_count: number; cancel_count: number }>;

  // Merge utilization and change data by group key
  const utilMap = new Map(
    utilizationRows.map(r => [
      String(r.grp),
      { reserved: r.reserved_count, total: r.total_count },
    ]),
  );
  const changeMap = new Map(
    changeRows.map(r => [
      String(r.grp),
      { bookings: r.booking_count, cancellations: r.cancel_count },
    ]),
  );

  const allKeys = new Set([...utilMap.keys(), ...changeMap.keys()]);

  const results: PopularityRecord[] = [];
  for (const key of allKeys) {
    const util = utilMap.get(key) ?? { reserved: 0, total: 0 };
    const changes = changeMap.get(key) ?? { bookings: 0, cancellations: 0 };

    let group: string;
    if (opts.groupBy === 'station') {
      group = stationName(Number(key));
    } else if (opts.groupBy === 'day_of_week') {
      group = STRFTIME_TO_DAY[key] ?? key;
    } else {
      group = key;
    }

    results.push({
      group,
      bookingCount: changes.bookings,
      cancellationCount: changes.cancellations,
      utilizationPct:
        util.total > 0
          ? Math.round((util.reserved / util.total) * 10000) / 100
          : 0,
    });
  }

  // Sort by bookingCount descending
  results.sort((a, b) => b.bookingCount - a.bookingCount);
  return results;
}
