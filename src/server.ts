import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MX3Client } from './mx3-client.js';
import { STATIONS } from './types.js';

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

      // Group by station type, then by station
      const byType = new Map<string, typeof slots>();
      for (const slot of slots) {
        const group = byType.get(slot.stationType) || [];
        group.push(slot);
        byType.set(slot.stationType, group);
      }

      for (const [type, typeSlots] of byType) {
        const label = type === 'private_station' ? 'Private Stations (1hr)' : type === 'open_gym' ? 'Open Gym (30min)' : 'Cardio (30min)';
        lines.push(`## ${label}`);

        const byStation = new Map<string, typeof slots>();
        for (const slot of typeSlots) {
          const group = byStation.get(slot.stationName) || [];
          group.push(slot);
          byStation.set(slot.stationName, group);
        }

        for (const [name, stationSlots] of byStation) {
          const available = stationSlots.filter(s => s.status === 'available');
          const line = available.length > 0
            ? `${name}: ${available.map(s => s.time).join(', ')}`
            : `${name}: fully booked`;
          lines.push(line);
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

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
