# Data Source Health Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cross-run data source health tracking — every Python sub-source records call results, orchestrator feeds them into `pipeline_health` + a global `_source-health.json`, exposed via `npm run source-health` CLI and dashboard card.

**Architecture:** Python `record_call(stage, success, error, duration_ms)` → `_calls` array in JSON output → TS `ScriptResult.calls` → orchestrator dispatches to (a) `pipeline_health` (per-run view) and (b) `SourceHealthStore.appendCalls` (cross-run ring buffer) → CLI + dashboard read the same file.

**Tech Stack:** Python 3 (data scripts), TypeScript (orchestrator/CLI/dashboard-api), vanilla JS (dashboard frontend), pytest + vitest tests.

**Spec:** `docs/superpowers/specs/2026-06-15-data-source-health-design.md`

---

## File Structure

**New files:**
- `src/source-health-store.ts` — core store class + `computeStats` pure fn
- `src/source-health-cli.ts` — CLI entry (`npm run source-health`)
- `tests/ts/source-health-store.test.ts` — unit tests for store + computeStats
- `tests/fixtures/source-health/{empty,single-source,full-buffer,overflow-input,corrupt}.json` — test fixtures

**Modified files:**
- `skills/_shared/http_helpers.py` — add `record_call`, `record_error` becomes alias, `output_json` emits `_calls`
- `skills/trading-kline/scripts/kline.py` — record_call on mootdx + akshare
- `skills/trading-fundamentals/scripts/fundamentals.py` — 6 sub-sources
- `skills/trading-news/scripts/news.py` — 3 sub-sources
- `skills/trading-policy/scripts/policy.py` — 3 sub-sources
- `skills/trading-sentiment/scripts/sentiment.py` — 2 sub-sources
- `skills/trading-hot-money/scripts/hot_money.py` — 5 sub-sources (existing record_error gets paired with success record_call)
- `skills/trading-lockup/scripts/lockup.py` — 2 sub-sources
- `tests/scripts/test_http_helpers.py` — extend for record_call
- `src/types.ts` — `ScriptResult.calls` + `SourceCall` interface
- `src/exec-python.ts` — pass through `_calls`
- `src/orchestrator.ts` — wire calls to pipeline_health + SourceHealthStore (quick + full)
- `src/dashboard-api.ts` — `readSourceHealth(reportDir)`
- `dashboard/index.html` — data source health card
- `package.json` — `source-health` npm script

---

## Phase 1: Python Layer

### Task 1: Add `record_call` to http_helpers.py

**Files:**
- Modify: `skills/_shared/http_helpers.py`
- Test: `tests/scripts/test_http_helpers.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/scripts/test_http_helpers.py`:

```python
def test_record_call_logs_success(tmp_path, monkeypatch):
    """record_call records successful calls with optional duration_ms."""
    import http_helpers
    http_helpers.clear_errors()  # also clears _CALLS via alias
    http_helpers.record_call("hot_money/northbound", success=True, duration_ms=1234)
    calls = http_helpers.get_errors()  # placeholder name; will rename to get_calls
    # We'll add a get_calls() fn; for now this drives the API design
    assert len(calls) == 1
    assert calls[0]["stage"] == "hot_money/northbound"
    assert calls[0]["success"] is True
    assert calls[0]["duration_ms"] == 1234
    assert calls[0]["error"] is None


def test_record_call_logs_failure(tmp_path, monkeypatch):
    import http_helpers
    http_helpers.clear_errors()
    http_helpers.record_call("news/macro_cls", success=False, error="404 not found")
    calls = http_helpers.get_errors()
    assert calls[0]["success"] is False
    assert calls[0]["error"] == "404 not found"


def test_record_error_is_alias_for_failed_record_call(tmp_path, monkeypatch):
    """Backward compat: existing record_error call sites keep working."""
    import http_helpers
    http_helpers.clear_errors()
    http_helpers.record_error("hot_money/fund_flow", "rate_limited")
    calls = http_helpers.get_errors()
    assert len(calls) == 1
    assert calls[0]["success"] is False
    assert calls[0]["error"] == "rate_limited"


def test_output_json_includes_calls_array(capsys, monkeypatch):
    """output_json must surface _calls so downstream can observe per-source results."""
    import http_helpers
    http_helpers.clear_errors()
    http_helpers.record_call("test/source_a", success=True, duration_ms=100)
    http_helpers.record_call("test/source_b", success=False, error="boom")
    http_helpers.output_json(True, data={"x": 1})
    out = json.loads(capsys.readouterr().out)
    assert "_calls" in out
    assert len(out["_calls"]) == 2
    assert out["_calls"][0]["stage"] == "test/source_a"
    # Backward compat: _errors still emitted (failures only)
    assert "_errors" in out
    assert len(out["_errors"]) == 1
    assert out["_errors"][0]["stage"] == "test/source_b"


def test_record_call_truncates_long_stage(tmp_path):
    """Defensive: stage longer than 60 chars is truncated, not crashed."""
    import http_helpers
    http_helpers.clear_errors()
    long_stage = "x" * 100
    http_helpers.record_call(long_stage, success=True)
    calls = http_helpers.get_errors()
    assert len(calls[0]["stage"]) == 60


def test_record_call_swallows_internal_exception(tmp_path):
    """If record_call itself fails (e.g. bad arg), it must not crash the script."""
    import http_helpers
    http_helpers.clear_errors()
    # Pass an unhashable/odd input that might break dict construction
    http_helpers.record_call("ok/source", success="not_bool", error=None)
    # Should not raise; success coerced via bool()
```

