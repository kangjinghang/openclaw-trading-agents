# Data Sources

English | [中文](data-sources.zh.md)

A-share market data sources used by OpenClaw Trading Agents. All sources are free and publicly accessible.

## Overview

| Skill | Data Type | Primary Source | Fallback | Python Dependencies |
|-------|-----------|---------------|----------|-------------------|
| trading-kline | K-line OHLCV | mootdx (TDX TCP 7709) | akshare (Sina HTTP) | `mootdx`, `akshare` |
| trading-fundamentals | PE/PB/ROE/Financials | Tencent Finance / Eastmoney | mootdx F10 | `mootdx`, `akshare` |
| trading-news | Stock news + Macro news | Eastmoney / akshare (global telegrams) | — | `requests`, `akshare` |
| trading-sentiment | Market sentiment | Eastmoney | — | `akshare` |
| trading-policy | Policy events | Eastmoney search / akshare (global telegrams) | — | `requests` |
| trading-hot-money | Northbound/Fund flow/Dragon-Tiger | Eastmoney | akshare | `akshare`, `requests` |
| trading-lockup | Lockup/Insider | Eastmoney / mootdx F10 | akshare | `mootdx`, `akshare` |
| trading-sector | Industry ranking/Concepts | Eastmoney / Baidu | akshare | `akshare`, `requests` |

## Data Source Details

### K-line Data (`trading-kline`)

```python
# Primary: mootdx (TDX TCP protocol, most stable)
from mootdx.quotes import Quotes
client = Quotes.factory(market="std")
df = client.bars(symbol=stock_code, frequency=9, offset=count)

# Fallback: akshare (Sina Finance HTTP)
import akshare as ak
df = ak.stock_zh_a_hist(symbol=stock_code, period="daily", adjust="qfq")
```

### Fundamentals (`trading-fundamentals`)

PE(TTM), PB, total market cap, quarterly financials from Tencent Finance and Eastmoney. Balance sheet / cash flow / income statement from Sina Finance via akshare.

### News (`trading-news`)

- Stock-specific news: Eastmoney search API
- Macro/global news: Eastmoney global telegrams (via akshare `stock_info_global_em`)

### Sentiment (`trading-sentiment`)

Market sentiment indicators from Eastmoney including fear/greed index, market breadth, and sector rotation signals.

### Policy (`trading-policy`)

- Policy events: Eastmoney search API
- Macro telegrams: Eastmoney global telegrams (via akshare `stock_info_global_em`)

### Capital Flow (`trading-hot-money`)

- Northbound capital flow (沪股通/深股通): Eastmoney push2 API
- Individual stock fund flow (主力/散户): Eastmoney
- Dragon-Tiger board (龙虎榜): Eastmoney with seat details

### Lockup (`trading-lockup`)

- Lockup expiry calendar with impact assessment: Eastmoney
- Insider transactions: mootdx F10

### Sector (`trading-sector`)

- Industry ranking (90 sectors with daily performance): Eastmoney `push2` API
- Concept blocks: ~~Baidu Stock~~ (API returns 403 as of 2026-06), Eastmoney `push2` API

> **Note**: `push2.eastmoney.com` uses a traffic manager (load balancer) that may route to different IPs. In some network environments, IPv6 connections are dropped during TLS renegotiation. The shared `http_helpers.py` module forces IPv4 DNS resolution as a mitigation. All scripts handle API failures gracefully — returning empty data instead of crashing.

## Fallback Pattern

Each data script follows a unified fallback structure:

```python
SOURCES = [
    {"name": "eastmoney", "fetch": fetch_from_eastmoney, "priority": 1},
    {"name": "akshare",   "fetch": fetch_from_akshare,   "priority": 2},
]

def fetch(ticker, **params):
    last_error = None
    for source in sorted(SOURCES, key=lambda s: s["priority"]):
        try:
            result = source["fetch"](ticker, **params)
            result["_source"] = source["name"]
            return result
        except Exception as e:
            logger.warning(f"{source['name']} failed: {e}")
            last_error = e
    return {"success": False, "error": f"all sources failed: {last_error}"}
```

