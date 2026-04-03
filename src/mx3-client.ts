import { parseSchedule, parseCredits, parseReservations, parseBookingResponse, isSignInRequired, parseAvailableDates } from './parser.js';
import { STATIONS, STATION_BY_NAME, type MX3ClientConfig, type TimeSlot, type BookingResult, type Reservation } from './types.js';
import { createLogger } from './logger.js';

const NOE_VALLEY_LOC_ID = '51550';
const logger = createLogger('mx3-client');

export class MX3Client {
  private baseUrl: string;
  private locationPath: string;
  private credentials: { username: string; password: string };
  private cookies: Map<string, string> = new Map();

  constructor(config: MX3ClientConfig) {
    if (!config.credentials.username || !config.credentials.password) {
      throw new Error('MX3 credentials are required (username and password)');
    }
    this.baseUrl = config.baseUrl;
    this.locationPath = config.locationPath;
    this.credentials = config.credentials;
  }

  /**
   * Get schedule for a given date. Fetches all station types at once.
   * If no date provided, returns dates available then fetches the first day.
   */
  async getSchedule(date?: string): Promise<{ slots: TimeSlot[]; dates: string[] }> {
    // First, get the main page to find available dates
    const mainHtml = await this.postWithAuth(this.locationPath, '');
    const dates = parseAvailableDates(mainHtml);

    const targetDate = date || dates[0];
    if (!targetDate) {
      return { slots: [], dates: [] };
    }

    // Fetch schedule for the target date (all station types)
    const scheduleHtml = await this.postWithAuth(
      this.locationPath,
      `locID=${NOE_VALLEY_LOC_ID}&refreshDate=${targetDate}`
    );

    const slots = parseSchedule(scheduleHtml);
    return { slots, dates };
  }

  /**
   * Get remaining gym credits.
   */
  async getCredits(): Promise<number> {
    const text = await this.postWithAuth(
      this.locationPath,
      'checkCredits=true&forMember=&loadAjax=true&layout=blank&ajax=true'
    );
    return parseCredits(text);
  }

  /**
   * Get user's upcoming reservations.
   * Must fetch the full page (not AJAX fragment) — the AJAX endpoint returns empty.
   */
  async getMyBookings(): Promise<Reservation[]> {
    const html = await this.postWithAuth(
      this.locationPath,
      'getReservations=true&forMember='
    );
    return parseReservations(html);
  }

  /**
   * Book a slot. Accepts station name (e.g. "Noe 1") or ID (e.g. 140).
   */
  async bookSlot(station: string | number, date: string, time: string): Promise<BookingResult> {
    const stationId = this.resolveStationId(station);
    if (stationId === undefined) {
      return {
        success: false,
        error: 'invalid',
        message: `Unknown station: ${station}. Valid names: ${Object.values(STATIONS).map(s => s.name).join(', ')}`,
      };
    }

    const body = `v2=true&reserve=${stationId}&res_date=${date}&res_time=${time}&loadAjax=true&layout=blank`;
    const text = await this.postWithAuth(this.locationPath, body);
    return parseBookingResponse(text);
  }

  /**
   * Cancel a reservation. Looks up the booking to find the unreserve ID,
   * then sends: v2=true&unreserve={id}&resourceID={stationId}&loadAjax=true&layout=blank
   */
  async cancelBooking(stationName: string, date: string, time: string): Promise<{ success: boolean; message: string }> {
    const reservations = await this.getMyBookings();
    const stationId = this.resolveStationId(stationName);

    const reservation = reservations.find(r =>
      r.stationId === stationId && r.date === date && r.time === time
    );

    if (!reservation) {
      return { success: false, message: `No booking found for ${stationName} on ${date} at ${time}` };
    }

    if (!reservation.cancelParams) {
      return { success: false, message: 'No cancel params available for this reservation' };
    }

    const body = new URLSearchParams(reservation.cancelParams).toString();
    const response = await this.postWithAuth(this.locationPath, body);

    // The cancel endpoint returns the updated slot HTML on success, or empty string
    if (response.length > 0 || response.trim() === '') {
      return { success: true, message: 'Booking cancelled successfully' };
    }

    return { success: false, message: `Unexpected cancel response: ${response.substring(0, 200)}` };
  }