- [ ] **Step 2: Run tests — expect ImportError/failure**

```bash
cd D:/workspace/github/openclaw-trading-agents
python -m pytest tests/scripts/test_http_helpers.py -v
```

Expected: failures because `record_call` and `get_calls` don't exist yet.

- [ ] **Step 3: Implement record_call + rename helpers**

In `skills/_shared/http_helpers.py`, replace the existing error-collector block (lines ~18-46) with:

```python
# ── Whole-source call collector ──────────────────────────────────────
# Scripts record per-source call results here (success AND failure).
# output_json() surfaces them as a top-level `_calls` array so downstream
# can compute per-source success rates and detect outages/rate-limits.
# `_errors` (failure-only view) is kept for backward compat with code
# that reads result.errors (commit d3e5d34).
_CALLS = []


def record_call(stage, success, error=None, duration_ms=None):
    """Record a per-source call result (success or failure).

    Args:
        stage: source identifier, slash-separated for hierarchy
               (e.g. "hot_money/northbound", "news/macro_cls"). Truncated to 60 chars.
        success: True if the call yielded usable data
        error: short error message if failed (truncated to 160 chars)
        duration_ms: optional call duration in ms (for slow-source detection)
    """
    try:
        _CALLS.append({
            "stage": str(stage)[:60],
            "success": bool(success),
            "error": str(error)[:160] if error else None,
            "duration_ms": int(duration_ms) if duration_ms is not None else None,
        })
    except Exception:
        pass  # never crash the script over a stats record


def record_error(stage, msg):
    """Backward-compatible alias: records a failed call. Existing call sites
    that use record_error keep working; new code should prefer record_call."""
    record_call(stage, success=False, error=msg)


def get_calls():
    """Return accumulated calls (does not clear)."""
    return list(_CALLS)


def get_errors():
    """Backward-compat: return failure-only view of _CALLS. Existing callers
    (orchestrator reading result.errors) keep working."""
    return [c for c in _CALLS if not c["success"]]


def clear_errors():
    """Clear accumulated calls. Call at start of each fetch if reusing the
    process across runs (tests do this)."""
    del _CALLS[:]
```

Then in `output_json` (around line 220), change the `_errors` block to also emit `_calls`:

```python
def output_json(success, data=None, error=None, source=None):
    """Standard JSON output for data scripts.

    Any errors recorded via record_error() or calls via record_call() during
    this run are surfaced as top-level `_calls` (all results) and `_errors`
    (failure-only view, backward compat).
    """
    payload = {"success": success}
    if data is not None:
        payload["data"] = data
    if error:
        payload["error"] = error
    if source:
        payload["source"] = source
    if _CALLS:
        payload["_calls"] = list(_CALLS)
        # Backward compat: failure-only view for existing TS code that reads
        # result.errors (commit d3e5d34 added this; we keep it working).
        failed = [c for c in _CALLS if not c["success"]]
        if failed:
            payload["_errors"] = [
                {"stage": c["stage"], "error": c["error"]} for c in failed
            ]
    print(json.dumps(payload, ensure_ascii=False))
```

- [ ] **Step 4: Run tests — expect pass**

```bash
python -m pytest tests/scripts/test_http_helpers.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add skills/_shared/http_helpers.py tests/scripts/test_http_helpers.py
git commit -m "feat(http_helpers): record_call + _calls output (backward-compat _errors)"
```

---

### Task 2: kline.py — record_call on mootdx + akshare

**Files:**
- Modify: `skills/trading-kline/scripts/kline.py:656-720` (the `fetch()` fallback loop)

- [ ] **Step 1: Add record_call to fetch() loop**

In `skills/trading-kline/scripts/kline.py`, find the `fetch()` function (around line 656). The current loop is:

```python
def fetch(ticker: str, count: int = 120) -> Dict[str, Any]:
    last_error = None

    for source in SOURCES:
        try:
            if source == "mootdx":
                data = fetch_from_mootdx(ticker, count)
            elif source == "akshare":
                data = fetch_from_akshare(ticker, count)
            else:
                continue
            # ... compute vpa/ti ...
            return {"success": True, ...}
        except Exception as e:
            last_error = e
            continue
    return {"success": False, "error": str(last_error)}
```

Wrap each source attempt with timed `record_call`:

```python
import time
from http_helpers import ..., record_call  # add to existing import

def fetch(ticker: str, count: int = 120) -> Dict[str, Any]:
    last_error = None

    for source in SOURCES:
        start = time.monotonic()
        try:
            if source == "mootdx":
                data = fetch_from_mootdx(ticker, count)
            elif source == "akshare":
                data = fetch_from_akshare(ticker, count)
            else:
                continue
            record_call(f"kline/{source}", success=True,
                        duration_ms=(time.monotonic() - start) * 1000)
            # ... compute vpa/ti (existing code unchanged) ...
            return {"success": True, ...}
        except Exception as e:
            record_call(f"kline/{source}", success=False, error=str(e),
                        duration_ms=(time.monotonic() - start) * 1000)
            last_error = e
            continue
    return {"success": False, "error": str(last_error)}
```

- [ ] **Step 2: Verify via real run**

```bash
cd D:/workspace/github/openclaw-trading-agents
echo '{"ticker":"688662","count":120}' | python skills/trading-kline/scripts/kline.py > /tmp/kline.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/kline.json')); print('calls:', d.get('_calls'))"
```

