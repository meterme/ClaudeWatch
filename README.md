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

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3456` | Server listen port |
| `SEED_DEMO` | `0` | Set to `1` to populate demo data on first run |
