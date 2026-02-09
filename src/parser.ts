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
 * The AJAX endpoint (getReservations=true&forMember=&layout=blank&ajax=true) returns
 * an empty string. Reservations are only available in the full page under
 * <div id="my_reservations">, with each booking as:
 *   <div>Noe 1: Monday 02/09 at 9:00pm <a href='reserve-noe-station?unreserve=128242'>cancel reservation</a></div>
 *
 * Must be called with: POST getReservations=true&forMember= (no layout=blank).
 */
export function parseReservations(html: string): Reservation[] {
  if (!html || html.trim() === '') return [];

  const $ = cheerio.load(html);
  const reservations: Reservation[] = [];

  // Find cancel links with unreserve param — these are the reservations
  $('a[href*="unreserve="]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') || '';

    // Extract reservation ID from href: reserve-noe-station?unreserve=128242
    const unreserveMatch = href.match(/unreserve=(\d+)/);
    if (!unreserveMatch) return;
    const reservationId = unreserveMatch[1];

    // The parent div text contains: "Noe 1: Monday 02/09 at 9:00pm cancel reservation"
    const row = a.parent();
    const text = row.text();

    // Extract time: look for h:mmam/pm pattern
    const timeMatch = text.match(/(\d{1,2}:\d{2}(?:am|pm))/i);
    if (!timeMatch) return;
    const time = timeMatch[1].toLowerCase();

    // Extract date: MM/DD format — convert to YYYY-MM-DD using current year
    const dateMatch = text.match(/(\d{2})\/(\d{2})/);
    let date = '';
    if (dateMatch) {
      const year = new Date().getFullYear();
      date = `${year}-${dateMatch[1]}-${dateMatch[2]}`;
    }

    // Extract station name by matching against known stations
    let stationId: number | undefined;
    let stationName = '';
    for (const station of Object.values(STATIONS)) {
      if (text.includes(station.name)) {
        stationId = station.id;
        stationName = station.name;
        break;
      }
    }

    if (stationId !== undefined && date && time) {
      reservations.push({
        stationId,
        stationName,
        date,
        time,
        cancelParams: {
          v2: 'true',
          unreserve: reservationId,
          resourceID: String(stationId),
          loadAjax: 'true',
          layout: 'blank',
        },
      });
    }
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