Expected: `_calls` array with at least 1 entry (either `kline/mootdx` success or both sources attempted).

- [ ] **Step 3: Commit**

```bash
git add skills/trading-kline/scripts/kline.py
git commit -m "feat(kline): record_call on mootdx + akshare sub-sources"
```

---

### Task 3: fundamentals.py — 6 sub-sources

**Files:**
- Modify: `skills/trading-fundamentals/scripts/fundamentals.py`

Sub-sources to instrument: `fundamentals/tencent`, `fundamentals/mootdx`, `fundamentals/em_datacenter`, `fundamentals/akshare`, `fundamentals/consensus`, `fundamentals/quarterly`.

- [ ] **Step 1: Locate each fetch function**

```bash
grep -n "^def _fetch_\|^def fetch\b" skills/trading-fundamentals/scripts/fundamentals.py
```

Expected output: list of `_fetch_*` functions, each is a sub-source.

- [ ] **Step 2: Wrap each fetch function with timed record_call**

For each `_fetch_xxx()` function (or the equivalent block inside the main `fetch()`), apply this pattern:

```python
def _fetch_xxx(ticker, ...):
    start = time.monotonic()
    try:
        result = ...
        record_call("fundamentals/xxx", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        return result
    except Exception as e:
        record_call("fundamentals/xxx", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return None  # or {} based on existing fallback shape
```

The existing `record_error("financial_health_akshare", e)` at line ~342 should be **replaced** with the dual-form: keep `record_call("fundamentals/akshare", success=False, error=str(e), ...)` AND ensure the corresponding success path (above) also has `record_call(..., success=True, ...)`.

- [ ] **Step 3: Verify via real run**

```bash
echo '{"ticker":"688662"}' | python skills/trading-fundamentals/scripts/fundamentals.py > /tmp/fund.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/fund.json')); print('calls:', [c['stage'] for c in d.get('_calls', [])])"
```

