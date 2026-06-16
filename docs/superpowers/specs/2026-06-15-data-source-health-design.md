# 数据源健康追踪器（Data Source Health Tracker）

**Status**: Design
**Date**: 2026-06-15
**Author**: Claude + kangjinghang
**Scope**: 全量 7 个数据脚本 × ~22 个子源
**Depends on**: `record_error` 基础设施（commit `d3e5d34`）、`ScriptResult.errors` 字段（同 commit）

---

## 1. 目标与范围

### 1.1 问题陈述

当前数据源观测散落在三处且不互通：

1. **Python 层**：`record_error` 在 hot_money（5 处）+ fundamentals（1 处）记录失败，但 news/policy 用独立字段 `macro_news_source`，kline/sentiment/lockup 完全不记录
2. **TS 层**：`ScriptResult.errors` 字段已定义、exec-python 已透传，但 **orchestrator 完全不消费它**——收集了不用
3. **跨 run**：每个 run 的 `pipeline_health` 是独立瞬态，看不到"macro_news 连续失败 7 天"这种趋势

用户痛点：
- 数据源失效（如 CLS 404）只能事后看 raw json 才知道
- 限流（如 push2 IP-ban）不可见，连续多次跑都中招才察觉
- 没有"全局掌握"，每个 ticker 的报告独立看，难发现系统性失效

### 1.2 核心目标

| 目标 | 描述 |
|---|---|
| **实时观测** | 运行中数据源失败立刻推到 `pipeline_health`，report.json 第一眼可见 |
| **跨 run 历史视图** | 单文件 `_source-health.json` 记录每个 source 最近 20 次调用，CLI + dashboard 可查 |
| **主动预警（基础版）** | 不预设阈值，留原始统计让用户自行判断（"全部都要"的"主动"部分留 hook，后期可加阈值触发） |

### 1.3 范围与决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 作用域 | 全量 7 脚本 × ~22 子源 | 用户选 |
| 降级策略 | **只观测不控制** | 零误判风险，避免"失效 vs 限流"分类难题 |
| 阈值 | 不预设，留原始统计 | 用户选；避免误报 |
| 载体 | 全局文件 + CLI + dashboard 三管齐下 | 用户选 |
| 文件位置 | `~/.openclaw/trading-reports/_source-health.json` | 跟报告同根，备份/迁移方便 |
| CLI 形式 | npm script（`npm run source-health`） | 用户选；不走 openclaw.tool 注册 |
| 数据字段 | `_calls`（含成功+失败）为主，`_errors`（只失败）向后兼容 | 统计成功率需要成功样本 |

### 1.4 非目标（Out of Scope）

- 自动跳过失效源 / 限流时降并发 —— 需"失效判定"逻辑，与"只观测不控制"矛盾，留待后续
- 自动分类失败原因（4xx/5xx/timeout/parse）—— 留待后续增量
- 启动时预警注入（`source-health.json` 连续失败 → 当前 run 加 warn）—— 需阈值决策，留待后续
- 跨 run 成本统计 —— 由 `traceLogger.totalCostUsd` 单独路径负责

---

## 2. 架构概览

### 2.1 五大组件

```
┌─────────────────────────────────────────────────────────────────┐
│  Python 层 (7 脚本 × 多子源)                                    │
│  ─ 新增 record_call(stage, success, error?, duration_ms?)       │
│  ─ 每个子源调用后显式 record_call (无论成功失败)                 │
│  ─ output_json 输出顶层 _calls 数组                              │
└──────────────────────┬──────────────────────────────────────────┘
                       │ JSON stdout
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  TS 接线层 (exec-python.ts + orchestrator.ts)                   │
│  ─ exec-python: 透传 raw._calls → result.calls                  │
│  ─ orchestrator: 收集所有 result.calls, 分两路派发               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
   ┌──────────────────┐  ┌──────────────────────────────────┐
   │  本 run 视图      │  │  跨 run 持久化                    │
   │  health.add({...})│  │  SourceHealthStore                │
│  → pipeline_      │  │  → ~/.openclaw/trading-reports/   │
   │    health         │  │    _source-health.json            │
   │  → report.json    │  │  (环形 buffer 最近 20 次/source)   │
   └──────────────────┘  └────────────┬─────────────────────┘
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                   ┌─────────────┐         ┌─────────────┐
                   │  CLI 工具    │         │  dashboard   │
                   │  npm run    │         │  "数据源健康" │
                   │  source-    │         │  表格块       │
                   │  health     │         │              │
                   └─────────────┘         └─────────────┘
```

