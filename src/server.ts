import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MX3Client } from './mx3-client.js';
import { STATIONS, compareTimeStrings } from './types.js';
import { openDatabase, addWatch, removeWatch, listWatches } from './db.js';
import { getChanges, getTrends, getPopularity } from './analytics.js';

const username = process.env.MX3_USERNAME;
const password = process.env.MX3_PASSWORD;

if (!username || !password) {
  console.error('MX3_USERNAME and MX3_PASSWORD environment variables are required');
  process.exit(1);
}

const client = new MX3Client({
  baseUrl: 'https://mx3fitness.com',
  locationPath: '/reserve-noe-station',
  credentials: { username, password },
});

const server = new McpServer({
  name: 'mx3-gym',
  version: '0.1.0',
});

// --- Tool: get_schedule ---
server.tool(
  'get_schedule',
  'Get gym slot availability at MX3 Noe Valley. Shows all stations and their booking status for a given date. All times are Pacific Time.',
  { date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to today.') },
  async ({ date }) => {
    try {
      const { slots, dates } = await client.getSchedule(date);
      const credits = await client.getCredits();

      if (slots.length === 0) {
        return { content: [{ type: 'text', text: `No schedule available${date ? ` for ${date}` : ''}.\nAvailable dates: ${dates.join(', ') || 'none'}` }] };
      }

      const targetDate = date || dates[0];
      const lines: string[] = [];
      lines.push(`Schedule for ${targetDate} — ${credits} credits remaining`);
      lines.push(`Available dates: ${dates.join(', ')}`);
      lines.push('');

      // Group by station type
      const byType = new Map<string, typeof slots>();
      for (const slot of slots) {
        const group = byType.get(slot.stationType) || [];
        group.push(slot);
        byType.set(slot.stationType, group);
      }

      for (const [type, typeSlots] of byType) {
        const label = type === 'private_station' ? 'Private Stations (1hr)' : type === 'open_gym' ? 'Open Gym (30min)' : 'Cardio (30min)';
        lines.push(`## ${label}`);

        // Collect station names (columns) and available times (rows)
        const stationNames: string[] = [];
        const availableByStation = new Map<string, Set<string>>();
        for (const slot of typeSlots) {
          if (!availableByStation.has(slot.stationName)) {
            stationNames.push(slot.stationName);
            availableByStation.set(slot.stationName, new Set());
          }
          if (slot.status === 'available') {
            availableByStation.get(slot.stationName)!.add(slot.time);
          }
        }

        // Collect all unique available times across stations, sorted chronologically
        const allTimes = new Set<string>();
        for (const times of availableByStation.values()) {
          for (const t of times) allTimes.add(t);
        }
        const sortedTimes = [...allTimes].sort(compareTimeStrings);

        if (sortedTimes.length === 0) {
          lines.push('Fully booked');
        } else {
          // Build markdown table: Time | Station1 | Station2 | ...
          lines.push(`| Time | ${stationNames.join(' | ')} |`);
          lines.push(`|------|${stationNames.map(() => ':----:').join('|')}|`);
          for (const time of sortedTimes) {
            const cells = stationNames.map(name =>
              availableByStation.get(name)!.has(time) ? '✓' : ''
            );
            lines.push(`| ${time} | ${cells.join(' | ')} |`);
          }
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching schedule: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Tool: book_slot ---
server.tool(
  'book_slot',
  'Reserve a gym slot at MX3 Noe Valley. Accepts station name (e.g. "Noe 1", "Air Bike") or station ID.',
  {
    station: z.string().describe('Station name (e.g. "Noe 1", "Open Gym 2", "Air Bike") or station ID (e.g. "140")'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    time: z.string().describe('Time in h:mmam/pm format (e.g. "5:00am", "1:30pm")'),
  },
  async ({ station, date, time }) => {
    try {
      const result = await client.bookSlot(station, date, time);
      if (result.success) {
        return { content: [{ type: 'text', text: `Booked ${station} on ${date} at ${time}` }] };
      }
      return { content: [{ type: 'text', text: `Booking failed: ${result.message}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error booking slot: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Tool: cancel_booking ---
server.tool(
  'cancel_booking',
  'Cancel an existing reservation at MX3 Noe Valley.',
  {
    station_name: z.string().describe('Station name (e.g. "Noe 1", "Open Gym 2")'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    time: z.string().describe('Time in h:mmam/pm format (e.g. "5:00am", "1:30pm")'),
  },
  async ({ station_name, date, time }) => {
    try {
      const result = await client.cancelBooking(station_name, date, time);
      return { content: [{ type: 'text', text: result.message }], isError: !result.success };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error cancelling booking: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Tool: get_my_bookings ---
server.tool(
  'get_my_bookings',
  'List upcoming reservations and remaining gym credits at MX3 Noe Valley.',
  {},
  async () => {
    try {
      const [reservations, credits] = await Promise.all([
        client.getMyBookings(),
        client.getCredits(),
      ]);

      const lines: string[] = [];
      lines.push(`${credits} gym credits remaining`);
      lines.push('');

      if (reservations.length === 0) {
        lines.push('No upcoming reservations.');
      } else {
        lines.push('Upcoming reservations:');
        for (const r of reservations) {
          lines.push(`- ${r.stationName} on ${r.date} at ${r.time}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching bookings: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Analytics DB (read-only access to poller's data) ---
let analyticsDb: ReturnType<typeof openDatabase> | null = null;
function getDb() {
  if (!analyticsDb) analyticsDb = openDatabase();
  return analyticsDb;
}

// --- Tool: get_changes ---
server.tool(
  'get_changes',
  'Get recent booking/cancellation events detected by the poller. Requires the poller to be running and collecting data.',
  {
    station: z.string().optional().describe('Filter by station name (e.g. "Noe 1")'),
    transition: z.enum(['booked', 'cancelled', 'all']).optional().describe('Filter: "booked" (*→reserved), "cancelled" (reserved→available), or "all"'),
    since: z.string().optional().describe('Only show changes after this ISO datetime'),
    limit: z.number().optional().describe('Max results (default 50)'),
  },
  async ({ station, transition, since, limit }) => {
    try {
      const changes = getChanges(getDb(), { station, transition, since, limit });
      if (changes.length === 0) {
        return { content: [{ type: 'text', text: 'No changes found. Make sure the poller is running (`npm run poller`).' }] };
      }
      const lines = changes.map(c =>
        `${c.detectedAt} | ${c.stationName} ${c.date} ${c.time} | ${c.fromStatus} → ${c.toStatus}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Tool: get_trends ---
server.tool(
  'get_trends',
  'Get booking velocity and cancellation rates by day. Shows how many bookings/cancellations happen per day.',
  {
    station: z.string().optional().describe('Filter by station name'),
    day_of_week: z.string().optional().describe('Filter by day (e.g. "Mon", "Tue")'),
    days_back: z.number().optional().describe('How many days back to look (default 7)'),
  },
  async ({ station, day_of_week, days_back }) => {
    try {
      const trends = getTrends(getDb(), { station, dayOfWeek: day_of_week, daysBack: days_back });
      if (trends.length === 0) {
        return { content: [{ type: 'text', text: 'No trend data yet. The poller needs to run for at least a day.' }] };
      }
      const lines = ['| Date | Bookings | Cancellations | Net |', '|------|----------|---------------|-----|'];
      for (const t of trends) {
        lines.push(`| ${t.date} | ${t.bookings} | ${t.cancellations} | ${t.netBookings >= 0 ? '+' : ''}${t.netBookings} |`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Tool: get_popularity ---
server.tool(
  'get_popularity',
  'Get station, time, or day-of-week popularity rankings based on booking data.',
  {
    group_by: z.enum(['station', 'time', 'day_of_week']).describe('How to group results'),
    station_type: z.enum(['private_station', 'open_gym', 'cardio']).optional().describe('Filter by station type'),
    days_back: z.number().optional().describe('How many days back to look (default 7)'),
  },
  async ({ group_by, station_type, days_back }) => {
    try {
      const results = getPopularity(getDb(), { groupBy: group_by, stationType: station_type, daysBack: days_back });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No popularity data yet. The poller needs to collect data first.' }] };
      }
      const lines = ['| Group | Bookings | Cancellations | Utilization % |', '|-------|----------|---------------|---------------|'];
      for (const r of results) {
        lines.push(`| ${r.group} | ${r.bookingCount} | ${r.cancellationCount} | ${r.utilizationPct.toFixed(1)}% |`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Tool: watch_slot ---
server.tool(
  'watch_slot',
  'Add, remove, or list notification watches. When a watched slot opens up (reserved→available), a macOS notification fires.',
  {
    action: z.enum(['add', 'remove', 'list']).describe('"add" a new watch, "remove" by ID, or "list" all watches'),
    watch_id: z.number().optional().describe('Watch ID to remove (required for "remove" action)'),
    station_pattern: z.string().optional().describe('Glob pattern for station names: "Noe *", "Noe 1", "*" (for "add")'),
    time_from: z.string().optional().describe('Earliest time to watch, h:mmam/pm format (for "add")'),
    time_to: z.string().optional().describe('Latest time to watch, h:mmam/pm format (for "add")'),
    days: z.array(z.string()).optional().describe('Days of week to watch: ["Mon","Tue","Wed"] (for "add")'),
  },
  async ({ action, watch_id, station_pattern, time_from, time_to, days }) => {
    try {
      const db = getDb();

      if (action === 'list') {
        const watches = listWatches(db);
        if (watches.length === 0) {
          return { content: [{ type: 'text', text: 'No watches configured. Use action "add" to create one.' }] };
        }
        const lines = watches.map(w => {
          const parts = [`#${w.id} [${w.active ? 'active' : 'inactive'}] "${w.station_pattern}"`];
          if (w.time_from || w.time_to) parts.push(`${w.time_from || '*'}–${w.time_to || '*'}`);
          if (w.days_of_week) parts.push(`days: ${w.days_of_week}`);
          return parts.join(' ');
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (action === 'remove') {
        if (watch_id === undefined) {
          return { content: [{ type: 'text', text: 'watch_id is required for "remove" action' }], isError: true };
        }
        const removed = removeWatch(db, watch_id);
        return { content: [{ type: 'text', text: removed ? `Watch #${watch_id} deactivated` : `Watch #${watch_id} not found or already inactive` }] };
      }

      // action === 'add'
      const id = addWatch(db, {
        stationPattern: station_pattern || '*',
        timeFrom: time_from,
        timeTo: time_to,
        daysOfWeek: days,
      });
      return { content: [{ type: 'text', text: `Watch #${id} created: "${station_pattern || '*'}"${time_from ? ` from ${time_from}` : ''}${time_to ? ` to ${time_to}` : ''}${days ? ` on ${days.join(',')}` : ''}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
