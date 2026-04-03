import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createLogger, type LogEntry } from '../src/logger.js';
import { runPollOnce, runLoopIteration, type PollerState } from '../src/poller.js';
import type { TimeSlot } from '../src/types.js';

function makeSlot(overrides: Partial<TimeSlot> = {}): TimeSlot {
  return {
    stationId: 140,
    stationName: 'Noe 1',
    stationType: 'private_station',
    date: '2025-03-03',
    time: '5:00pm',
    status: 'available',
    ...overrides,
  };
}

describe('poller logging', () => {
  it('logs completion with poll summary fields and resets failures', async () => {
    const db = openDatabase(':memory:');
    const entries: LogEntry[] = [];
    const logger = createLogger('test-poller', {
      level: 'debug',
      writer: (entry) => entries.push(entry),
    });

    let callCount = 0;
    const client = {
      async getSchedule(date?: string) {
        callCount += 1;
        if (callCount === 1) {
          return { dates: ['2025-03-03'], slots: [] };
        }
        return { dates: ['2025-03-03'], slots: [makeSlot({ date })] };
      },
    };

    const state: PollerState = { consecutiveFailures: 2 };

    await runPollOnce({ client, db, logger }, state);

    expect(state.consecutiveFailures).toBe(0);

    const completed = entries.find((entry) => entry.event === 'poller.poll.completed');
    expect(completed?.level).toBe('info');
    expect(completed?.context?.pollId).toBeTypeOf('number');
    expect(completed?.context?.slotCount).toBe(1);
    expect(completed?.context?.datesPolled).toBe(1);
  });

  it('logs poll failures with error metadata and increments failure count', async () => {
    const db = openDatabase(':memory:');
    const entries: LogEntry[] = [];
    const logger = createLogger('test-poller', {
      level: 'debug',
      writer: (entry) => entries.push(entry),
    });

    const client = {
      async getSchedule() {
        throw new Error('upstream timeout');
      },
    };

    const state: PollerState = { consecutiveFailures: 0 };

    await expect(runPollOnce({ client, db, logger }, state)).rejects.toThrow('upstream timeout');

    expect(state.consecutiveFailures).toBe(1);

    const failed = entries.find((entry) => entry.event === 'poller.poll.failed');
    expect(failed?.level).toBe('error');
    expect(failed?.context?.consecutiveFailures).toBe(1);
    expect(failed?.error?.message).toContain('upstream timeout');
  });

  it('logs loop backoff after failures', async () => {
    const db = openDatabase(':memory:');
    const entries: LogEntry[] = [];
    const logger = createLogger('test-poller', {
      level: 'debug',
      writer: (entry) => entries.push(entry),
    });

    const client = {
      async getSchedule() {
        throw new Error('network unreachable');
      },
    };

    const state: PollerState = { consecutiveFailures: 0 };
    let sleptMs = -1;

    const waitMs = await runLoopIteration(
      { client, db, logger },
      state,
      async (ms: number) => {
        sleptMs = ms;
      },
    );

    expect(waitMs).toBe(10_000);
    expect(sleptMs).toBe(10_000);

    const backoff = entries.find((entry) => entry.event === 'poller.loop.backoff');
    expect(backoff?.level).toBe('warn');
    expect(backoff?.context?.consecutiveFailures).toBe(1);
    expect(backoff?.context?.waitMs).toBe(10_000);
  });
});