### 2.2 端到端数据流（举例：688163 quick 模式，hot_money 子源部分失败）

```
1. Python: hot_money.py 调用 5 个子源
   - northbound: success=True, 1200ms  → record_call("hot_money/northbound", True, 1200)
   - fund_flow: success=False, 5000ms → record_call("hot_money/fund_flow", False, 5000, "rate_limited")
   - sector_fund_flow: success=False → record_call("hot_money/sector_fund_flow", False, ..., "rate_limited")
   - hot_stocks: success=True → record_call(...)
   - dragon_tiger: success=True → record_call(...)

2. output_json 把 5 个 calls 输出到顶层 _calls 数组

3. exec-python 解析 → result.calls = [...5 items]

4. orchestrator:
   - 对每个失败 call: health.add({stage:"data_collection", check:"source_call_failed",
                                   context:{source:"hot_money/fund_flow", error:"rate_limited"}})
     → 进入本 run 的 pipeline_health, 持久化到 report.json
   - SourceHealthStore.appendCalls(result.calls, ticker, runId, timestamp)
     → 读 source-health.json, 把 5 个 calls 追加到对应 source 的环形 buffer (cap 20),
       更新 last_success/last_error/total_calls/total_success, 写回文件

5. CLI: npm run source-health
   → SourceHealthStore.read() → 表格输出

6. dashboard: detail tab 顶部"数据源健康"块, 读 source-health.json, 渲染表格 + 行展开
```

---

## 3. Python 层改动

### 3.1 子源梳理

| 脚本 | 子源（stage 名） | 已有 record_error |
|---|---|---|
| kline.py | `kline/mootdx` `kline/akshare` | ❌ |
| fundamentals.py | `fundamentals/tencent` `fundamentals/mootdx` `fundamentals/em_datacenter` `fundamentals/akshare` `fundamentals/consensus` `fundamentals/quarterly` | 1 处（akshare） |
| news.py | `news/stock_em` `news/macro_cls` `news/macro_akshare` | ❌（用 macro_news_source） |
| policy.py | `policy/stock_em` `policy/macro_cls` `policy/macro_akshare` | ❌（用 macro_news_source） |
| sentiment.py | `sentiment/hot_rank` `sentiment/zt_pool` | ❌ |
| hot_money.py | `hot_money/northbound` `hot_money/fund_flow` `hot_money/hot_stocks` `hot_money/dragon_tiger` `hot_money/sector_fund_flow` | Yes, 5 处 |
| lockup.py | `lockup/ann_em` `lockup/reduce_em` | ❌ |

**总计 ~22 个子源，~38 处 record_call 接入点**（机械改动）。

### 3.2 `record_call` API 设计（`skills/_shared/http_helpers.py`）

```python
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
    """Backward-compatible alias: records a failed call."""
    record_call(stage, success=False, error=msg)
```

### 3.3 标准接入模式

```python
def _fetch_northbound():
    start = time.monotonic()
    try:
        result = em_get(...)
        record_call("hot_money/northbound", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        return result
    except Exception as e:
        record_call("hot_money/northbound", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return None
```

**注意**：用 `time.monotonic()` 而非 `time.time()`（不受系统时钟跳变影响）。

### 3.4 `output_json` 改动（向后兼容）

