---
name: build-test-dashboard
description: "Build TypeScript, run tests, and optionally restart the local dashboard server. The standard dev cycle after code changes."
---

# Build, Test & Restart Dashboard

The standard development cycle: compile TypeScript, run test suite, optionally restart the local dashboard, and verify it's serving.

## Trigger

User says "重启 dashboard", "build and test", "跑测试", "dev cycle", "build", "test", or after completing code changes that need verification.

## Modes

- **Full mode** (default): Build → Test → Restart Dashboard → Verify
- **Quick mode**: Build → Test only (skip dashboard restart)

Use quick mode when:
- Only verifying code changes without dashboard
- Dashboard is not running or not needed
- User says "build and test", "跑测试", or "verify"

## Procedure

### Step 1: Build

```bash
npm run build 2>&1 | tail -10
```

If build fails, fix TypeScript errors before continuing.

### Step 2: Run tests

```bash
npm test 2>&1 | tail -20
```

Check for failures. All tests must pass before restarting dashboard.

### Step 3: Restart dashboard (Full mode only)

> Skip this step in quick mode. Go directly to Step 4 if dashboard restart is not needed.

Kill any existing dashboard process on port 3210, then start fresh:

```bash
lsof -ti:3210 | xargs kill -9 2>/dev/null; sleep 0.3 && \
  node dist/dashboard.js --port 3210
```

Run this in background.

### Step 4: Verify dashboard is alive

```bash
sleep 1 && curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3210/
```

Expect `HTTP 200`. If not, check the dashboard output logs.

### Step 5: Verify reports API

```bash
curl -s http://localhost:3210/api/reports | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data[:5]:
    print(f'{r[\"ticker\"]} {r[\"id\"]} {r[\"mode\"]}')
"
```

Confirm recent reports are visible.

## Quick Combined Commands

**Full mode (with dashboard restart):**
```bash
npm run build 2>&1 | tail -3 && npm test 2>&1 | tail -5 && \
  lsof -ti:3210 | xargs kill -9 2>/dev/null; sleep 0.3 && \
  node dist/dashboard.js --port 3210
```

**Quick mode (build and test only):**
```bash
npm run build 2>&1 | tail -3 && npm test 2>&1 | tail -5
```

## Dashboard Endpoints

- `GET /` — Dashboard UI
- `GET /api/reports` — List all reports
- `GET /api/reports/:id` — Single report detail
- `GET /api/reports/:id/traces` — LLM call traces

## Port

Default: `3210`. Change with `--port <N>` flag.
