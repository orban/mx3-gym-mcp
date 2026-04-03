import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => cb(null)),
}));

import { execFile } from 'child_process';
import { matchesWatch, findMatchingWatches, processNotifications } from '../src/notifier.js';
import type { ChangeEvent } from '../src/types.js';
import type { WatchRow } from '../src/db.js';
import { createLogger, type LogEntry } from '../src/logger.js';

function makeEvent(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    stationId: 140,
    stationName: 'Noe 1',
    date: '2025-03-03', // Monday
    time: '5:00pm',
    fromStatus: 'reserved',
    toStatus: 'available',
    detectedAt: '2025-03-03T16:55:00Z',
    ...overrides,
  };
}

function makeWatch(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    id: 1,
    station_pattern: '*',
    time_from: null,
    time_to: null,
    days_of_week: null,
    active: 1,
    created_at: '2025-03-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matchesWatch', () => {
  it('matches reserved→available with wildcard pattern', () => {
    const event = makeEvent();
    const watch = makeWatch();
    expect(matchesWatch(event, watch)).toBe(true);
  });

  it('does NOT match available→reserved (wrong direction)', () => {
    const event = makeEvent({ fromStatus: 'available', toStatus: 'reserved' });
    const watch = makeWatch();
    expect(matchesWatch(event, watch)).toBe(false);
  });

  it('does NOT match when station pattern does not match', () => {
    const event = makeEvent({ stationName: 'Noe 1' });
    const watch = makeWatch({ station_pattern: 'Open Gym *' });
    expect(matchesWatch(event, watch)).toBe(false);
  });

  it('respects time range (time_from / time_to)', () => {
    const event = makeEvent({ time: '5:00pm' }); // 1020 minutes
    const watchInRange = makeWatch({ time_from: '4:00pm', time_to: '6:00pm' });
    const watchOutOfRange = makeWatch({ time_from: '6:00am', time_to: '8:00am' });

    expect(matchesWatch(event, watchInRange)).toBe(true);
    expect(matchesWatch(event, watchOutOfRange)).toBe(false);
  });

  it('respects time_from only (no upper bound)', () => {
    const event = makeEvent({ time: '5:00pm' });
    const watch = makeWatch({ time_from: '6:00pm' });
    expect(matchesWatch(event, watch)).toBe(false);

    const watchEarlier = makeWatch({ time_from: '4:00pm' });
    expect(matchesWatch(event, watchEarlier)).toBe(true);
  });

  it('respects time_to only (no lower bound)', () => {
    const event = makeEvent({ time: '5:00pm' });
    const watch = makeWatch({ time_to: '4:00pm' });
    expect(matchesWatch(event, watch)).toBe(false);

    const watchLater = makeWatch({ time_to: '6:00pm' });
    expect(matchesWatch(event, watchLater)).toBe(true);
  });

  it('respects days_of_week filter', () => {
    // 2025-03-03 is a Monday
    const event = makeEvent({ date: '2025-03-03' });

    const watchMatchDay = makeWatch({ days_of_week: '["Mon","Wed"]' });
    expect(matchesWatch(event, watchMatchDay)).toBe(true);

    const watchWrongDay = makeWatch({ days_of_week: '["Tue","Thu"]' });
    expect(matchesWatch(event, watchWrongDay)).toBe(false);
  });

  it('matches when days_of_week is empty array', () => {
    const event = makeEvent({ date: '2025-03-03' });
    const watch = makeWatch({ days_of_week: '[]' });
    expect(matchesWatch(event, watch)).toBe(true);
  });

  it('matches specific station pattern', () => {
    const event = makeEvent({ stationName: 'Noe 1' });
    const watch = makeWatch({ station_pattern: 'Noe *' });
    expect(matchesWatch(event, watch)).toBe(true);
  });
});

describe('findMatchingWatches', () => {
  it('returns only matching watches from a list', () => {
    const event = makeEvent({ stationName: 'Noe 1' });
    const watches: WatchRow[] = [
      makeWatch({ id: 1, station_pattern: 'Noe *' }),
      makeWatch({ id: 2, station_pattern: 'Open Gym *' }),
      makeWatch({ id: 3, station_pattern: '*' }),
    ];

    const result = findMatchingWatches(event, watches);
    expect(result).toHaveLength(2);
    expect(result.map(w => w.id)).toEqual([1, 3]);
  });

  it('returns empty array when nothing matches', () => {
    const event = makeEvent({ fromStatus: 'available', toStatus: 'reserved' });
    const watches: WatchRow[] = [
      makeWatch({ id: 1, station_pattern: '*' }),
    ];

    const result = findMatchingWatches(event, watches);
    expect(result).toHaveLength(0);
  });
});

describe('processNotifications', () => {
  it('calls sendNotification correct number of times', () => {
    const events: ChangeEvent[] = [
      makeEvent({ stationName: 'Noe 1' }),
      makeEvent({ stationName: 'Open Gym 1', stationId: 144 }),
      makeEvent({ stationName: 'Noe 2', stationId: 141 }),
    ];
    const watches: WatchRow[] = [
      makeWatch({ station_pattern: 'Noe *' }),
    ];

    const count = processNotifications(events, watches);

    // Only Noe 1 and Noe 2 match "Noe *", so 2 notifications
    expect(count).toBe(2);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('sends zero notifications when no events match', () => {
    const events: ChangeEvent[] = [
      makeEvent({ fromStatus: 'available', toStatus: 'reserved' }),
    ];
    const watches: WatchRow[] = [makeWatch()];

    const count = processNotifications(events, watches);
    expect(count).toBe(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('includes station info in osascript call', () => {
    const events: ChangeEvent[] = [
      makeEvent({ stationId: 140, stationName: 'Noe 1', date: '2025-03-03', time: '5:00pm' }),
    ];
    const watches: WatchRow[] = [makeWatch()];

    processNotifications(events, watches);

    expect(execFile).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('Noe 1')],
      expect.any(Function),
    );
  });

  it('logs notifier failure with actionable context', () => {
    vi.mocked(execFile).mockImplementationOnce((_cmd: string, _args: string[], cb: Function) => {
      cb(new Error('osascript unavailable'));
      return {} as any;
    });

    const entries: LogEntry[] = [];
    const logger = createLogger('test-notifier', {
      level: 'debug',
      writer: (entry) => entries.push(entry),
    });

    processNotifications(
      [makeEvent({ stationId: 140, stationName: 'Noe 1', date: '2025-03-03', time: '5:00pm' })],
      [makeWatch()],
      logger,
    );

    expect(entries.some((entry) =>
      entry.level === 'error' &&
      entry.event === 'notifier.osascript.failed' &&
      entry.context?.stationName === 'Noe 1' &&
      entry.context?.time === '5:00pm'
    )).toBe(true);
  });
});