```python
def output_json(success, data=None, error=None, source=None):
    payload = {"success": success}
    if data is not None: payload["data"] = data
    if error: payload["error"] = error
    if source: payload["source"] = source
    # NEW: _calls contains all per-source results (success + failure)
    if _CALLS:
        payload["_calls"] = list(_CALLS)
        # BACKWARD COMPAT: _errors is the failure-only view (existing TS
        # code reads result.errors; new code reads result.calls).
        failed = [c for c in _CALLS if not c["success"]]
        if failed:
            payload["_errors"] = [
                {"stage": c["stage"], "error": c["error"]} for c in failed
            ]
    print(json.dumps(payload, ensure_ascii=False))
```

### 3.5 news.py / policy.py 的 macro_news_source 字段处理

**保留**——它表达"最终选了哪个源"，与 `_calls` 表达"每个源试过没有"互补：

```python
# news.py 的 macro 段保持现状 + 补 record_call
try:
    articles = _fetch_global_news_cls()
    if articles:
        record_call("news/macro_cls", success=True, duration_ms=...)
        return articles, "cls"
except Exception as e:
    record_call("news/macro_cls", success=False, error=str(e), duration_ms=...)

# fallback akshare
try:
    articles = _fetch_global_news_akshare()
    if articles:
        record_call("news/macro_akshare", success=True, duration_ms=...)
        return articles, "akshare"
except Exception as e:
    record_call("news/macro_akshare", success=False, error=str(e), duration_ms=...)
    return [], "none"
```

---

## 4. TS 接线层 + source-health.json 数据结构

### 4.1 类型扩展（`src/types.ts`）

```typescript
export interface ScriptResult {
  success: boolean;
  data?: unknown;
  error?: string;
  source?: string;
  errors?: Array<{ stage: string; error: string }>;  // 保留（向后兼容）
  calls?: Array<SourceCall>;                           // 新增（主字段）
}

export interface SourceCall {
  stage: string;            // "hot_money/northbound"
  success: boolean;
  error?: string | null;
  duration_ms?: number | null;
}
```

### 4.2 `source-health.json` 数据结构

```json
{
  "version": 1,
  "updated_at": "2026-06-15T10:30:00.000Z",
  "sources": {
    "kline/mootdx": {
      "history": [
        {
          "ts": "2026-06-15T10:30:00.000Z",
          "ticker": "688163",
          "run_id": "run-abc123",
          "success": true,
          "duration_ms": 1200,
          "error": null
        }
      ],
      "stats": {
        "total_calls": 20,
        "total_success": 18,
        "success_rate": 0.9,
        "last_success_ts": "2026-06-15T10:30:00.000Z",
        "last_error_ts": "2026-06-15T09:15:00.000Z",
        "last_error": "timeout",
        "avg_duration_ms": 1100
      }
    }
  }
}
```

**关键设计决策**：
- `stats` 是 `history`（最近 20 次）的派生视图，**不是绝对累计**——用于看"最近趋势"
- 硬 cap 20/source ≈ 文件最大 ~50KB（22 sources × 20 records × ~120 字节）
- `version: 1` 为未来 schema 演进留 migration hook

### 4.3 新文件 `src/source-health-store.ts`