  private resolveStationId(station: string | number): number | undefined {
    if (typeof station === 'number') {
      return STATIONS[station] ? station : undefined;
    }
    const id = STATION_BY_NAME[station.toLowerCase()];
    if (id !== undefined) return id;
    // Try parsing as number
    const num = parseInt(station, 10);
    if (!isNaN(num) && STATIONS[num]) return num;
    return undefined;
  }

  // --- HTTP layer with cookie auth ---

  private async postWithAuth(path: string, body: string, isRetry = false): Promise<string> {
    // Login if we don't have cookies yet
    if (this.cookies.size === 0) {
      logger.info('mx3.auth.login_required', 'Missing session cookies, authenticating', {
        path,
        isRetry,
      });
      await this.login();
    }

    const response = await this.post(path, body, isRetry);

    // Check for session expiry
    if (isSignInRequired(response) && !isRetry) {
      logger.warn('mx3.auth.session_expired', 'Session expired, retrying with re-authentication', { path });
      this.cookies.clear();
      await this.login();
      return this.postWithAuth(path, body, true);
    }

    if (isSignInRequired(response) && isRetry) {
      logger.error('mx3.auth.reauth_failed', 'Session expired and re-authentication failed', undefined, { path });
      throw new Error('Session expired and re-authentication failed');
    }

    return response;
  }

  private async login(): Promise<void> {
    logger.info('mx3.auth.login_start', 'Starting MX3 authentication');

    // Field names match the AccelSite login form exactly:
    // - userName (camelCase, not lowercase)
    // - loginReturnURL and formSubmitFrom are required hidden fields
    const params = new URLSearchParams({
      userName: this.credentials.username,
      password: this.credentials.password,
      loginReturnURL: this.locationPath,
      formSubmitFrom: 'memberLoginForm.php',
    });
    const response = await this.rawFetch(this.locationPath, params.toString());

    // Extract server-set cookies
    this.extractCookies(response);

    // The page's JS sets as_mx3fitness_com as a duplicate of AccelSite_mx3fitness_com.
    // The server requires this cookie for authenticated requests.
    const authCookie = this.cookies.get('AccelSite_mx3fitness_com');
    if (authCookie) {
      this.cookies.set('as_mx3fitness_com', authCookie);
    }

    if (this.cookies.size < 2) {
      logger.error('mx3.auth.login_failed', 'Login failed: no session cookies received');
      throw new Error('Login failed: no session cookies received');
    }

    logger.info('mx3.auth.login_success', 'MX3 authentication successful', {
      cookieCount: this.cookies.size,
    });
  }

  private async post(path: string, body: string, isRetry = false): Promise<string> {
    const response = await this.rawFetch(path, body, isRetry);
    this.extractCookies(response);
    const text = await response.text();

    if (!response.ok) {
      logger.warn('mx3.http.non_ok_response', 'Received non-OK HTTP response', {
        path,
        status: response.status,
        statusText: response.statusText,
        isRetry,
      });
    }

    return text;
  }

  private async rawFetch(path: string, body: string, isRetry = false): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // Inject cookies
    const cookieStr = Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieStr) {
      headers['Cookie'] = cookieStr;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
      });

      logger.debug('mx3.http.request', 'HTTP request completed', {
        path,
        status: response.status,
        redirected: response.redirected,
        isRetry,
      });

      return response;
    } catch (error) {
      logger.error('mx3.http.request_failed', 'HTTP request failed', error, {
        path,
        isRetry,
      });
      throw error;
    }
  }

  private extractCookies(response: Response): void {
    // Get Set-Cookie headers
    const setCookies = response.headers.getSetCookie?.() || [];
    for (const cookie of setCookies) {
      const [nameValue] = cookie.split(';');
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx > 0) {
        const name = nameValue.substring(0, eqIdx).trim();
        const value = nameValue.substring(eqIdx + 1).trim();
        this.cookies.set(name, value);
      }
    }
  }
}
