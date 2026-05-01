# Claude Usage Monitor

A lightweight Node.js server that receives [Claude Code OpenTelemetry events](https://docs.claude.com/en/docs/claude-code/monitoring-usage), stores them in SQLite, and serves a real-time dashboard for auditing team usage patterns.

## Quick Start

```bash
npm install
npm start
# → Dashboard at http://localhost:3456
# → OTLP receiver at http://localhost:3456/v1/logs
```

To populate with 30 days of demo data:

```bash
SEED_DEMO=1 npm start
```

## Connecting Claude Code

Configure your team's Claude Code instances to export telemetry to this server. Set these environment variables (or add them to your managed settings):

```jsonc
// In your Claude Code managed settings or .claude/settings.json:
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://your-server:3456",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_LOGS_EXPORTER": "otlp"
  }
}
```

Or export them directly:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://your-server:3456"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_LOGS_EXPORTER="otlp"
```

Claude Code will then POST events to `http://your-server:3456/v1/logs` in OTLP JSON format.

### Requiring a shared ingest token

By default the OTLP receiver is open — anyone who can reach the port can write events. To require a shared secret, set `INGEST_TOKEN` on the server, then have each Claude Code client send it via the standard OpenTelemetry headers env var:

```bash
# On the server:
export INGEST_TOKEN="some-long-random-string"

# On each Claude Code client:
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer some-long-random-string"
```

Or in managed settings:

```jsonc
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://your-server:3456",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer some-long-random-string"
  }
}
```

The server compares tokens in constant time and returns 401 on mismatch. Leaving `INGEST_TOKEN` unset preserves the open-ingest behavior.

## Architecture

```
Claude Code instances
  │  (OTLP HTTP/JSON)
  ▼
┌─────────────────────┐
│  POST /v1/logs      │  ← OTLP receiver
│  Express server     │
│  ┌───────────────┐  │
│  │  SQLite (data/ │  │  ← Persistent storage
│  │  usage.db)     │  │
│  └───────────────┘  │
│  GET /api/stats/*   │  ← REST API
│  GET /              │  ← Dashboard (Chart.js)
└─────────────────────┘
```

## Events Captured

| Event | Table | Key Fields |
|-------|-------|------------|
| `claude_code.api_request` | `api_requests` | model, cost, tokens, duration |
| `claude_code.tool_result` | `tool_uses` | tool name, success, duration |
| `claude_code.user_prompt` | `user_prompts` | prompt length |
| `claude_code.api_error` | `api_errors` | status code, retries |
| `claude_code.tool_decision` | `tool_decisions` | tool, accept/reject |

## API Endpoints

All `/api/stats/*` endpoints accept optional query params: `from`, `to`, `user`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats/summary` | KPI totals (cost, tokens, users, errors) |
| `GET /api/stats/cost-over-time` | Daily cost and request counts |
| `GET /api/stats/by-model` | Breakdown by model |
| `GET /api/stats/by-user` | Breakdown by user |
| `GET /api/stats/tools` | Tool usage with success/failure rates |
| `GET /api/stats/hourly-activity` | Hour×day-of-week activity matrix |
| `GET /api/events/recent` | Recent event feed (limit param) |
| `GET /api/users` | List of known user emails |

## Dashboard Features

- **KPI cards**: total cost, requests, tokens, errors, unique users/sessions
- **Cost over time**: dual-axis bar+line chart (cost vs request count)
- **Model breakdown**: doughnut chart of spend per model
- **Tool usage**: horizontal stacked bar of success vs failure by tool
- **Activity heatmap**: bubble chart of hour-of-day × day-of-week
- **User table**: per-user cost and token breakdown
- **Event feed**: chronological stream of recent events
- **Filters**: date range and user email, applied globally

## Configuration

All configuration is via environment variables. None are required — the server boots with sensible defaults and generates a random admin password on first run.

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3456` | Server listen port (used for both the dashboard and the OTLP receiver). |
| `SEED_DEMO` | `0` | Set to `1` to populate ~30 days of demo data on first run. No-op if `api_requests` already has rows. |
| `AUTH_DISABLED` | `0` | Set to `1` to disable dashboard login entirely. Independent from `INGEST_TOKEN` — this flag only controls the dashboard, not the OTLP receiver. |
| `INGEST_TOKEN` | _(unset)_ | If set, the OTLP receiver at `/v1/logs` requires `Authorization: Bearer <token>` on every request. Clients send it via OpenTelemetry's `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"`. Leave unset for open ingest (backward compatible). |
| `SESSION_SECRET` | random | HMAC key used to sign session cookies. If unset, a random 32-byte secret is generated at startup, which invalidates all existing sessions on every restart — set this to a stable value in production. |
| `AUTH_USER` | `admin` | Username for the **initial** admin account. Only read on first run when no `dashboard_users` rows exist; ignored on subsequent boots. Manage users from the admin UI after that. |
| `AUTH_PASS` | random | Password for the **initial** admin account. Only read on first run. If unset, a random password is generated and printed to stdout — capture it from the logs or set this explicitly. |