```typescript
import * as fs from "fs";
import * as path from "path";

const BUFFER_SIZE = 20;
const SCHEMA_VERSION = 1;

export interface SourceCallRecord {
  ts: string;
  ticker: string;
  run_id: string;
  success: boolean;
  duration_ms?: number | null;
  error?: string | null;
}

export interface SourceStats {
  total_calls: number;
  total_success: number;
  success_rate: number;       // 0-1
  last_success_ts: string | null;
  last_error_ts: string | null;
  last_error: string | null;
  avg_duration_ms: number | null;
}

export interface SourceHealthEntry {
  history: SourceCallRecord[];
  stats: SourceStats;
}

export interface SourceHealthFile {
  version: number;
  updated_at: string;
  sources: Record<string, SourceHealthEntry>;
}

/** Pure function: derive stats from history. Exported for testability. */
export function computeStats(history: SourceCallRecord[]): SourceStats {
  if (history.length === 0) {
    return { total_calls: 0, total_success: 0, success_rate: 0,
             last_success_ts: null, last_error_ts: null,
             last_error: null, avg_duration_ms: null };
  }
  const successes = history.filter(h => h.success);
  const failures = history.filter(h => !h.success);
  const durations = history
    .map(h => h.duration_ms)
    .filter((d): d is number => typeof d === "number");
  return {
    total_calls: history.length,
    total_success: successes.length,
    success_rate: successes.length / history.length,
    last_success_ts: successes.at(-1)?.ts ?? null,
    last_error_ts: failures.at(-1)?.ts ?? null,
    last_error: failures.at(-1)?.error ?? null,
    avg_duration_ms: durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
  };
}

export class SourceHealthStore {
  private readonly filePath: string;

  constructor(reportDir: string) {
    this.filePath = path.join(reportDir, "_source-health.json");
  }

  /** Read health file. Returns empty state on missing/corrupt (never throws). */
  read(): SourceHealthFile {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === SCHEMA_VERSION && parsed.sources) return parsed;
    } catch { /* missing or corrupt — fall through */ }
    return { version: SCHEMA_VERSION, updated_at: "", sources: {} };
  }

  /** Append per-source calls from one run, then write atomically. */
  appendCalls(
    calls: Array<{ stage: string; success: boolean;
                  error?: string | null; duration_ms?: number | null }>,
    ticker: string,
    runId: string,
    timestamp: string = new Date().toISOString(),
  ): void {
    if (calls.length === 0) return;
    const state = this.read();
    for (const call of calls) {
      const entry = state.sources[call.stage] ?? { history: [], stats: computeStats([]) };
      entry.history.push({
        ts: timestamp, ticker, run_id: runId,
        success: call.success,
        duration_ms: call.duration_ms ?? null,
        error: call.error ?? null,
      });
      if (entry.history.length > BUFFER_SIZE) {
        entry.history = entry.history.slice(-BUFFER_SIZE);
      }
      entry.stats = computeStats(entry.history);
      state.sources[call.stage] = entry;
    }
    state.updated_at = timestamp;
    this.write(state);
  }

  /** Atomic write (tmp + rename, same pattern as report-store). */
  private write(state: SourceHealthFile): void {
    const tmp = this.filePath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[source-health] write failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
```

### 4.4 orchestrator.ts 接线（quick + full 两个模式共用）

```typescript
import { SourceHealthStore } from "./source-health-store";

// ...after Promise.all(dataResults) ...
const sourceHealth = new SourceHealthStore(config.report_dir);
const allCalls: Array<{ stage: string; success: boolean;
                       error?: string | null; duration_ms?: number | null }> = [];
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

### 4.5 exec-python.ts 透传（line ~290）

```typescript
if (Array.isArray(raw._errors)) result.errors = raw._errors;
if (Array.isArray(raw._calls)) result.calls = raw._calls;  // NEW
```

### 4.6 零破坏保证

| 保证 | 实现 |
|---|---|
| `record_error` 保留 | 是 `record_call(success=False)` 别名，老调用点不需要改 |
| `ScriptResult.errors` 保留 | exec-python 同时透传 `_calls` + `_errors` |
| `source-health.json` 缺失/损坏不崩 | `read()` try/catch 返回空状态 |
| `appendCalls`/`write` 失败不阻断 pipeline | `write` try/catch 记 console.error |

---

## 5. CLI + dashboard 观测层

### 5.1 CLI 命令（新文件 `src/source-health-cli.ts`）

```typescript
// src/source-health-cli.ts — Standalone CLI for data source health
//
// Usage:
//   npm run source-health              # 表格输出（默认）
//   npm run source-health -- --json    # JSON 输出（脚本友好）
//   npm run source-health -- --failing # 只看最近有失败的 source
//   REPORT_DIR=/custom/path npm run source-health   # 自定义 report 路径

import * as os from "os";
import * as path from "path";
import { SourceHealthStore } from "./source-health-store";

