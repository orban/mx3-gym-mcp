import type { TimeSlot, ChangeEvent, SlotStatus } from './types.js';
import type { SnapshotRow } from './db.js';

export function detectChanges(
  currentSlots: TimeSlot[],
  previousSnapshots: SnapshotRow[],
  detectedAt: string,
): ChangeEvent[] {
  // Build lookup from previous snapshots: key → status
  const previousByKey = new Map<string, string>();
  for (const snap of previousSnapshots) {
    const key = `${snap.station_id}_${snap.date}_${snap.time}`;
    previousByKey.set(key, snap.status);
  }

  const events: ChangeEvent[] = [];

  for (const slot of currentSlots) {
    const key = `${slot.stationId}_${slot.date}_${slot.time}`;
    const prevStatus = previousByKey.get(key);

    // No previous → baseline, no event
    if (prevStatus === undefined) continue;

    // Status unchanged → no event
    if (prevStatus === slot.status) continue;

    // Status changed → emit event
    events.push({
      stationId: slot.stationId,
      stationName: slot.stationName,
      date: slot.date,
      time: slot.time,
      fromStatus: prevStatus as SlotStatus,
      toStatus: slot.status,
      detectedAt,
    });
  }

  return events;
}
