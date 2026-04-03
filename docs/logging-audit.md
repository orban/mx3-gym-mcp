# Logging Audit

This project emits structured JSON logs for the main runtime paths:

- `server.*` for MCP startup and tool execution
- `poller.*` for poll loop lifecycle, persistence, failure, and backoff
- `notifier.*` for watch matching and notification subprocess behavior
- `mx3.*` for authentication boundaries, session retry, and HTTP status anomalies

## Field Conventions

- `timestamp`: ISO-8601 event time
- `level`: `debug`, `info`, `warn`, or `error`
- `event`: stable machine-readable event name
- Context fields such as `pollId`, `tool`, `dateCount`, `slotCount`, `changeCount`, and `consecutiveFailures`
- `error`: serialized error object with `name`, `message`, `stack`, and `cause` when available

Sensitive fields are redacted automatically when their key names indicate credentials or request bodies, including `password`, `cookie`, `cookies`, `token`, `secret`, and `body`.

## Debugging Poller Incidents

Typical sequence for a healthy poll:

```json
{"event":"poller.run.start","pollId":42,"consecutiveFailures":0}
{"event":"poller.run.persisted","pollId":42,"dateCount":3,"slotCount":57,"changeCount":2,"watchCount":4}
{"event":"poller.run.complete","pollId":42,"notificationCount":1,"consecutiveFailures":0}
{"event":"poller.loop.sleep","waitMs":300000,"consecutiveFailures":0}
```

If notification delivery fails after the poll succeeds, the poll stays successful and the failure appears separately:

```json
{"event":"poller.notifications.failed","pollId":42,"changeCount":2,"watchCount":4}
{"event":"poller.run.complete","pollId":42,"notificationCount":0,"consecutiveFailures":0}
```

That separation is intentional so notification issues do not trigger poll backoff or corrupt poll accounting.