const DEFAULT_REPORT_DIR = path.join(os.homedir(), ".openclaw", "trading-reports");

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const failingOnly = args.includes("--failing");
  const reportDir = process.env.REPORT_DIR ?? DEFAULT_REPORT_DIR;

  const store = new SourceHealthStore(reportDir);
  const state = store.read();

  if (asJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  const sources = Object.entries(state.sources);
  if (sources.length === 0) {
    console.log("No data source health records yet. Run trading_quick/full first.");
    return;
  }

  // Sort: failing first, then by success_rate ascending
  const sorted = sources
    .filter(([_, e]) => !failingOnly || e.stats.success_rate < 1)
    .sort(([aName, a], [bName, b]) => {
      const aFail = a.stats.success_rate < 1 ? 0 : 1;
      const bFail = b.stats.success_rate < 1 ? 0 : 1;
      if (aFail !== bFail) return aFail - bFail;
      if (a.stats.success_rate !== b.stats.success_rate)
        return a.stats.success_rate - b.stats.success_rate;
      return aName.localeCompare(bName);
    });

  console.log(`\n📊 数据源健康（最近 N 次调用/source）`);
  console.log(`   路径: ${path.join(reportDir, "_source-health.json")}`);
  console.log(`   更新: ${state.updated_at || "(never)"}\n`);
  console.log("SOURCE                    SUCCESS       LAST_ERR          LAST_CALL");
  console.log("-".repeat(80));

  for (const [name, entry] of sorted) {
    const s = entry.stats;
    const succ = `${s.total_success}/${s.total_calls}`;
    const rate = `(${(s.success_rate * 100).toFixed(0)}%)`;
    const lastErr = (s.last_error || "-").slice(0, 18);
    const lastTs = s.last_success_ts ?? s.last_error_ts;
    const lastCall = lastTs ? formatRelative(lastTs) : "(never)";
    const indicator = s.success_rate < 1 ? "! " : "  ";
    console.log(
      `${indicator}${name.padEnd(26)}${succ.padEnd(7)}${rate.padStart(7)}  ` +
      `${lastErr.padEnd(18)}${lastCall.padStart(12)}`
    );
  }
}

