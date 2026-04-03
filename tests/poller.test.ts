import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { getBackoffMs, runPollOnce, type PollerDependencies, type PollerRunState } from '../src/poller.js';
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

function makeDependencies(overrides: Partial<PollerDependencies> = {}): PollerDependencies {
  const db = overrides.db ?? openDatabase(':memory:');
  const lines: Array<Record<string, unknown>> = [];

  return {
    client: overrides.client ?? {
      async getSchedule(date?: string) {
        if (!date) return { dates: ['2025-03-03'], slots: [] };
        return { dates: ['2025-03-03'], slots: [makeSlot()] };
      },
    },
    db,
    processNotifications: overrides.processNotifications ?? vi.fn(() => 0),
    now: overrides.now ?? (() => '2025-03-03T17:00:00.000Z'),
    sleep: overrides.sleep ?? vi.fn(async () => {}),
    logger: overrides.logger ?? createLogger((_level, line) => {
      lines.push(JSON.parse(line));
    }),
  };
}

describe('runPollOnce', () => {
  it('keeps a successful poll successful when notifications fail', async () => {
    const db = openDatabase(':memory:');
    const processNotifications = vi.fn(() => {
      throw new Error('osascript failed');
    });
    const deps = makeDependencies({
      db,
      processNotifications,
      client: {
        async getSchedule(date?: string) {
          if (!date) return { dates: ['2025-03-03'], slots: [] };
          return {
            dates: ['2025-03-03'],
            slots: [makeSlot({ status: 'available' })],
          };
        },
      },
    });

    const previousPollId = 1;
    db.prepare('INSERT INTO poll_runs (id, started_at, finished_at, dates_polled, slot_count, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(previousPollId, '2025-03-03T16:55:00.000Z', '2025-03-03T16:55:05.000Z', '["2025-03-03"]', 1, null);
    db.prepare('INSERT INTO snapshots (poll_id, station_id, date, time, status, polled_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(previousPollId, 140, '2025-03-03', '5:00pm', 'reserved', '2025-03-03T16:55:05.000Z');
    db.prepare('INSERT INTO watches (station_pattern, time_from, time_to, days_of_week, active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('*', null, null, null, 1, '2025-03-03T16:50:00.000Z');

    const state: PollerRunState = { consecutiveFailures: 2 };
    await runPollOnce(deps, state);

    const pollRun = db.prepare('SELECT slot_count, error FROM poll_runs WHERE id = 2').get() as { slot_count: number; error: string | null };
    expect(pollRun).toEqual({ slot_count: 1, error: null });
    expect(state.consecutiveFailures).toBe(0);
    expect(processNotifications).toHaveBeenCalledTimes(1);
  });

  it('records failed polls and increments consecutive failures', async () => {
    const db = openDatabase(':memory:');
    const lines: Array<Record<string, unknown>> = [];
    const deps = makeDependencies({
      db,
      client: {
        async getSchedule() {
          throw new Error('network unavailable');
        },
      },
      logger: createLogger((_level, line) => {
        lines.push(JSON.parse(line));
      }),
    });

    const state: PollerRunState = { consecutiveFailures: 0 };
    await expect(runPollOnce(deps, state)).rejects.toThrow('network unavailable');

    const pollRun = db.prepare('SELECT slot_count, error FROM poll_runs WHERE id = 1').get() as { slot_count: number; error: string | null };
    expect(pollRun.slot_count).toBe(0);
    expect(pollRun.error).toBe('network unavailable');
    expect(state.consecutiveFailures).toBe(1);
    expect(lines.some((entry) => entry.event === 'poller.run.failed')).toBe(true);
  });
});

describe('getBackoffMs', () => {
  it('caps exponential backoff at the max interval', () => {
    expect(getBackoffMs(0)).toBe(5 * 60 * 1000);
    expect(getBackoffMs(1)).toBe(10 * 1000);
    expect(getBackoffMs(10)).toBe(30 * 60 * 1000);
  });
});
