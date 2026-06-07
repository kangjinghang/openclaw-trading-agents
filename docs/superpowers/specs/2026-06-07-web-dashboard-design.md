# Web Dashboard Design — Trading Agents Report Viewer

## Overview

A read-only web dashboard that visualizes past stock analysis reports. Launched via `trading-agents dashboard` CLI command. Dark theme, compact table + modal design.

## Architecture

```
CLI: node dist/dashboard.js [--port 3210] [--report-dir ./trading-reports]
  ↓
HTTP server (Node.js built-in http module)
  ↓ serves
dashboard/index.html (single-file SPA with embedded CSS/JS)
  ↓ reads
GET /api/reports           → lists all report summaries
GET /api/reports/:id       → full report JSON
GET /api/reports/:id/detail/:path → detail files (analysts, debate, etc.)
GET /api/traces/:runId     → trace files for a run
```

### Components

1. **`src/dashboard.ts`** — HTTP server, API routes, CLI entry point
2. **`src/dashboard-api.ts`** — API handlers: scan report dir, read JSON, read traces
3. **`dashboard/index.html`** — Single-file SPA: embedded CSS + vanilla JS, zero dependencies

### Tech Stack

- **Backend**: Node.js built-in `http` module (no Express)
- **Frontend**: Vanilla HTML/CSS/JS in a single file, no build step
- **Theme**: Dark theme (#0f1019 background), green/yellow/red color coding for directions
- **Dependencies**: Zero new npm packages

## Views

### View 1 — Analysis List (main page)

- Dark table listing all reports from report directory
- Columns: Ticker, Date, Mode, Direction, Confidence bar, Analyst color dots (7 squares), Cost, Risk status
- Click row → opens detail modal
- Filter by mode (quick/full), search by ticker
- Sorted by date descending

### View 2 — Detail Modal: Analyst Verdicts (tab)

- Grid of analyst cards with colored left border (green=看多, yellow=中性, red=看空)
- Each card: role name, direction badge, reason excerpt, data source
- Click card → expand to show full markdown content

### View 3 — Detail Modal: Full Mode Detail (tab, full mode only)

- **Research Decision**: Bull/Bear score bar (0-100), direction badge, confidence
- **Trading Plan**: Target price, stop loss, position %, entry/exit signals
- **Risk Assessment**: Risk score, status badge (pass/revise/reject), reasoning
- **Debate Rounds**: Side-by-side bull (green border) vs bear (red border) claims
- Hidden for quick mode analyses

### View 4 — Detail Modal: Audit Traces (tab)

- Table: call index, phase badge, role, model, tokens, cost, duration, verdict
- Click row → expand to show system prompt excerpt + LLM response excerpt
- Phase badges color-coded: analyst=purple, portfolio=blue, debate=yellow, trader=green, risk=red

## API Endpoints

### `GET /api/reports`
Scans report directory recursively for `*_quick.json` and `*_full.json` files. Returns array of report summaries.

### `GET /api/reports/:ticker/:date_:mode.json`
Returns the full report JSON.

### `GET /api/reports/:ticker/:date_:mode/:path*`
Returns detail files (e.g., `01_analysts/market.json`, `02_debate/round_1.json`).

### `GET /api/traces/:runId`
Scans trace directory for files matching the run_id, returns array of trace objects.

## Data Sources

- **Reports**: Read from `config.report_dir` (default `~/.openclaw/trading-reports/`)
- **Traces**: Read from `~/.openclaw/traces/` (structured by `ticker_date/trace_*.json`)
- **Detail files**: Subdirectory under report dir (e.g., `600519/2026-06-05_full/01_analysts/market.json`)

## CLI Integration

New entry in `package.json` bin + new command:

```
node dist/dashboard.js [--port 3210] [--report-dir ./trading-reports]
```

Options:
- `--port` — HTTP port (default: 3210)
- `--report-dir` — Override report directory

## Color Coding

| Value | Color | Hex |
|-------|-------|-----|
| Buy / 看多 | Green | #4ade80 |
| Hold / 中性 | Yellow | #fbbf24 |
| Sell / 看空 | Red | #f87171 |
| Overweight | Green | #4ade80 |
| Underweight | Red | #f87171 |
| pass | Green | #4ade80 |
| revise | Yellow | #fbbf24 |
| reject | Red | #f87171 |

## File Structure

```
src/
  dashboard.ts        — CLI + HTTP server
  dashboard-api.ts    — API route handlers
dashboard/
  index.html          — Single-file SPA (CSS + JS embedded)
```

No new npm dependencies required.
