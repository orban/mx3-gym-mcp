# Logging Quality Audit

This repo now uses a shared structured logger (`src/logger.ts`) for runtime paths with the highest operational value:

- `src/poller.ts`
- `src/notifier.ts`
- `src/server.ts`
- `src/mx3-client.ts`

## Audit checklist

The following checklist was applied while auditing and upgrading logs:

- Completeness: startup, success, failure, retry, and backoff paths are logged.
- Context richness: logs include stable identifiers (`pollId`) and key counters (slot/change/notification counts).
- Consistency: all runtime logs use the same JSON shape and log levels.
- Severity correctness: normal lifecycle uses `info`/`debug`, degraded states use `warn`, hard failures use `error`.
- Error diagnosability: errors include serialized name/message/stack and surrounding context.
- Sensitive-data safety: credential-like fields are redacted (`password`, `token`, `cookie`, `authorization`, `credential`, `body`, etc.).

## Log shape

Each entry is emitted as a JSON object:

- `timestamp` ISO-8601 timestamp
- `level` one of `debug`, `info`, `warn`, `error`
- `component` logger namespace (for example `poller`)
- `event` stable event name
- `message` concise human-readable message
- `context` optional structured fields
- `error` optional serialized error metadata

## Poller incident debugging

Useful events for poller investigations:

- `poller.loop.started`: process startup and baseline timing config.
- `poller.poll.started`: beginning of each poll run with `pollId`.
- `poller.poll.completed`: successful run summary (`datesPolled`, `slotCount`, `changeCount`, `notificationCount`).
- `poller.poll.failed`: error + `consecutiveFailures` increment.
- `poller.loop.backoff`: active backoff duration (`waitMs`).

Example flow during repeated upstream failures:

1. `poller.poll.failed` with increasing `consecutiveFailures`
2. `poller.loop.backoff` with growing `waitMs`
3. eventually `poller.poll.completed` resets `consecutiveFailures` to `0`

## Operational notes

- Set `LOG_LEVEL=debug` for deeper request/poller tracing.
- Default level is `info` when `LOG_LEVEL` is not set.
- Logs are written to stderr as line-delimited JSON for easy ingestion.
