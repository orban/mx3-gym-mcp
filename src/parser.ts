import * as cheerio from 'cheerio';
import { STATIONS, type TimeSlot, type SlotStatus, type BookingResult, type Reservation } from './types.js';

export class MX3ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MX3ParseError';
  }
}

/**
 * Parse schedule HTML for a single day into a flat array of time slots.
 * The HTML is returned by: POST /reserve-noe-station
 * Body: locID=51550&refreshDate={YYYY-MM-DD}
 *
 * Each slot is a <p> with id="res_time_{stationId}_{date}_{time}"
 * containing an <a> whose title and class indicate the slot state.
 */
export function parseSchedule(html: string): TimeSlot[] {
  const $ = cheerio.load(html);
  const slots: TimeSlot[] = [];

  // Each slot is a <p> with id matching res_time_{stationId}_{date}_{time}
  $('p[id^="res_time_"]').each((_, el) => {
    const p = $(el);
    const id = p.attr('id')!;

    // Parse the id: res_time_{stationId}_{date}_{time}
    const match = id.match(/^res_time_(\d+)_(\d{4}-\d{2}-\d{2})_(.+)$/);
    if (!match) return;

    const [, stationIdStr, date, time] = match;
    const stationId = parseInt(stationIdStr, 10);
    const station = STATIONS[stationId];
    if (!station) return; // Unknown station, skip

    const a = p.find('a').first();
    if (a.length === 0) return;

    const title = a.attr('title') || '';
    const classes = a.attr('class') || '';
    const status = parseSlotStatus(title, classes);

    slots.push({
      stationId,
      stationName: station.name,
      stationType: station.type,
      date,
      time,
      status,
    });
  });

  return slots;
}

function parseSlotStatus(title: string, classes: string): SlotStatus {
  if (title === 'Reservation window closed') return 'window_closed';
  if (title === 'Reserved for recurring appointment.') return 'recurring';
  if (title.startsWith('Reserved by')) return 'reserved';
  if (title === 'Click to reserve' || (!classes.includes('reserved') && !classes.includes('gray'))) return 'available';
  // Fallback: if it has 'reserved' class, it's reserved
  if (classes.includes('reserved')) return 'reserved';
  if (classes.includes('gray')) return 'window_closed';
  return 'available';
}

/**
 * Parse credits response. The AJAX endpoint returns a plain number string like "3".
 * If the page returns HTML with <b id="credit_count">, handle that too.
 */
export function parseCredits(text: string): number {
  const trimmed = text.trim();

  // Simple case: plain number string
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && String(num) === trimmed) return num;

  // HTML case: extract from <b id="credit_count">
  const $ = cheerio.load(trimmed);
  const creditEl = $('#credit_count');
  if (creditEl.length > 0) {
    const val = parseInt(creditEl.text().trim(), 10);
    if (!isNaN(val)) return val;
  }

  throw new MX3ParseError(`Could not parse credit count from: ${trimmed.substring(0, 100)}`);
}

/**
 * Parse reservations from the full page HTML.
 *
 * Reservations live under <div id="my_reservations">. Each booking is a child
 * <div> with text like: "Noe 2: Thursday 02/12 at 1:30pm"
 *
 * If a cancel link (<a href="...?unreserve=ID">) is present, cancelParams are
 * extracted. Otherwise the reservation is returned without cancel params.
 *
 * Must be called with: POST getReservations=true&forMember= (no layout=blank).
 */
export function parseReservations(html: string): Reservation[] {
  if (!html || html.trim() === '') return [];

  const $ = cheerio.load(html);
  const reservations: Reservation[] = [];

  // Parse each child div inside #my_reservations
  $('#my_reservations > div').each((_, el) => {
    const div = $(el);
    const text = div.text();

    // Extract time: h:mmam/pm
    const timeMatch = text.match(/(\d{1,2}:\d{2}(?:am|pm))/i);
    if (!timeMatch) return;
    const time = timeMatch[1].toLowerCase();

    // Extract date: MM/DD → YYYY-MM-DD
    const dateMatch = text.match(/(\d{2})\/(\d{2})/);
    if (!dateMatch) return;
    const year = new Date().getFullYear();
    const date = `${year}-${dateMatch[1]}-${dateMatch[2]}`;

    // Match station name against known stations
    let stationId: number | undefined;
    let stationName = '';
    for (const station of Object.values(STATIONS)) {
      if (text.includes(station.name)) {
        stationId = station.id;
        stationName = station.name;
        break;
      }
    }
    if (stationId === undefined) return;

    // Extract cancel params if unreserve link is present
    let cancelParams: Record<string, string> | undefined;
    const cancelLink = div.find('a[href*="unreserve="]');
    if (cancelLink.length > 0) {
      const href = cancelLink.attr('href') || '';
      const unreserveMatch = href.match(/unreserve=(\d+)/);
      if (unreserveMatch) {
        cancelParams = {
          v2: 'true',
          unreserve: unreserveMatch[1],
          resourceID: String(stationId),
          loadAjax: 'true',
          layout: 'blank',
        };
      }
    }

    reservations.push({ stationId, stationName, date, time, cancelParams });
  });

  return reservations;
}

/**
 * Parse booking response. The endpoint returns plain text for errors
 * or HTML for success.
 */
export function parseBookingResponse(text: string): BookingResult {
  const trimmed = text.trim();

  if (trimmed === 'reload') {
    return { success: false, error: 'no_credits', message: 'Out of gym credits' };
  }
  if (trimmed === 'duplicate') {
    return { success: false, error: 'duplicate', message: 'Slot already reserved' };
  }
  if (trimmed === 'concurrent') {
    return { success: false, error: 'concurrent', message: 'Overlapping reservation not allowed' };
  }
  if (trimmed === 'invalid') {
    return { success: false, error: 'invalid', message: 'Invalid station or time' };
  }

  // HTML response means success — the response replaces the slot with updated state
  if (trimmed.length > 0) {
    return { success: true, message: 'Slot booked successfully' };
  }

  return { success: false, error: 'invalid', message: 'Empty response from server' };
}

/**
 * Check if HTML contains "Sign In Required" — indicates session expired.
 */
export function isSignInRequired(html: string): boolean {
  return html.includes('Sign In Required');
}

/**
 * Extract available dates from the main page HTML.
 * The page has day-box spans with title="YYYY-MM-DD".
 */
export function parseAvailableDates(html: string): string[] {
  const $ = cheerio.load(html);
  const dates: string[] = [];
  $('span.day-box[title]').each((_, el) => {
    const date = $(el).attr('title');
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dates.push(date);
    }
  });
  return dates;
}
