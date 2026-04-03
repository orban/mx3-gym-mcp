import type Database from 'better-sqlite3';
import { pathToFileURL } from 'url';
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
import { createLogger, type Logger } from './logger.js';
import type { TimeSlot } from './types.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_BACKOFF_MS = 30 * 60 * 1000;    // 30 minutes
const INITIAL_BACKOFF_MS = 10 * 1000;     // 10 seconds

const logger = createLogger('poller');

export interface PollerState {
  consecutiveFailures: number;
}

export interface PollerContext {
  client: Pick<MX3Client, 'getSchedule'>;
  db: Database.Database;
  logger?: Logger;
  now?: () => Date;
  notifier?: typeof processNotifications;
}

export type SleepFn = (waitMs: number) => Promise<void>;

export function calculateBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures === 0) return POLL_INTERVAL_MS;
  const backoff = INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

function nowIso(nowFn: () => Date): string {
  return nowFn().toISOString();
}

export async function runPollOnce(context: PollerContext, state: PollerState): Promise<void> {
  const pollLogger = context.logger ?? logger;
  const notify = context.notifier ?? processNotifications;
  const nowFn = context.now ?? (() => new Date());

  const startedAt = nowIso(nowFn);
  const pollId = insertPollRun(context.db, startedAt);

  pollLogger.info('poller.poll.started', 'Poll run started', {
    pollId,
    startedAt,
    consecutiveFailures: state.consecutiveFailures,
  });

  try {
    const { dates } = await context.client.getSchedule();
    if (dates.length === 0) {
      const finishedAt = nowIso(nowFn);
      finishPollRun(context.db, pollId, finishedAt, [], 0, 'No dates available');
      pollLogger.warn('poller.poll.empty_dates', 'Poll returned no available dates', {
        pollId,
        finishedAt,
      });
      state.consecutiveFailures = 0;
      return;
    }

    const allSlots: TimeSlot[] = [];
    for (const date of dates) {
      const { slots } = await context.client.getSchedule(date);
      allSlots.push(...slots);
    }

    const finishedAt = nowIso(nowFn);
    const allChangeEvents: Array<{
      stationId: number; date: string; time: string;
      fromStatus: string; toStatus: string; detectedAt: string;
    }> = [];

    const txn = context.db.transaction(() => {
      insertSnapshots(context.db, pollId, allSlots.map((slot) => ({
        stationId: slot.stationId,
        date: slot.date,
        time: slot.time,
        status: slot.status,
        polledAt: finishedAt,
      })));

      const dateSet = new Set(dates);
      for (const date of dateSet) {
        const dateSlots = allSlots.filter((slot) => slot.date === date);
        const prevSnapshots = getPreviousSnapshots(context.db, date, pollId);
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
          insertChanges(context.db, pollId, changeRows);
          allChangeEvents.push(...changeRows);
        }
      }

      finishPollRun(context.db, pollId, finishedAt, dates, allSlots.length);
    });

    txn();

    const watches = getActiveWatches(context.db);
    const typedChanges = allChangeEvents.map((change) => {
      const slot = allSlots.find((s) =>
        s.stationId === change.stationId && s.date === change.date && s.time === change.time
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

    let notificationCount = 0;
    if (watches.length > 0 && typedChanges.length > 0) {
      notificationCount = notify(typedChanges, watches, pollLogger);
    }

    state.consecutiveFailures = 0;
    pollLogger.info('poller.poll.completed', 'Poll run completed', {
      pollId,
      datesPolled: dates.length,
      slotCount: allSlots.length,
      changeCount: allChangeEvents.length,
      watchCount: watches.length,
      notificationCount,
      startedAt,
      finishedAt,
    });
  } catch (error) {
    const finishedAt = nowIso(nowFn);
    const errorMsg = error instanceof Error ? error.message : String(error);
    finishPollRun(context.db, pollId, finishedAt, [], 0, errorMsg);

    state.consecutiveFailures += 1;
    pollLogger.error('poller.poll.failed', 'Poll run failed', error, {
      pollId,
      finishedAt,
      consecutiveFailures: state.consecutiveFailures,
    });

    throw error;
  }
}

export async function runLoop(context: PollerContext): Promise<void> {
  const state: PollerState = { consecutiveFailures: 0 };
  while (true) {
    await runLoopIteration(context, state);
  }
}

export async function runLoopIteration(
  context: PollerContext,
  state: PollerState,
  sleep: SleepFn = (waitMs) => new Promise((resolve) => setTimeout(resolve, waitMs)),
): Promise<number> {
  const pollLogger = context.logger ?? logger;

  try {
    await runPollOnce(context, state);
  } catch {
    // Detailed error already logged by runPollOnce.
  }

  const waitMs = calculateBackoffMs(state.consecutiveFailures);
  if (state.consecutiveFailures > 0) {
    pollLogger.warn('poller.loop.backoff', 'Applying failure backoff', {
      consecutiveFailures: state.consecutiveFailures,
      waitMs,
    });
  } else {
    pollLogger.debug('poller.loop.sleep', 'Sleeping until next poll', { waitMs });
  }

  await sleep(waitMs);
  return waitMs;
}

function createRuntimeContext(): PollerContext {
  const username = process.env.MX3_USERNAME;
  const password = process.env.MX3_PASSWORD;

  if (!username || !password) {
    logger.error('poller.config.missing_credentials', 'MX3 credentials are required');
    process.exit(1);
  }

  const client = new MX3Client({
    baseUrl: 'https://mx3fitness.com',
    locationPath: '/reserve-noe-station',
    credentials: { username, password },
  });

  const db = openDatabase();
  return { client, db, logger };
}

export async function startPoller(): Promise<void> {
  const context = createRuntimeContext();
  logger.info('poller.loop.started', 'Polling loop started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
  });
  await runLoop(context);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  startPoller().catch((error) => {
    logger.error('poller.startup.failed', 'Poller failed during startup', error);
    process.exit(1);
  });
}
