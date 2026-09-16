import { describe, it, expect } from 'vitest';
import { detectChanges } from '../src/change-detector.js';
import type { TimeSlot } from '../src/types.js';
import type { SnapshotRow } from '../src/db.js';

const DETECTED_AT = '2026-02-09T10:00:00Z';

function makeSlot(overrides: Partial<TimeSlot> = {}): TimeSlot {
  return {
    stationId: 140,
    stationName: 'Noe 1',
    stationType: 'private_station',
    date: '2026-02-09',
    time: '5:00pm',
    status: 'available',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 1,
    poll_id: 1,
    station_id: 140,
    date: '2026-02-09',
    time: '5:00pm',
    status: 'reserved',
    polled_at: '2026-02-09T09:55:00Z',
    ...overrides,
  };
}

describe('detectChanges', () => {
  it('returns empty array when no previous snapshots (baseline)', () => {
    const current = [makeSlot(), makeSlot({ stationId: 141, stationName: 'Noe 2' })];
    const previous: SnapshotRow[] = [];

    const events = detectChanges(current, previous, DETECTED_AT);

    expect(events).toEqual([]);
  });

  it('emits event when status changes from reserved to available', () => {
    const current = [makeSlot({ status: 'available' })];
    const previous = [makeSnapshot({ status: 'reserved' })];

    const events = detectChanges(current, previous, DETECTED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      stationId: 140,
      stationName: 'Noe 1',
      date: '2026-02-09',
      time: '5:00pm',
      fromStatus: 'reserved',
      toStatus: 'available',
      detectedAt: DETECTED_AT,
    });
  });

  it('emits event when status changes from available to reserved', () => {
    const current = [makeSlot({ status: 'reserved' })];
    const previous = [makeSnapshot({ status: 'available' })];

    const events = detectChanges(current, previous, DETECTED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      stationId: 140,
      stationName: 'Noe 1',
      date: '2026-02-09',
      time: '5:00pm',
      fromStatus: 'available',
      toStatus: 'reserved',
      detectedAt: DETECTED_AT,
    });
  });

  it('returns empty array when status has not changed', () => {
    const current = [makeSlot({ status: 'reserved' })];
    const previous = [makeSnapshot({ status: 'reserved' })];

    const events = detectChanges(current, previous, DETECTED_AT);

    expect(events).toEqual([]);
  });

  it('handles multiple slots with mixed changes correctly', () => {
    const current = [
      makeSlot({ stationId: 140, stationName: 'Noe 1', time: '5:00pm', status: 'available' }),
      makeSlot({ stationId: 141, stationName: 'Noe 2', time: '5:00pm', status: 'reserved' }),
      makeSlot({ stationId: 142, stationName: 'Noe 3', time: '6:00pm', status: 'recurring' }),
    ];
    const previous = [
      makeSnapshot({ station_id: 140, time: '5:00pm', status: 'reserved' }),   // changed
      makeSnapshot({ station_id: 141, time: '5:00pm', status: 'reserved' }),   // unchanged
      makeSnapshot({ station_id: 142, time: '6:00pm', status: 'available' }),   // changed
    ];

    const events = detectChanges(current, previous, DETECTED_AT);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      stationId: 140,
      fromStatus: 'reserved',
      toStatus: 'available',
    });
    expect(events[1]).toMatchObject({
      stationId: 142,
      fromStatus: 'available',
      toStatus: 'recurring',
    });
  });

  it('does not emit event for new slot not in previous snapshots (baseline)', () => {
    const current = [
      makeSlot({ stationId: 140, time: '5:00pm', status: 'available' }),
      makeSlot({ stationId: 141, stationName: 'Noe 2', time: '6:00pm', status: 'available' }),
    ];
    // Only station 140 has a previous snapshot
    const previous = [
      makeSnapshot({ station_id: 140, time: '5:00pm', status: 'reserved' }),
    ];

    const events = detectChanges(current, previous, DETECTED_AT);

    // Only station 140 should emit (changed); station 141 is new baseline
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stationId: 140,
      fromStatus: 'reserved',
      toStatus: 'available',
    });
  });
});