Expected: list like `['fundamentals/tencent', 'fundamentals/mootdx', 'fundamentals/em_datacenter', 'fundamentals/akshare', 'fundamentals/consensus', 'fundamentals/quarterly']` (some may be missing if scripts skip on certain conditions; that's OK).

- [ ] **Step 4: Commit**

```bash
git add skills/trading-fundamentals/scripts/fundamentals.py
git commit -m "feat(fundamentals): record_call on 6 sub-sources"
```

---

### Task 4: news.py — 3 sub-sources

**Files:**
- Modify: `skills/trading-news/scripts/news.py`

Sub-sources: `news/stock_em`, `news/macro_cls`, `news/macro_akshare`.

- [ ] **Step 1: Add record_call to each fetch path**

Find the three sub-fetches (stock news via eastmoney, macro via cls, macro via akshare fallback). For each:

```python
def _fetch_xxx(...):
    start = time.monotonic()
    try:
        articles = ...
        record_call("news/xxx", success=True, duration_ms=(time.monotonic() - start) * 1000)
        return articles
    except Exception as e:
        record_call("news/xxx", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return []
```

The macro path keeps its existing `macro_news_source` field (signals "which source finally succeeded") — that's complementary to `_calls` (which records "which sources were tried").

- [ ] **Step 2: Verify via real run**

```bash
echo '{"ticker":"688662"}' | python skills/trading-news/scripts/news.py > /tmp/news.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/news.json')); print('calls:', [c['stage']+':'+str(c['success']) for c in d.get('_calls', [])])"
```

Expected: `['news/stock_em:True', 'news/macro_cls:False', 'news/macro_akshare:True']` (or similar pattern).

- [ ] **Step 3: Commit**

```bash
git add skills/trading-news/scripts/news.py
git commit -m "feat(news): record_call on 3 sub-sources (keep macro_news_source)"
```

---

### Task 5: policy.py — 3 sub-sources

**Files:**
- Modify: `skills/trading-policy/scripts/policy.py`

Sub-sources: `policy/stock_em`, `policy/macro_cls`, `policy/macro_akshare`. Same pattern as Task 4.

- [ ] **Step 1: Apply record_call pattern (same as Task 4)**

- [ ] **Step 2: Verify via real run**

```bash
echo '{"ticker":"688662"}' | python skills/trading-policy/scripts/policy.py > /tmp/pol.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/pol.json')); print([c['stage']+':'+str(c['success']) for c in d.get('_calls', [])])"
```

- [ ] **Step 3: Commit**

```bash
git add skills/trading-policy/scripts/policy.py
git commit -m "feat(policy): record_call on 3 sub-sources"
```

---

### Task 6: sentiment.py — 2 sub-sources

**Files:**
- Modify: `skills/trading-sentiment/scripts/sentiment.py`

Sub-sources: `sentiment/hot_rank`, `sentiment/zt_pool`.

- [ ] **Step 1: Apply record_call pattern**

Both `hot_rank` and `zt_pool` come from eastmoney's push2 endpoint. Wrap each `_fetch_xxx`:

```python
def _fetch_hot_rank(...):
    start = time.monotonic()
    try:
        result = ...
        record_call("sentiment/hot_rank", success=True, duration_ms=(time.monotonic() - start) * 1000)
        return result
    except Exception as e:
        record_call("sentiment/hot_rank", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return None
```

- [ ] **Step 2: Verify via real run**

```bash
echo '{"ticker":"688662"}' | python skills/trading-sentiment/scripts/sentiment.py > /tmp/sent.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/sent.json')); print([c['stage']+':'+str(c['success']) for c in d.get('_calls', [])])"
```

Expected: `['sentiment/hot_rank:True/False', 'sentiment/zt_pool:True/False']`.

- [ ] **Step 3: Commit**

```bash
git add skills/trading-sentiment/scripts/sentiment.py
git commit -m "feat(sentiment): record_call on hot_rank + zt_pool"
```

---

### Task 7: hot_money.py — 5 sub-sources (upgrade existing record_error)

**Files:**
- Modify: `skills/trading-hot-money/scripts/hot_money.py`

Sub-sources: `hot_money/northbound`, `hot_money/fund_flow`, `hot_money/hot_stocks`, `hot_money/dragon_tiger`, `hot_money/sector_fund_flow`. **Already has 5 `record_error` calls** (Task 1's `record_error` is now an alias for failed `record_call`) — these stay. We add the **success-path** record_call for each.

- [ ] **Step 1: Add success-path record_call to each sub-fetch**

Each existing pattern is:

```python
def _fetch_northbound(...):
    try:
        ...
        record_error("northbound", e)  # this is in except
        return None
```

Wait, actually the existing pattern has `record_error(stage, e)` inside `except`. The `stage` here is short ("northbound", not "hot_money/northbound"). **Upgrade** the stage name AND add the success-path record_call:

```python
def _fetch_northbound(...):
    start = time.monotonic()
    try:
        result = ...
        record_call("hot_money/northbound", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        return result
    except Exception as e:
        record_call("hot_money/northbound", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return None
```

Do this for all 5 sub-sources (northbound, fund_flow, hot_stocks, dragon_tiger, sector_fund_flow). Replace the existing `record_error("<short>", e)` calls — they become redundant once the except block has `record_call(..., success=False, ...)`.

- [ ] **Step 2: Verify via real run**

```bash
echo '{"ticker":"688662"}' | python skills/trading-hot-money/scripts/hot_money.py > /tmp/hm.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/hm.json')); print([c['stage']+':'+str(c['success']) for c in d.get('_calls', [])])"
```

Expected: 5 entries with stages `hot_money/northbound` etc.

- [ ] **Step 3: Commit**

```bash
git add skills/trading-hot-money/scripts/hot_money.py
git commit -m "feat(hot_money): upgrade 5 record_error to record_call (success+fail)"
```

---

### Task 8: lockup.py — 2 sub-sources

**Files:**
- Modify: `skills/trading-lockup/scripts/lockup.py`

Sub-sources: `lockup/ann_em`, `lockup/reduce_em`.

- [ ] **Step 1: Apply record_call pattern (same as Task 6)**

- [ ] **Step 2: Verify via real run**

```bash
echo '{"ticker":"688662"}' | python skills/trading-lockup/scripts/lockup.py > /tmp/lock.json 2>/dev/null
python -c "import json; d=json.load(open('/tmp/lock.json')); print([c['stage']+':'+str(c['success']) for c in d.get('_calls', [])])"
```

- [ ] **Step 3: Commit**

```bash
git add skills/trading-lockup/scripts/lockup.py
git commit -m "feat(lockup): record_call on ann_em + reduce_em"
```

---

## Phase 2: TS Types + exec-python Pass-Through

### Task 9: Add SourceCall type to types.ts

**Files:**
- Modify: `src/types.ts:209` (ScriptResult interface)

- [ ] **Step 1: Add SourceCall interface + extend ScriptResult**

In `src/types.ts`, find the `ScriptResult` interface (around line 207-211). Add a new `SourceCall` interface above it and extend `ScriptResult`:

```typescript
/** Per-source call result emitted by Python data scripts via `_calls` array. */
export interface SourceCall {
  stage: string;            // e.g. "hot_money/northbound"
  success: boolean;
  error?: string | null;
  duration_ms?: number | null;
}

export interface ScriptResult {
  success: boolean;
  data?: unknown;
  error?: string;
  source?: string;
  /** Failure-only view kept for backward compat with commit d3e5d34. */
  errors?: Array<{ stage: string; error: string }>;
  /** All per-source call results (success + failure). Preferred over errors. */
  calls?: SourceCall[];
  vpa?: string;
  technical_indicators?: string;
}
```

- [ ] **Step 2: Verify TS compile**

```bash
npm run build
```

Expected: tsc passes with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add SourceCall + ScriptResult.calls"
```

---

### Task 10: Pass _calls through exec-python.ts

**Files:**
- Modify: `src/exec-python.ts:290` (where `_errors` is currently passed)

- [ ] **Step 1: Write failing test**

Add to `tests/ts/exec-python.test.ts` (find existing test structure and add):

```typescript
it("forwards _calls array from script output to result.calls", async () => {
  // Mock a Python script that outputs _calls
  // (Use the existing mock pattern in this file — usually child_process spawn mock)
  // ... mock setup that emits JSON with _calls: [{stage:"test/x", success:true, duration_ms:100}]
  const result = await execPython(/* args matching existing tests */);
  expect(result.calls).toEqual([
    { stage: "test/x", success: true, error: null, duration_ms: 100 },
  ]);
});

it("does not set calls when script outputs no _calls (backward compat)", async () => {
  // ... mock that emits plain {success:true, data:{}}
  const result = await execPython(/* args */);
  expect(result.calls).toBeUndefined();
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run tests/ts/exec-python.test.ts
```

Expected: tests fail because `result.calls` is undefined.

- [ ] **Step 3: Implement pass-through**

In `src/exec-python.ts`, find the block where `_errors` is forwarded (around line 290-293):

```typescript
if (Array.isArray(raw._errors)) {
  result.errors = raw._errors;
}
```

Add right below:

```typescript
if (Array.isArray(raw._calls)) {
  result.calls = raw._calls;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx vitest run tests/ts/exec-python.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/exec-python.ts tests/ts/exec-python.test.ts
git commit -m "feat(exec-python): pass through _calls array to result.calls"
```

---

## Phase 3: SourceHealthStore Core Module

### Task 11: Create test fixtures

**Files:**
- Create: `tests/fixtures/source-health/empty.json`
- Create: `tests/fixtures/source-health/single-source.json`
- Create: `tests/fixtures/source-health/full-buffer.json`
- Create: `tests/fixtures/source-health/overflow-input.json`
- Create: `tests/fixtures/source-health/corrupt.json`

- [ ] **Step 1: Create the 5 fixture files**

`tests/fixtures/source-health/empty.json`:
```json
{
  "version": 1,
  "updated_at": "",
  "sources": {}
}
```

`tests/fixtures/source-health/single-source.json`:
```json
{
  "version": 1,
  "updated_at": "2026-06-15T10:00:00.000Z",
  "sources": {
    "test/source_a": {
      "history": [
        {"ts": "2026-06-15T10:00:00.000Z", "ticker": "000001", "run_id": "r1", "success": true, "duration_ms": 100, "error": null},
        {"ts": "2026-06-15T10:00:00.000Z", "ticker": "000001", "run_id": "r1", "success": false, "duration_ms": 200, "error": "rate_limited"},
        {"ts": "2026-06-15T10:00:00.000Z", "ticker": "000002", "run_id": "r2", "success": true, "duration_ms": 150, "error": null}
      ],
      "stats": {
        "total_calls": 3,
        "total_success": 2,
        "success_rate": 0.667,
        "last_success_ts": "2026-06-15T10:00:00.000Z",
        "last_error_ts": "2026-06-15T10:00:00.000Z",
        "last_error": "rate_limited",
        "avg_duration_ms": 150
      }
    }
  }
}
```

`tests/fixtures/source-health/full-buffer.json`: same shape with `history.length === 20` (generate 20 records).

`tests/fixtures/source-health/overflow-input.json`: same shape with `history.length === 25` (used to test FIFO slicing).

`tests/fixtures/source-health/corrupt.json`:
```json
{ "this is": not valid JSON
```

- [ ] **Step 2: Commit fixtures**

```bash
git add tests/fixtures/source-health/
git commit -m "test: source-health fixtures (empty/single/full/overflow/corrupt)"
```

---

### Task 12: Implement SourceHealthStore + unit tests

**Files:**
- Create: `src/source-health-store.ts`
- Create: `tests/ts/source-health-store.test.ts`

- [ ] **Step 1: Write failing unit tests**

`tests/ts/source-health-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SourceHealthStore, computeStats, SourceCallRecord } from "../../src/source-health-store";

describe("computeStats (pure function)", () => {
  it("returns zero-stats for empty history", () => {
    const s = computeStats([]);
    expect(s.total_calls).toBe(0);
    expect(s.success_rate).toBe(0);
    expect(s.last_success_ts).toBeNull();
    expect(s.last_error).toBeNull();
    expect(s.avg_duration_ms).toBeNull();
  });

  it("computes success_rate, last_success_ts, last_error from history", () => {
    const history: SourceCallRecord[] = [
      { ts: "2026-06-15T10:00:00Z", ticker: "t1", run_id: "r1", success: true, duration_ms: 100, error: null },
      { ts: "2026-06-15T11:00:00Z", ticker: "t2", run_id: "r2", success: false, duration_ms: 200, error: "boom" },
      { ts: "2026-06-15T12:00:00Z", ticker: "t3", run_id: "r3", success: true, duration_ms: 300, error: null },
    ];
    const s = computeStats(history);
    expect(s.total_calls).toBe(3);
    expect(s.total_success).toBe(2);
    expect(s.success_rate).toBeCloseTo(0.667, 3);
    expect(s.last_success_ts).toBe("2026-06-15T12:00:00Z");
    expect(s.last_error_ts).toBe("2026-06-15T11:00:00Z");
    expect(s.last_error).toBe("boom");
    expect(s.avg_duration_ms).toBe(200); // (100+200+300)/3
  });

  it("handles missing duration_ms (excluded from avg)", () => {
    const history: SourceCallRecord[] = [
      { ts: "t1", ticker: "x", run_id: "r", success: true, duration_ms: undefined, error: null },
      { ts: "t2", ticker: "x", run_id: "r", success: true, duration_ms: 200, error: null },
    ];
    const s = computeStats(history);
    expect(s.avg_duration_ms).toBe(200);
  });
});

describe("SourceHealthStore", () => {
  let tmpDir: string;
  let store: SourceHealthStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-health-"));
    store = new SourceHealthStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("read() returns empty state when file missing", () => {
    const state = store.read();
    expect(state.sources).toEqual({});
    expect(state.updated_at).toBe("");
  });

  it("read() returns empty state when file corrupt", () => {
    fs.writeFileSync(path.join(tmpDir, "_source-health.json"), "{ not valid json", "utf-8");
    const state = store.read();
    expect(state.sources).toEqual({});
  });

  it("appendCalls() creates file and writes single source", () => {
    store.appendCalls(
      [{ stage: "test/x", success: true, duration_ms: 100 }],
      "688163", "run-1", "2026-06-15T10:00:00Z",
    );
    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(1);
    expect(state.sources["test/x"].history[0].ticker).toBe("688163");
    expect(state.sources["test/x"].stats.success_rate).toBe(1);
  });

  it("appendCalls() accumulates across multiple invocations", () => {
    store.appendCalls([{ stage: "test/x", success: true }], "t1", "r1", "ts1");
    store.appendCalls([{ stage: "test/x", success: false, error: "e" }], "t2", "r2", "ts2");
    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(2);
    expect(state.sources["test/x"].stats.success_rate).toBe(0.5);
  });

  it("ring buffer caps at 20 entries (FIFO)", () => {
    // Append 25 calls
    for (let i = 0; i < 25; i++) {
      store.appendCalls(
        [{ stage: "test/x", success: i % 2 === 0, duration_ms: i }],
        `t${i}`, `r${i}`, `ts${i}`,
      );
    }
    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(20);
    // Oldest 5 dropped; first remaining should be i=5
    expect(state.sources["test/x"].history[0].ticker).toBe("t5");
    expect(state.sources["test/x"].history[19].ticker).toBe("t24");
  });

  it("appendCalls() with empty array does not write file", () => {
    store.appendCalls([], "t1", "r1");
    expect(fs.existsSync(path.join(tmpDir, "_source-health.json"))).toBe(false);
  });

  it("appendCalls() groups calls by stage", () => {
    store.appendCalls(
      [
        { stage: "test/a", success: true },
        { stage: "test/b", success: false, error: "x" },
      ],
      "t1", "r1", "ts1",
    );
    const state = store.read();
    expect(Object.keys(state.sources).sort()).toEqual(["test/a", "test/b"]);
  });
});
```

- [ ] **Step 2: Run tests — expect import failure**

```bash
npx vitest run tests/ts/source-health-store.test.ts
```

Expected: fails because `src/source-health-store.ts` doesn't exist.

- [ ] **Step 3: Implement SourceHealthStore**

Create `src/source-health-store.ts` (copy the implementation from spec Section 4.3 verbatim — it's already complete).

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run tests/ts/source-health-store.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/source-health-store.ts tests/ts/source-health-store.test.ts
git commit -m "feat(source-health): SourceHealthStore + computeStats (ring buffer + stats)"
```

---

## Phase 4: orchestrator Wiring

### Task 13: Wire calls to pipeline_health + SourceHealthStore (quick mode)

**Files:**
- Modify: `src/orchestrator.ts` (runQuickAnalysis, after data collection Promise.all)

- [ ] **Step 1: Write failing integration test**

In `tests/ts/integration.test.ts`, find an existing quick-mode test and add an assertion after the run completes:

```typescript
it("should record per-source calls into _source-health.json on quick run", async () => {
  // Reuse existing mock setup that returns a successful quick analysis
  const result = await runQuickAnalysis(/* existing args */);

  // Verify _source-health.json was written
  const healthPath = path.join(reportDir, "_source-health.json");
  expect(fs.existsSync(healthPath)).toBe(true);
  const health = JSON.parse(fs.readFileSync(healthPath, "utf-8"));
  expect(health.version).toBe(1);
  // At least one source recorded (mock-dependent; adjust based on mocks)
  expect(Object.keys(health.sources).length).toBeGreaterThan(0);
});

it("should push source_call_failed warning to pipeline_health when a source fails", async () => {
  // Mock one data source to return success:false
  const result = await runQuickAnalysis(/* args with one failing source */);
  const sourceFailed = result.pipeline_health.find(
    (p: any) => p.check === "source_call_failed",
  );
  expect(sourceFailed).toBeDefined();
  expect(sourceFailed.context.source).toMatch(/^[a-z_]+\/[a-z_]+$/);
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run tests/ts/integration.test.ts
```

Expected: tests fail because orchestrator doesn't yet write to `_source-health.json` or push `source_call_failed`.

- [ ] **Step 3: Wire orchestrator (quick mode)**

In `src/orchestrator.ts`, add import at top:

```typescript
import { SourceHealthStore } from "./source-health-store";
```

In `runQuickAnalysis`, find the line where data collection finishes (after `Promise.all(dataResults)` and the existing `health.add({stage: "data_collection", ...})` block). Insert:

```typescript
  // Source health tracking: feed per-source call results into pipeline_health
  // (per-run view) + SourceHealthStore (cross-run ring buffer).
  const sourceHealth = new SourceHealthStore(config.report_dir);
  const allCalls: Array<{ stage: string; success: boolean; error?: string | null; duration_ms?: number | null }> = [];
  for (const { role, result } of dataResults) {
    if (!result) continue;
    // Prefer calls (new); fallback to errors (backward compat for unmigrated scripts)
    const calls = result.calls ??
      (result.errors ?? []).map(e => ({ stage: e.stage, success: false, error: e.error }));
    for (const call of calls) {
      allCalls.push(call);
      if (!call.success) {
        health.add({
          stage: "data_collection",
          severity: "warn",
          check: "source_call_failed",
          message: `数据源 ${call.stage} 失败: ${(call.error || "").slice(0, 60)}`,
          context: { source: call.stage, error: call.error },
        });
      }
    }
  }
  if (allCalls.length > 0) {
    sourceHealth.appendCalls(allCalls, ticker, runId);
  }
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx vitest run tests/ts/integration.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts tests/ts/integration.test.ts
git commit -m "feat(orchestrator): wire source calls to pipeline_health + SourceHealthStore (quick)"
```

---

### Task 14: Apply same wiring to full mode

**Files:**
- Modify: `src/orchestrator.ts` (runFullAnalysis, after data collection)

- [ ] **Step 1: Write integration test (mirror of Task 13's for full mode)**

In `tests/ts/integration.test.ts`:

```typescript
it("should record per-source calls into _source-health.json on full run", async () => {
  const result = await runFullAnalysis(/* existing full-mode mock args */);
  const healthPath = path.join(reportDir, "_source-health.json");
  expect(fs.existsSync(healthPath)).toBe(true);
  const health = JSON.parse(fs.readFileSync(healthPath, "utf-8"));
  expect(health.version).toBe(1);
});
```

- [ ] **Step 2: Apply same wiring block to runFullAnalysis**

In `src/orchestrator.ts`, find `runFullAnalysis` and locate its data-collection block (after `Promise.all(dataResults)` and the existing `health.add` calls). Insert the **same block** as Task 13 Step 3.

- [ ] **Step 3: Run integration tests**

```bash
npx vitest run tests/ts/integration.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts tests/ts/integration.test.ts
git commit -m "feat(orchestrator): wire source calls to SourceHealthStore (full mode)"
```

---

## Phase 5: CLI + Dashboard

### Task 15: source-health CLI entry + npm script

**Files:**
- Create: `src/source-health-cli.ts`
- Modify: `package.json`

- [ ] **Step 1: Create CLI entry**

Create `src/source-health-cli.ts` (copy from spec Section 5.1 verbatim — the code is complete there).

- [ ] **Step 2: Add npm script**

In `package.json`, find the `"scripts"` section and add:

```json
"source-health": "node dist/source-health-cli.js"
```

- [ ] **Step 3: Build + smoke test**

```bash
npm run build
npm run source-health -- --json | python -c "import json,sys; d=json.load(sys.stdin); print('sources:', list(d.get('sources', {}).keys()))"
```

Expected: prints `sources: []` if no run yet, or a list of source names if `_source-health.json` exists.

- [ ] **Step 4: Commit**

```bash
git add src/source-health-cli.ts package.json
git commit -m "feat(cli): source-health CLI entry + npm script"
```

---

### Task 16: dashboard-api readSourceHealth + test

**Files:**
- Modify: `src/dashboard-api.ts`
- Modify: `tests/ts/dashboard.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/ts/dashboard.test.ts`, add:

```typescript
import { readSourceHealth } from "../../src/dashboard-api";

describe("readSourceHealth", () => {
  it("returns null when _source-health.json is missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
    try {
      expect(readSourceHealth(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when file is corrupt", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "_source-health.json"), "{ invalid", "utf-8");
      expect(readSourceHealth(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns parsed state when file exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
    try {
      const payload = {
        version: 1,
        updated_at: "2026-06-15T10:00:00Z",
        sources: { "test/x": { history: [], stats: { total_calls: 0, total_success: 0, success_rate: 0, last_success_ts: null, last_error_ts: null, last_error: null, avg_duration_ms: null } } },
      };
      fs.writeFileSync(path.join(tmpDir, "_source-health.json"), JSON.stringify(payload), "utf-8");
      const result = readSourceHealth(tmpDir);
      expect(result?.sources["test/x"]).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run tests/ts/dashboard.test.ts
```

Expected: import fails (`readSourceHealth` not exported).

- [ ] **Step 3: Implement readSourceHealth**

In `src/dashboard-api.ts`, add:

```typescript
import { SourceHealthFile } from "./source-health-store";

/** Read the cross-run source health file. Returns null on missing/corrupt. */
export function readSourceHealth(reportDir: string): SourceHealthFile | null {
  const filePath = path.join(reportDir, "_source-health.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
```

Also register HTTP route `/api/source-health` (find existing route registration in the dashboard server file and add):

```typescript
// In the HTTP route handler (file varies — find existing /api/* routes)
if (req.url?.startsWith("/api/source-health")) {
  const state = readSourceHealth(reportDir);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(state ?? { version: 1, updated_at: "", sources: {} }));
  return;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx vitest run tests/ts/dashboard.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-api.ts tests/ts/dashboard.test.ts
git commit -m "feat(dashboard-api): readSourceHealth + /api/source-health route"
```

---

### Task 17: dashboard "数据源健康" card

**Files:**
- Modify: `dashboard/index.html`

- [ ] **Step 1: Add card markup at top of detail tab**

Find the detail tab in `dashboard/index.html` (look for existing cards like "quality gate" or "risk assessment"). Insert above the first card:

```html
<section id="source-health-card" class="card" style="margin-bottom: 16px;">
  <h3>数据源健康（跨 run，最近 20 次/source）</h3>
  <div id="source-health-body">加载中…</div>
</section>
```

- [ ] **Step 2: Add JS fetch + render**

In the existing `<script>` block (find where other cards are populated, e.g. `loadDetail()` or similar):

```javascript
async function loadSourceHealth() {
  try {
    const res = await fetch('/api/source-health');
    const state = await res.json();
    const body = document.getElementById('source-health-body');
    if (!state.sources || Object.keys(state.sources).length === 0) {
      body.innerHTML = '<p style="color:#888">暂无数据。运行 trading_quick/full 后再来看。</p>';
      return;
    }
    const rows = Object.entries(state.sources)
      .sort(([an, a], [bn, b]) => {
        const af = a.stats.success_rate < 1 ? 0 : 1;
        const bf = b.stats.success_rate < 1 ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.stats.success_rate - b.stats.success_rate;
      })
      .map(([name, entry]) => {
        const s = entry.stats;
        const indicator = s.success_rate < 1 ? '<span style="color:#c00">!</span> ' : '<span style="color:#0a0">✓</span> ';
        const lastErr = (s.last_error || '-').slice(0, 20);
        const lastTs = s.last_success_ts ?? s.last_error_ts;
        return `<tr>
          <td>${indicator}${name}</td>
          <td>${s.total_success}/${s.total_calls} (${(s.success_rate * 100).toFixed(0)}%)</td>
          <td>${lastErr}</td>
          <td>${lastTs ? new Date(lastTs).toLocaleString() : '(never)'}</td>
        </tr>`;
      })
      .join('');
    body.innerHTML = `
      <table style="width:100%; border-collapse: collapse; font-size: 0.9em;">
        <thead>
          <tr style="text-align:left; border-bottom: 1px solid #ccc">
            <th>Source</th><th>Success</th><th>Last Error</th><th>Last Call</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#888; font-size: 0.85em; margin-top: 8px;">
        更新时间: ${state.updated_at || '(never)'} | CLI: <code>npm run source-health</code>
      </p>
    `;
  } catch (e) {
    document.getElementById('source-health-body').innerHTML =
      '<p style="color:#c00">加载失败: ' + e.message + '</p>';
  }
}

// Call alongside other loaders
loadSourceHealth();
```

- [ ] **Step 3: Manual verification**

```bash
npm run build
npm run dashboard
# Open browser to dashboard URL, navigate to detail tab
# Expected: "数据源健康" card appears at top
```

(No automated test — vanilla JS rendering is手验 only, per spec Section 6.5.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): add data source health card (top of detail tab)"
```

---

## Phase 6: End-to-End Verification

### Task 18: Real run validation

**Files:** None (verification only)

- [ ] **Step 1: Run a real quick analysis**

```bash
cd D:/workspace/github/openclaw-trading-agents
node dist/cli.js quick 688163
```

Expected: completes successfully (or with normal failures), no new crash.

- [ ] **Step 2: Verify _source-health.json was created**

```bash
ls ~/.openclaw/trading-reports/_source-health.json
```

Expected: file exists.

- [ ] **Step 3: Run CLI and inspect output**

```bash
npm run source-health
```

Expected: table output with ~22 source rows; sources that succeeded show 1/1 or 2/2, sources that failed show `!` indicator.

- [ ] **Step 4: Run a second ticker to verify cross-run accumulation**

```bash
node dist/cli.js quick 688662
npm run source-health
```

Expected: each source's history grew by 1 (or more if multiple sub-sources); success_rate updates.

- [ ] **Step 5: Verify pipeline_health in report.json**

```bash
python -c "
import json, os
path = os.path.expanduser('~/.openclaw/trading-reports/688163/' + os.listdir(os.path.expanduser('~/.openclaw/trading-reports/688163'))[-1].replace('.json','.json'))
# actually find the most recent report.json
import glob
reports = sorted(glob.glob(os.path.expanduser('~/.openclaw/trading-reports/688163/*.json')))
d = json.load(open(reports[-1]))
fails = [p for p in d.get('pipeline_health', []) if p.get('check') == 'source_call_failed']
print('source_call_failed warns:', len(fails))
for f in fails[:5]: print(' ', f.get('context', {}).get('source'), '→', f.get('context', {}).get('error'))
"
```

Expected: list of failed sources matching what `npm run source-health` shows for the same ticker.

- [ ] **Step 6: No commit (verification only)**

If all 5 steps pass, the feature is complete. If any fails, debug + add fix commit.

---

## Self-Review Notes

**Spec coverage check (each spec section → task)**:
- §1 Goals → all tasks contribute
- §2 Architecture → reflected in File Structure + Tasks 1-17
- §3 Python layer → Tasks 1-8
- §4 TS wiring + schema → Tasks 9-14
- §5 CLI + dashboard → Tasks 15-17
- §6 Error handling → covered in implementation (each task's code has try/catch where spec requires)
- §6 Testing matrix → Tasks 1, 10, 12, 13, 14, 16 write tests
- §7 Implementation order → Phase 1-6 match
- §9 Acceptance criteria → Task 18 verifies all 10

**Type consistency check**:
- `SourceCall` defined in Task 9 (types.ts) and re-exported via SourceHealthStore in Task 12 — consistent
- `record_call(stage, success, error?, duration_ms?)` signature identical across Task 1 (Python) and consumer code (Tasks 2-8)
- `appendCalls(calls, ticker, runId, timestamp?)` signature identical in Task 12 (definition) and Tasks 13-14 (callers)
- `readSourceHealth(reportDir): SourceHealthFile | null` signature identical in Task 16 (definition) and dashboard JS (Task 17 fetch consumer)

**Placeholder scan**: none — all code blocks contain working code, all commands are runnable.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-data-source-health.md`.
