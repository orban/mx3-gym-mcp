import { MX3Client } from './mx3-client.js';
import {
  openDatabase,
  insertPollRun,
  finishPollRun,
  insertSnapshots,
  insertChanges,
  getPreviousSnapshots,
  getActiveWatches,
} from './db.js';
import { detectChanges } from './change-detector.js';
import { processNotifications } from './notifier.js';
import type { TimeSlot } from './types.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_BACKOFF_MS = 30 * 60 * 1000;    // 30 minutes
const INITIAL_BACKOFF_MS = 10 * 1000;     // 10 seconds

const username = process.env.MX3_USERNAME;
const password = process.env.MX3_PASSWORD;

if (!username || !password) {
  console.error('MX3_USERNAME and MX3_PASSWORD environment variables are required');
  process.exit(1);
}

const client = new MX3Client({
  baseUrl: 'https://mx3fitness.com',
  locationPath: '/reserve-noe-station',
  credentials: { username, password },
});

const db = openDatabase();

let consecutiveFailures = 0;

async function pollOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  const pollId = insertPollRun(db, startedAt);

  try {
    // 1. Fetch available dates
    const { dates } = await client.getSchedule();
    if (dates.length === 0) {
      finishPollRun(db, pollId, new Date().toISOString(), [], 0, 'No dates available');
      console.error(`[${startedAt}] No dates available`);
      return;
    }

    // 2. Fetch full schedule for each date sequentially
    const allSlots: TimeSlot[] = [];
    for (const date of dates) {
      const { slots } = await client.getSchedule(date);
      allSlots.push(...slots);
    }

    // 3. Single transaction: snapshots + change detection
    const now = new Date().toISOString();
    const allChangeEvents: Array<{
      stationId: number; date: string; time: string;
      fromStatus: string; toStatus: string; detectedAt: string;
    }> = [];

    const txn = db.transaction(() => {
      // Insert all snapshots
      insertSnapshots(db, pollId, allSlots.map(s => ({
        stationId: s.stationId,
        date: s.date,
        time: s.time,
        status: s.status,
        polledAt: now,
      })));

      // Detect changes per date
      const dateSet = new Set(dates);
      for (const date of dateSet) {
        const dateSlots = allSlots.filter(s => s.date === date);
        const prevSnapshots = getPreviousSnapshots(db, date, pollId);
        const changes = detectChanges(dateSlots, prevSnapshots, now);

        if (changes.length > 0) {
          const changeRows = changes.map(c => ({
            stationId: c.stationId,
            date: c.date,
            time: c.time,
            fromStatus: c.fromStatus,
            toStatus: c.toStatus,
            detectedAt: c.detectedAt,
          }));
          insertChanges(db, pollId, changeRows);
          allChangeEvents.push(...changeRows);
        }
      }

      // Finish poll run
      finishPollRun(db, pollId, now, dates, allSlots.length);
    });

    txn();

    // 4. Check watches and fire notifications (outside transaction)
    const watches = getActiveWatches(db);
    const typedChanges = allChangeEvents.map(c => {
      const slot = allSlots.find(s =>
        s.stationId === c.stationId && s.date === c.date && s.time === c.time
      );
      return {
        stationId: c.stationId,
        stationName: slot?.stationName ?? `Station ${c.stationId}`,
        date: c.date,
        time: c.time,
        fromStatus: c.fromStatus as TimeSlot['status'],
        toStatus: c.toStatus as TimeSlot['status'],
        detectedAt: c.detectedAt,
      };
    });

    let notifCount = 0;
    if (watches.length > 0 && typedChanges.length > 0) {
      notifCount = processNotifications(typedChanges, watches);
    }

    // 5. Log summary
    consecutiveFailures = 0;
    console.error(
      `[${now}] Poll #${pollId}: ${dates.length} dates, ${allSlots.length} slots, ` +
      `${allChangeEvents.length} changes, ${notifCount} notifications`
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    finishPollRun(db, pollId, new Date().toISOString(), [], 0, errorMsg);
    consecutiveFailures++;
    console.error(`[${new Date().toISOString()}] Poll #${pollId} FAILED: ${errorMsg}`);
    throw error; // Re-throw for backoff handling
  }
}

function getBackoffMs(): number {
  if (consecutiveFailures === 0) return POLL_INTERVAL_MS;
  const backoff = INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

async function runLoop(): Promise<void> {
  console.error(`[poller] Starting MX3 gym poller (interval: ${POLL_INTERVAL_MS / 1000}s)`);

  while (true) {
    try {
      await pollOnce();
    } catch {
      // Error already logged in pollOnce
    }

    const waitMs = getBackoffMs();
    if (consecutiveFailures > 0) {
      console.error(`[poller] Backing off ${Math.round(waitMs / 1000)}s (${consecutiveFailures} consecutive failures)`);
    }
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

runLoop();
