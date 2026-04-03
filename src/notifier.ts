import { execFile } from 'child_process';
import type { ChangeEvent } from './types.js';
import { timeToMinutes, matchStationPattern, STATIONS } from './types.js';
import type { WatchRow } from './db.js';
import { logger } from './logger.js';

/** Check if a change event matches a watch */
export function matchesWatch(event: ChangeEvent, watch: WatchRow): boolean {
  // 1. Only reserved → available triggers
  if (event.fromStatus !== 'reserved' || event.toStatus !== 'available') return false;

  // 2. Station pattern match
  if (!matchStationPattern(watch.station_pattern, event.stationName)) return false;

  // 3. Time range check (if specified)
  if (watch.time_from || watch.time_to) {
    const slotMin = timeToMinutes(event.time);
    if (watch.time_from && slotMin < timeToMinutes(watch.time_from)) return false;
    if (watch.time_to && slotMin > timeToMinutes(watch.time_to)) return false;
  }

  // 4. Day-of-week check (if specified)
  if (watch.days_of_week) {
    try {
      const days: string[] = JSON.parse(watch.days_of_week);
      if (days.length > 0) {
        // Get day name from date string (YYYY-MM-DD)
        const dayName = new Date(event.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        if (!days.includes(dayName)) return false;
      }
    } catch (error) {
      logger.warn('Skipping watch with invalid day filter', {
        event: 'notifier.watch.invalid_days_filter',
        watchId: watch.id,
        daysOfWeek: watch.days_of_week,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }
  }

  return true;
}

/** Find all watches that match a change event */
export function findMatchingWatches(event: ChangeEvent, watches: WatchRow[]): WatchRow[] {
  return watches.filter(w => matchesWatch(event, w));
}

/** Send a macOS notification for a slot opening. Fire-and-forget. */
export function sendNotification(event: ChangeEvent): void {
  const station = STATIONS[event.stationId];
  const stationType = station?.type === 'private_station' ? 'Private Station' : station?.type === 'open_gym' ? 'Open Gym' : 'Cardio';
  const title = 'MX3 Slot Available!';
  const message = `${event.stationName} (${stationType}) on ${event.date} at ${event.time}`;

  logger.info('Dispatching slot notification', {
    event: 'notifier.notification.dispatch',
    stationId: event.stationId,
    stationName: event.stationName,
    date: event.date,
    time: event.time,
  });

  execFile('osascript', [
    '-e',
    `display notification "${message}" with title "${title}" sound name "Glass"`,
  ], (err) => {
    if (err) {
      logger.error('Notification subprocess failed', {
        event: 'notifier.notification.failed',
        stationId: event.stationId,
        stationName: event.stationName,
        date: event.date,
        time: event.time,
        error: err,
      });
      return;
    }

    logger.info('Notification subprocess completed', {
      event: 'notifier.notification.sent',
      stationId: event.stationId,
      stationName: event.stationName,
      date: event.date,
      time: event.time,
    });
  });
}

/** Process change events against watches, send notifications for matches */
export function processNotifications(events: ChangeEvent[], watches: WatchRow[]): number {
  logger.info('Processing notification candidates', {
    event: 'notifier.process.start',
    eventCount: events.length,
    watchCount: watches.length,
  });

  let count = 0;
  for (const event of events) {
    const matches = findMatchingWatches(event, watches);
    if (matches.length > 0) {
      logger.info('Change event matched notification watches', {
        event: 'notifier.watch.match',
        stationId: event.stationId,
        stationName: event.stationName,
        date: event.date,
        time: event.time,
        matchedWatchIds: matches.map((watch) => watch.id),
      });
      sendNotification(event);
      count++;
    }
  }

  logger.info('Finished processing notification candidates', {
    event: 'notifier.process.complete',
    eventCount: events.length,
    watchCount: watches.length,
    notificationCount: count,
  });
  return count;
}
