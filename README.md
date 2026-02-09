# mx3-gym-mcp

MCP server for [MX3 Fitness](https://mx3fitness.com) gym booking at Noe Valley, San Francisco.

Lets Claude check schedules, book slots, cancel reservations, and view remaining credits.

## Install as Claude Code Plugin

```sh
claude plugin add orban/mx3-gym-mcp
```

Set your credentials in your shell profile:

```sh
export MX3_USERNAME="your@email.com"
export MX3_PASSWORD="your-password"
```

Restart Claude Code. The MCP tools will be available automatically.

## Install Manually

Clone the repo and install dependencies:

```sh
git clone https://github.com/orban/mx3-gym-mcp.git
cd mx3-gym-mcp
npm install
```

Add to your Claude Code config (`~/.claude.json` under the project's `mcpServers`):

```json
{
  "mx3-gym": {
    "type": "stdio",
    "command": "npx",
    "args": ["tsx", "/path/to/mx3-gym-mcp/src/server.ts"],
    "env": {
      "MX3_USERNAME": "your@email.com",
      "MX3_PASSWORD": "your-password"
    }
  }
}
```

## Tools

### get_schedule

Get slot availability for a given date. Shows all stations grouped by type with available times.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Date in YYYY-MM-DD format. Defaults to today. |

### book_slot

Reserve a gym slot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `station` | string | Yes | Station name (e.g. "Noe 1", "Air Bike") or station ID |
| `date` | string | Yes | Date in YYYY-MM-DD format |
| `time` | string | Yes | Time in h:mmam/pm format (e.g. "5:00am", "1:30pm") |

### cancel_booking

Cancel an existing reservation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `station_name` | string | Yes | Station name (e.g. "Noe 1", "Open Gym 2") |
| `date` | string | Yes | Date in YYYY-MM-DD format |
| `time` | string | Yes | Time in h:mmam/pm format |

### get_my_bookings

List upcoming reservations and remaining gym credits. No parameters.

## Stations

**Private Stations (1hr):** Noe 1, Noe 2, Noe 3, Noe 4

**Open Gym (30min):** Open Gym 1, Open Gym 2, Open Gym 3

**Cardio (30min):** Air Bike, Air Rower, Climber, Peloton, Tread Mill

## Development

```sh
npm install
npm run typecheck    # Type check
npm test             # Run tests
npm start            # Start MCP server (requires MX3_USERNAME, MX3_PASSWORD)
```

## How It Works

The MX3 Fitness platform uses a legacy PHP/HTML system (AccelSite) without a JSON API. This server:

1. Authenticates via cookie-based login with `userName`, `password`, and hidden form fields
2. Fetches schedule HTML via `POST /reserve-noe-station` with `locID=51550&refreshDate={date}`
3. Parses slot availability from `<p id="res_time_{stationId}_{date}_{time}">` elements using cheerio
4. Books slots via `v2=true&reserve={stationId}&res_date={date}&res_time={time}`
5. Cancels via `v2=true&unreserve={reservationId}&resourceID={stationId}`
6. Reads reservations from the full page HTML under `#my_reservations`

Session cookies are managed in-memory with automatic re-authentication on expiry.

## License

MIT