## Rate Limiting Notes

- **Eastmoney**: Rate-limited. Scripts use ≥1s interval + random jitter + session reuse.
- **mootdx**: Uses TCP direct connection (not HTTP), more stable.
- **akshare**: Aggregates multiple sources including Eastmoney. Acts as universal fallback.

## Data Source Health Monitoring

Every data script records each call to a sub-source via `http_helpers.record_call(stage, success, error, duration_ms)`, capturing both successes and failures. `output_json()` surfaces the accumulated records as a top-level `_calls` array. The orchestrator collects all `_calls` and dispatches them along two paths:

1. **Per-run view**: failed calls are pushed to `pipeline_health` (with `check: "source_call_failed"`), visible in `report.json.pipeline_health` for that specific run.
2. **Cross-run persistence**: all calls are appended to `~/.openclaw/trading-reports/_source-health.json`, a ring buffer of the last 2000 calls per source (covering 1+ year), with derived stats like `success_rate` / `last_error` / `avg_duration_ms`. Both the CLI and the dashboard support period filtering (3d / 7d / 30d / 1y / all); stats are recomputed read-time via `filterHistorySince` — no per-day aggregation needed to observe long-term stability.

Backward compatibility: `record_error(stage, msg)` is an alias for `record_call(stage, success=False, error=msg)`; existing call sites keep working. `output_json` emits both `_errors` (failure-only, legacy shape) and `_calls` (full records, new shape).

### Stage Naming Convention

Format: `<role>/<sub_source>` (slash-separated for hierarchical aggregation — e.g. `hot_money/*` gives the overall hot_money health). 21 sub-sources total:

| Role | Sub-source stages | Primary / Fallback |
|---|---|---|
| `kline` | `kline/mootdx`, `kline/akshare` | mootdx primary → akshare fallback |
| `fundamentals` | `fundamentals/tencent`, `fundamentals/mootdx`, `fundamentals/em_datacenter`, `fundamentals/em_quarterly`, `fundamentals/em_consensus`, `fundamentals/akshare` | Multi-source assembly; `em_datacenter` is the sole source for industry/name |
| `news` | `news/stock_em`, `news/macro_akshare` | macro: eastmoney global telegrams (akshare) single source |
| `policy` | `policy/stock_em`, `policy/macro_akshare` | Same as news |
| `sentiment` | `sentiment/hot_rank`, `sentiment/zt_pool` | Both Eastmoney |
| `hot_money` | `hot_money/northbound`, `hot_money/fund_flow`, `hot_money/hot_stocks`, `hot_money/dragon_tiger`, `hot_money/sector_fund_flow` | All Eastmoney; `fund_flow` and `sector_fund_flow` are most exposed to push2 rate-limiting |
| `lockup` | `lockup/ann_em`, `lockup/reduce_em` | Both Eastmoney |

### Observation Surfaces (3 ways)

**1. CLI (recommended for daily use)**:
```bash
npm run source-health                            # Table output (default, all history, failing sources first)
npm run source-health -- --period 7d             # Last 7 days only (also: 3d / 30d / 90d / 1y / all)
npm run source-health -- --period=30d            # Equals-sign form (equivalent to space form)
npm run source-health -- --json                  # JSON output (script-friendly)
npm run source-health -- --json --period 30d     # JSON + period filter (top-level includes period: {filter, since})
npm run source-health -- --failing               # Only sources with recent failures
npm run source-health -- --failing --period 30d  # Failing filter + period filter
REPORT_DIR=/custom/path npm run source-health    # Custom report path
```

> **`--period` semantics**: the ring buffer now holds the last 2000 calls per source (~1+ year); omitting `--period` shows the full buffer. Passing `--period 7d` first filters each source's history to `ts >= (now - 7d)` then recomputes stats, so you can observe long-term stability trends (e.g. datacenter vs home-network behavior differences). Sources with 0 calls inside the period display `(no data in period)` instead of `0/0 (0%)` to avoid misreading them as "source doesn't exist".

