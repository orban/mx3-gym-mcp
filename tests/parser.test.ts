import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSchedule, parseCredits, parseBookingResponse, parseReservations, isSignInRequired, MX3ParseError } from '../src/parser.js';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('parseSchedule', () => {
  it('parses station schedule with all slot states', () => {
    const html = fixture('schedule-station.html');
    const slots = parseSchedule(html);

    expect(slots.length).toBe(6);

    // Available slot: Noe 1, 5:00am
    const available = slots.find(s => s.stationId === 140 && s.time === '5:00am');
    expect(available).toBeDefined();
    expect(available!.status).toBe('available');
    expect(available!.stationName).toBe('Noe 1');
    expect(available!.stationType).toBe('private_station');
    expect(available!.date).toBe('2026-02-10');

    // Reserved slot: Noe 1, 6:00am
    const reserved = slots.find(s => s.stationId === 140 && s.time === '6:00am');
    expect(reserved).toBeDefined();
    expect(reserved!.status).toBe('reserved');

    // Recurring slot: Noe 1, 7:00am
    const recurring = slots.find(s => s.stationId === 140 && s.time === '7:00am');
    expect(recurring).toBeDefined();
    expect(recurring!.status).toBe('recurring');

    // Window closed: Noe 1, 8:00am
    const closed = slots.find(s => s.stationId === 140 && s.time === '8:00am');
    expect(closed).toBeDefined();
    expect(closed!.status).toBe('window_closed');

    // Noe 2 slots
    const noe2Available = slots.find(s => s.stationId === 141 && s.time === '5:30am');
    expect(noe2Available).toBeDefined();
    expect(noe2Available!.status).toBe('available');
    expect(noe2Available!.stationName).toBe('Noe 2');
  });

  it('returns empty array for empty HTML', () => {
    expect(parseSchedule('')).toEqual([]);
  });

  it('returns empty array for HTML with no slots', () => {
    expect(parseSchedule('<div>No schedule</div>')).toEqual([]);
  });
});

describe('parseCredits', () => {
  it('parses plain number string', () => {
    expect(parseCredits('3')).toBe(3);
    expect(parseCredits('0')).toBe(0);
    expect(parseCredits(' 12 ')).toBe(12);
  });

  it('parses HTML with credit_count element', () => {
    expect(parseCredits('<b id="credit_count">3</b>')).toBe(3);
  });

  it('throws MX3ParseError for unparseable content', () => {
    expect(() => parseCredits('not a number')).toThrow(MX3ParseError);
  });
});

describe('parseBookingResponse', () => {
  it('maps reload to no_credits', () => {
    const result = parseBookingResponse('reload');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('no_credits');
  });

  it('maps duplicate to duplicate', () => {
    const result = parseBookingResponse('duplicate');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('duplicate');
  });

  it('maps concurrent to concurrent', () => {
    const result = parseBookingResponse('concurrent');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('concurrent');
  });

  it('maps invalid to invalid', () => {
    const result = parseBookingResponse('invalid');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('invalid');
  });

  it('treats HTML response as success', () => {
    const html = '<p id="res_time_140_2026-02-10_5:00am"><a class="button-link reserved">5:00am</a></p>';
    const result = parseBookingResponse(html);
    expect(result.success).toBe(true);
  });

  it('treats empty response as error', () => {
    const result = parseBookingResponse('');
    expect(result.success).toBe(false);
  });
});

describe('parseReservations', () => {
  it('returns empty array for empty HTML', () => {
    expect(parseReservations('')).toEqual([]);
  });

  it('parses reservations from full page with #my_reservations div', () => {
    const html = fixture('reservations.html');
    const reservations = parseReservations(html);

    expect(reservations).toHaveLength(2);

    // First reservation: Noe 1 at 9:00pm on 02/09
    expect(reservations[0].stationId).toBe(140);
    expect(reservations[0].stationName).toBe('Noe 1');
    expect(reservations[0].time).toBe('9:00pm');
    expect(reservations[0].date).toMatch(/-02-09$/);
    expect(reservations[0].cancelParams).toEqual({
      v2: 'true',
      unreserve: '128242',
      resourceID: '140',
      loadAjax: 'true',
      layout: 'blank',
    });

    // Second reservation: Noe 3 at 6:00am on 02/10
    expect(reservations[1].stationId).toBe(142);
    expect(reservations[1].stationName).toBe('Noe 3');
    expect(reservations[1].time).toBe('6:00am');
    expect(reservations[1].date).toMatch(/-02-10$/);
    expect(reservations[1].cancelParams?.unreserve).toBe('128300');
  });
});

describe('isSignInRequired', () => {
  it('detects sign in required page', () => {
    expect(isSignInRequired('<h1>Sign In Required</h1>')).toBe(true);
  });

  it('returns false for normal content', () => {
    expect(isSignInRequired('<div>Normal page</div>')).toBe(false);
  });
});