function formatRelative(isoTs: string): string {
  const min = Math.floor((Date.now() - new Date(isoTs).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

main();
```

**package.json 加 script**：

```json
"source-health": "node dist/source-health-cli.js"
```

### 5.2 示例输出

```
📊 数据源健康（最近 N 次调用/source）
   路径: ~/.openclaw/trading-reports/_source-health.json
   更新: 2026-06-15T10:30:00.000Z

SOURCE                    SUCCESS       LAST_ERR          LAST_CALL
--------------------------------------------------------------------------------
! hot_money/fund_flow       8/20  (40%)  rate_limit        2m ago
! hot_money/sector_fund_flow 7/20  (35%)  rate_limit        2m ago
! news/macro_cls            0/20   (0%)  404 not_found     5d ago
  kline/mootdx             20/20 (100%)  -                 2m ago
  kline/akshare             19/20  (95%)  timeout           1h ago
  hot_money/northbound     20/20 (100%)  -                 2m ago
  ...
```

### 5.3 dashboard 改动

#### `dashboard-api.ts` 新增 API

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

#### HTTP 路由

加一条路由 `/api/source-health`，调 `readSourceHealth(reportDir)` 返回 JSON。前端 fetch 后渲染。

#### `dashboard/index.html` 新增"数据源健康"卡片

放在 **detail tab 顶部**（quality gate 卡片之前——它更"meta"，跟单 ticker 无关）：

- 表格：SOURCE / SUCCESS / LAST_ERR / LAST_CALL
- 失败的 source 红色高亮
- 行可展开看 history 最近 20 条

实现：vanilla JS + template literals（与现有 dashboard 风格一致）。

---

## 6. 错误处理 + 测试矩阵

### 6.1 错误处理矩阵

| 失败点 | 模式 | 处理 |
|---|---|---|
| Python: record_call 在 except 里调 | 二次异常 | 内部 try/except 包住，丢弃 record 但不抛 |
| Python: stage 字符串过长 | truncate 到 60 字符 | 不抛 |
| Python: output_json 时 `_CALLS` 已被并发改 | `list(_CALLS)` 复制 | 安全 |
| TS: `raw._calls` 不是数组 | `Array.isArray` 检查 | 不透传，result.calls undefined |
| TS: source-health.json 损坏/缺失 | `read()` try/catch | 返回空状态 |
| TS: source-health.json 写失败（磁盘满/权限） | `write()` try/catch | `console.error`，**不阻断 pipeline** |
| TS: `appendCalls` calls 数组为空 | 提前 `return` | 不读不写 |
| CLI: report_dir 不存在 | `read()` 返回空 | 打印 "No records yet" |
| CLI: source.stats 字段缺失（旧版本） | `?? null` 兜底 | 不崩 |
| dashboard: readSourceHealth 失败 | try/catch 返回 null | 前端显示"暂无数据"块 |

**核心不变量**：数据源健康机制**永不阻断 pipeline**——最坏情况是"看不到统计"，不是"分析跑不完"。

### 6.2 集成测试场景

| # | 场景 | mock 输入 | 期望结果 |
|---|---|---|---|
| 1 | Python→TS→source-health.json 单次写入 | mock 脚本返回 `{success:true, _calls:[{stage:"test/src", success:true, duration_ms:100}]}` | `_source-health.json` 写入，sources 含 `test/src`，history=1 |
| 2 | 跨 run 累积 | 跑两次（不同 ticker），同 source 都失败 | history=2，stats.success_rate=0 |
| 3 | 环形 buffer FIFO | 跑 25 次同 source | history.length=20（丢老的），stats 反映最近 20 次 |
| 4 | 向后兼容（errors only） | Python 脚本只输出 `_errors`（没 _calls） | orchestrator fallback 到 errors，source-health.json 仍记录 |
| 5 | pipeline_health 推送 | 含失败 calls 的 run | report.json 的 pipeline_health 含 `{check:"source_call_failed", severity:"warn"}` |

### 6.3 单元测试矩阵

| 模块 | 文件 | 覆盖 |
|---|---|---|
| Python http_helpers | `tests/scripts/test_http_helpers.py`（扩） | record_call success/failure、duration_ms、record_error 别名、output_json 输出 _calls、向后兼容 _errors |
| TS SourceHealthStore | **`tests/ts/source-health-store.test.ts`（新）** | `computeStats` 纯函数（空/单条/多条/全失败/全成功）、`appendCalls` 累积、环形 buffer cap=20、`read` missing/corrupt、`write` 失败不抛 |
| TS exec-python | `tests/ts/exec-python.test.ts`（扩） | 加 _calls 透传 |
| TS orchestrator | `tests/ts/integration.test.ts`（扩） | 端到端：calls → pipeline_health + source-health.json |
| TS dashboard-api | `tests/ts/dashboard.test.ts`（扩） | `readSourceHealth` missing/corrupt 返回 null |

### 6.4 测试 fixture（`tests/fixtures/source-health/`）

| 文件 | 用途 |
|---|---|
| `empty.json` | `{sources:{}}`，测空状态 |
| `single-source.json` | 1 source × 5 records，测累积 |
| `full-buffer.json` | 1 source × 20 records，测边界 |
| `overflow-input.json` | 25 records 用于 FIFO 测试 |
| `corrupt.json` | 故意损坏，测 read 容错 |

### 6.5 不写自动化测试的项

| 项 | 理由 |
|---|---|
| dashboard 前端渲染（vanilla JS） | 现有惯例：手验，无 DOM harness |
| CLI 表格输出 | ANSI/格式断言 ROI 低；`--json` 模式可测 |
| 实际数据源 mock（push2/akshare/...） | 依赖外网，CI 不稳；靠 record_call 单测覆盖 |

---

## 7. 实施 order（TDD，按依赖关系）

```
1. Python 层（http_helpers record_call + output_json + 7 脚本接入）
   └ 分批 commit：1 个脚本 1 个 commit
   └ 每批跑 test_http_helpers.py 验证
   └ ~38 处接入点，按脚本顺序：kline → fundamentals → news → policy →
      sentiment → hot_money（已有 5 处 record_error，改成 record_call 双记）→ lockup

2. TS 类型 + exec-python 透传 _calls（小改动）
   └ 单测验证 _calls 透传 + _errors 仍工作

3. SourceHealthStore 类（独立模块）
   └ 完整单元测试（computeStats、appendCalls、环形 buffer、read/write 容错）

4. orchestrator 接线（read result.calls → 推 pipeline_health + appendCalls）
   └ integration test 验证端到端
   └ 同时改 quick + full 模式

5. CLI + dashboard-api + dashboard 块
   └ CLI 用 --json 测试 + 手验表格
   └ dashboard 手验

6. 真实跑一次验证
   └ trading_quick 688163 → npm run source-health → 看输出
   └ 跑 2-3 个 ticker 后看跨 run 累积是否符合预期
```

### 7.1 风险点 + 应对

| 风险 | 概率 | 应对 |
|---|---|---|
| 7 脚本接入工作量大（~38 处） | 高 | 分批 commit：每脚本 1 commit + 跑测试 |
| `_source-health.json` 并发写冲突 | 低 | orchestrator 单进程，无并发写；exec-python 子进程不写文件 |
| 子源命名不一致（`/` vs `.` vs `:`） | 中 | Python 单测验证 stage 格式 |
| duration_ms 计算偏差 | 低 | Python 用 `time.monotonic()`；TS 端不做时序 |
| 现有测试断言 output_json 形状 | 中 | `_calls` 是 additive，不破坏现有形状 |

---

## 8. 未来扩展（非本次范围）

| 扩展 | 何时做 | 入口点 |
|---|---|---|
| 自动失败分类（4xx/5xx/timeout/parse） | 当原始 error 文本不足以判断时 | 在 `record_call` 加 `category` 字段 |
| 启动时预警注入 | 当用户决定阈值时 | orchestrator 开头读 source-health.json，连续失败 N 次推 warn |
| 自动跳过失效源 | 当"只观测不控制"不够时 | source-health.json 加 `skip_until` 字段，orchestrator 跳过 |
| 绝对累计 stats（不只最近 20 次） | 当需要长趋势时 | 加 `lifetime_stats` 字段，appendCalls 时更新 |
| ↳ **已实现（替代方案）**：2026-06-16 通过 ring buffer 扩容（`BUFFER_SIZE` 20→2000，覆盖 1+ 年）+ 读时 `parsePeriod`/`filterHistorySince` 过滤实现，未引入 `lifetime_stats` 按日聚合。CLI 加 `--period 3d\|7d\|30d\|1y\|all`，dashboard 加周期下拉。保留了 error/duration_ms 细粒度，schema v1 不变（无 migration）。详见 `docs/data-sources.zh.md` 数据源健康监控章节。 |
| macro_news 多源 fallback | 单独项目 | 加新浪/东财要闻源，按 `_calls` 数据驱动 fallback |

---

## 9. 验收标准

实施完成后，以下都成立：

1. 跑 `trading_quick 688163`，`_source-health.json` 在 `~/.openclaw/trading-reports/` 创建/更新
2. `npm run source-health` 输出表格，列出所有 ~22 个子源的成功率
3. dashboard detail tab 顶部出现"数据源健康"块
4. 故意把某 Python 脚本的某子源改坏（如改 URL 为 404），跑一次后表格显示该 source `!` 标记
5. 跑 25 次同 ticker，某 source 的 history.length 仍然是 20（FIFO 生效）
6. 删除 `_source-health.json`，再跑一次，文件重新创建
7. 删除 Python 脚本里的 record_call 调用（保留旧 record_error），orchestrator fallback 到 errors 仍能记录
8. 所有现有测试（399 TS + 64 Python）仍通过
9. 新增单测 + 集成测试全过
10. pipeline_health 在 source 失败时含 `source_call_failed` warn
