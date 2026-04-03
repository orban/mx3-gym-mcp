import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { MX3Client } from './mx3-client.js';
import {
  openDatabase,
  insertPollRun,
  finishPollRun,
  insertSnapshots,
  insertChanges,
  getPreviousSnapshots,
  getActiveWatches,
  type WatchRow,
} from './db.js';
import { detectChanges } from './change-detector.js';
import { processNotifications } from './notifier.js';
import type { ChangeEvent, TimeSlot } from './types.js';
import { logger } from './logger.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const INITIAL_BACKOFF_MS = 10 * 1000;

export interface PollerDependencies {
  client: Pick<MX3Client, 'getSchedule'>;
  db: Database.Database;
  processNotifications: (events: ChangeEvent[], watches: WatchRow[]) => number;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  logger: typeof logger;
}

export interface PollerRunState {
  consecutiveFailures: number;
}

export function getBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures === 0) return POLL_INTERVAL_MS;
  const backoff = INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

function buildDefaultDependencies(): PollerDependencies {
  const username = process.env.MX3_USERNAME;
  const password = process.env.MX3_PASSWORD;

  if (!username || !password) {
    logger.error('MX3 poller startup failed due to missing credentials', {
      event: 'poller.startup.missing_credentials',
    });
    process.exit(1);
  }

  return {
    client: new MX3Client({
      baseUrl: 'https://mx3fitness.com',
      locationPath: '/reserve-noe-station',
      credentials: { username, password },
    }),
    db: openDatabase(),
    processNotifications,
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger,
  };
}

function buildChangeEvents(allChangeEvents: Array<{
  stationId: number;
  date: string;
  time: string;
  fromStatus: string;
  toStatus: string;
  detectedAt: string;
}>, allSlots: TimeSlot[]): ChangeEvent[] {
  return allChangeEvents.map((change) => {
    const slot = allSlots.find((candidate) =>
      candidate.stationId === change.stationId &&
      candidate.date === change.date &&
      candidate.time === change.time
    );

    return {
      stationId: change.stationId,
      stationName: slot?.stationName ?? `Station ${change.stationId}`,
      date: change.date,
      time: change.time,
      fromStatus: change.fromStatus as TimeSlot['status'],
      toStatus: change.toStatus as TimeSlot['status'],
      detectedAt: change.detectedAt,
    };
  });
}

export async function runPollOnce(
  dependencies: PollerDependencies,
  state: PollerRunState,
): Promise<void> {
  const startedAt = dependencies.now();
  const pollId = insertPollRun(dependencies.db, startedAt);
  dependencies.logger.info('Starting poll run', {
    event: 'poller.run.start',
    pollId,
    consecutiveFailures: state.consecutiveFailures,
    startedAt,
  });

  try {
    const { dates } = await dependencies.client.getSchedule();
    if (dates.length === 0) {
      finishPollRun(dependencies.db, pollId, dependencies.now(), [], 0, 'No dates available');
      state.consecutiveFailures += 1;
      dependencies.logger.warn('Poll returned no schedule dates', {
        event: 'poller.run.no_dates',
        pollId,
        consecutiveFailures: state.consecutiveFailures,
      });
      return;
    }

    const allSlots: TimeSlot[] = [];
    for (const date of dates) {
      const { slots } = await dependencies.client.getSchedule(date);
      allSlots.push(...slots);
    }

    const finishedAt = dependencies.now();
    const allChangeEvents: Array<{
      stationId: number;
      date: string;
      time: string;
      fromStatus: string;
      toStatus: string;
      detectedAt: string;
    }> = [];

    dependencies.db.transaction(() => {
      insertSnapshots(dependencies.db, pollId, allSlots.map((slot) => ({
        stationId: slot.stationId,
        date: slot.date,
        time: slot.time,
        status: slot.status,
        polledAt: finishedAt,
      })));

      for (const date of new Set(dates)) {
        const dateSlots = allSlots.filter((slot) => slot.date === date);
        const prevSnapshots = getPreviousSnapshots(dependencies.db, date, pollId);
        const changes = detectChanges(dateSlots, prevSnapshots, finishedAt);

        if (changes.length > 0) {
          const changeRows = changes.map((change) => ({
            stationId: change.stationId,
            date: change.date,
            time: change.time,
            fromStatus: change.fromStatus,
            toStatus: change.toStatus,
            detectedAt: change.detectedAt,
          }));
          insertChanges(dependencies.db, pollId, changeRows);
          allChangeEvents.push(...changeRows);
        }
      }

      finishPollRun(dependencies.db, pollId, finishedAt, dates, allSlots.length);
    })();

    state.consecutiveFailures = 0;

    const watches = getActiveWatches(dependencies.db);
    const typedChanges = buildChangeEvents(allChangeEvents, allSlots);

    dependencies.logger.info('Poll run persisted successfully', {
      event: 'poller.run.persisted',
      pollId,
      datesPolled: dates,
      dateCount: dates.length,
      slotCount: allSlots.length,
      changeCount: typedChanges.length,
      watchCount: watches.length,
    });

    let notificationCount = 0;
    if (watches.length > 0 && typedChanges.length > 0) {
      try {
        notificationCount = dependencies.processNotifications(typedChanges, watches);
      } catch (error) {
        dependencies.logger.error('Poll notifications failed after poll succeeded', {
          event: 'poller.notifications.failed',
          pollId,
          changeCount: typedChanges.length,
          watchCount: watches.length,
          error,
        });
      }
    }

    dependencies.logger.info('Poll run completed', {
      event: 'poller.run.complete',
      pollId,
      dateCount: dates.length,
      slotCount: allSlots.length,
      changeCount: typedChanges.length,
      notificationCount,
      consecutiveFailures: state.consecutiveFailures,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    finishPollRun(dependencies.db, pollId, dependencies.now(), [], 0, errorMessage);
    state.consecutiveFailures += 1;
    dependencies.logger.error('Poll run failed', {
      event: 'poller.run.failed',
      pollId,
      consecutiveFailures: state.consecutiveFailures,
      error,
    });
    throw error;
  }
}

export async function runPollLoop(
  dependencies: PollerDependencies = buildDefaultDependencies(),
  state: PollerRunState = { consecutiveFailures: 0 },
): Promise<void> {
  dependencies.logger.info('Starting MX3 poller loop', {
    event: 'poller.loop.start',
    pollIntervalMs: POLL_INTERVAL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
  });

  while (true) {
    try {
      await runPollOnce(dependencies, state);
    } catch {
      // Failure already logged in runPollOnce.
    }

    const waitMs = getBackoffMs(state.consecutiveFailures);
    dependencies.logger.info('Scheduling next poll run', {
      event: 'poller.loop.sleep',
      waitMs,
      consecutiveFailures: state.consecutiveFailures,
    });
    await dependencies.sleep(waitMs);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPollLoop().catch((error) => {
    logger.error('Poller loop terminated unexpectedly', {
      event: 'poller.loop.crash',
      error,
    });
    process.exit(1);
  });
}