**2. Dashboard**: "Data source health" card at the top of the detail tab. Sources with failures are flagged with a red `!`, sorted by `success_rate` ascending (worst first). The card title has a period dropdown (All / 1 year / 30 days / 7 days / 3 days); switching it re-renders the table in place (no refetch). Sources with 0 calls in the period show `(no data in period)`.

**3. report.json**: each run's `pipeline_health` array contains `{check: "source_call_failed", context: {source, error}}` warnings for failed sub-sources in that run.

### Design References

- Design spec: `docs/superpowers/specs/2026-06-15-data-source-health-design.md`
- Implementation plan: `docs/superpowers/plans/2026-06-15-data-source-health.md`
- Core module: `src/source-health-store.ts` (`SourceHealthStore` class + `computeStats` pure function)
- Python collector: `skills/_shared/http_helpers.py` (`record_call` / `record_error` / `get_calls`)

## Known Issues (based on _source-health.json cross-run observation, 2026-06)

> The issues below come from real-run `_source-health.json` data + the `stability-audit.zh.md` report. Failed sources **do not block the pipeline** — scripts return empty data, analysis continues; monitoring makes failures visible and diagnosable.

| Issue | Affected sub-sources (stage names) | Symptoms (observed) | Mitigation |
|-------|-----------------------------------|---------------------|------------|
| `akshare` module not installed (some environments) | `news/macro_akshare`, `policy/macro_akshare`, `fundamentals/akshare`, `sentiment/hot_rank`, `sentiment/zt_pool` | "No module named 'akshare'"; multiple sub-sources at 0/N | `pip install akshare>=1.15`; missing module starves downstream analysts of macro/zt_pool data |
| `push2.eastmoney.com` IP rate-limiting (Connection aborted) | `hot_money/fund_flow`, `hot_money/sector_fund_flow` | Intermittent failures; same IP banned for ~15min+ | `http_helpers.py` forces IPv4 + ≥1s throttle; fundamentals industry now uses `datacenter-web.eastmoney.com` (not subject to push2 rate-limit); hot_money scripts degrade gracefully via try/except |
| `push2.eastmoney.com` IPv6 TLS reset | `trading-sector` (separate skill, not yet health-tracked) | Industry ranking may return empty | Same: IPv4 forced |
| Baidu Stock `getrelatedblock` API returns 403 | `trading-sector` (separate skill) | Concept blocks return `null` | No fallback; data omitted |
| `zt_pool` no data on non-trading days (expected behavior) | `sentiment/zt_pool` | Weekends/holidays 0/N | Auto-falls-back to most recent trading day; if even that data is too stale, the call still fails until next trading day |
| `financial_health` akshare sub-source unstable | `fundamentals/akshare`, `fundamentals/akshare_internal` | Intermittent failures (depends on akshare financial-report endpoint) | Degrades to None; analyst prompt requires `[数据缺失: financial_health]` sentinel (commit `a8d033b`) |

All scripts wrap API calls in `try/except` and return `{"success": true, "data": {...}}` with empty arrays for failed sub-sources. The analysis pipeline continues even when individual data sources are unavailable. `_source-health.json` makes failures visible — run `npm run source-health` for a one-line global status check.

## Diagnostic Workflow (investigating a data source failure)

1. Run `npm run source-health -- --failing` to see which sources failed recently
2. Inspect each failing source's `last_error` field to identify the cause
3. Match against the "Known Issues" table above to find the right mitigation
4. If it's a new issue (not in the table), inspect the full history in `_source-health.json` (CLI with `--json`)
   - For long-term trends (e.g. datacenter vs home-network differences), add `--period 30d` or `--period 1y` for a wider window
5. After a fix, run `trading_quick` again, then `source-health` to verify the source's `success_rate` recovers
