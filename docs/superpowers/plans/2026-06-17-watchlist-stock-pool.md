# 股票池自动维护实现计划（雪球异动驱动）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建一个分层解耦的数据管道，每日扫描全市场 A 股的雪球异动数据，存原始快照、对比出 diff、生成候选股清单。

**Architecture:** 四层管道（universe 清单 → raw 快照 → diff 发现 → 候选排序）。第 0、1 层是 Python 采集脚本（复用 `skills/_shared/http_helpers.py`），第 2、3 层是 TS 加工 CLI（复用 `source-health-store.ts` 的原子写）。层间用 JSON 文件解耦，每层留原始数据、可独立重跑。

**Tech Stack:** Python 3.11+（requests, argparse）、TypeScript（Node fs, 已有 vitest 测试基建）、雪球 `abnormal/reasons.json` API、东方财富 `push2 clist` API。

**Spec:** `docs/superpowers/specs/2026-06-17-watchlist-stock-pool-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `skills/watchlist/scripts/scan_universe.py` | 第 0 层：东财 clist 分页拉沪深全量，去重 + symbol 转换 |
| `skills/watchlist/scripts/snapshot.py` | 第 1 层：并发扫雪球，每股存完整异动历史 |
| `skills/watchlist/SKILL.md` | watchlist skill 说明 |
| `src/watchlist/diff.ts` | 第 2 层：快照对比核心逻辑（纯函数，可测） |
| `src/watchlist/atomic-json.ts` | 原子写 JSON 工具（tmp + rename） |
| `src/watchlist/types.ts` | watchlist 相关 TS 类型 |
| `src/diff-cli.ts` | 第 2 层 CLI 入口 |
| `src/watchlist/candidates.ts` | 第 3 层：趋势排序核心逻辑（纯函数，可测） |
| `src/candidates-cli.ts` | 第 3 层 CLI 入口 |
| `src/scan-all-cli.ts` | 串跑 0→1→2→3 的 CLI 入口 |
| `tests/ts/watchlist/diff.test.ts` | diff 逻辑测试 |
| `tests/ts/watchlist/candidates.test.ts` | 候选排序测试 |
| `tests/ts/watchlist/atomic-json.test.ts` | 原子写测试 |
| `tests/scripts/test_scan_universe.py` | universe 去重 + symbol 转换测试 |
| `tests/scripts/test_snapshot.py` | snapshot 单股解析 + 并发逻辑测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `package.json` | 加 5 个 scripts（scan-universe/snapshot/diff/candidates/scan-all） |
| `openclaw.plugin.json` | skills 数组加 `./skills/watchlist` |

---

## Task 1: 原子写 JSON 工具（TS）

**Files:**
- Create: `src/watchlist/atomic-json.ts`
- Test: `tests/ts/watchlist/atomic-json.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ts/watchlist/atomic-json.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeAtomicJson } from "../../src/watchlist/atomic-json";

describe("writeAtomicJson", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes JSON file with given content", () => {
    const fp = path.join(tmpDir, "out.json");
    writeAtomicJson(fp, { a: 1, b: "x" });
    const read = JSON.parse(fs.readFileSync(fp, "utf-8"));
    expect(read).toEqual({ a: 1, b: "x" });
  });

  it("leaves no .tmp file behind on success", () => {
    const fp = path.join(tmpDir, "out.json");
    writeAtomicJson(fp, { a: 1 });
    expect(fs.existsSync(fp + ".tmp")).toBe(false);
  });

  it("creates parent directories if missing", () => {
    const fp = path.join(tmpDir, "nested", "deep", "out.json");
    writeAtomicJson(fp, { a: 1 });
    expect(JSON.parse(fs.readFileSync(fp, "utf-8"))).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ts/watchlist/atomic-json.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写最小实现**

```typescript
// src/watchlist/atomic-json.ts
import * as fs from "fs";
import * as path from "path";

/**
 * Atomically write JSON to `filePath` via tmp + rename. Mirrors the pattern in
 * source-health-store.ts / report-store.ts — a crash mid-write leaves the old
 * file (or no file) rather than a truncated one. Creates parent dirs.
 */
export function writeAtomicJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ts/watchlist/atomic-json.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/watchlist/atomic-json.ts tests/ts/watchlist/atomic-json.test.ts
git commit -m "feat(watchlist): atomic JSON writer (tmp+rename)"
```

---

## Task 2: watchlist TS 类型定义

**Files:**
- Create: `src/watchlist/types.ts`

- [ ] **Step 1: 写类型定义（无独立测试，靠后续 Task 的消费验证）**

```typescript
// src/watchlist/types.ts

/** 第0层：universe 清单里的单股条目 */
export interface UniverseEntry {
  code: string;       // 纯数字代码，如 "688146"
  symbol: string;     // 雪球 symbol，如 "SH688146"
  name: string;       // 股票名称
}

/** 第0层：universe.json 结构 */
export interface UniverseFile {
  updated_at: string;     // ISO 时间戳
  source: string;         // 数据源标记
  total: number;
  stocks: UniverseEntry[];
}

/** 第1层：raw 快照里单股的雪球原始数据（原样存，字段都是雪球的） */
export interface RawStockEntry {
  name: string;
  reason_list?: RawReason[];
  range_reason_list?: RawRange[];
  scan_error?: string;    // 扫描失败时存错误信息
}

/** 雪球 reason_list 单元素（天级异动点） */
export interface RawReason {
  description: string;
  timestamp: number;      // 毫秒时间戳，diff 的主键
  reason: string;
  url?: string;
}

/** 雪球 range_reason_list 单元素（区间趋势） */
export interface RawRange {
  begin: number;          // 毫秒时间戳
  end: number;            // 毫秒时间戳
  type: "SHORT" | "LONG";
  percent: number;
  summary: string;
  points: string;
  url?: string;
  title?: string;
}

/** 第1层：raw/{date}.json 结构 */
export interface RawSnapshotFile {
  scan_date: string;      // YYYY-MM-DD
  begin_ms: number;       // 传给雪球的 begin（权威）
  end_ms: number;         // 传给雪球的 end（权威）
  begin_date: string;     // 从 begin_ms 反推（人类可读）
  end_date: string;       // 从 end_ms 反推
  window_months: number;
  scanned: number;
  succeeded: number;
  failed: number;
  stocks: Record<string, RawStockEntry>;  // key = symbol，如 "SH688146"
}

/** 第2层：diff/{date}.json 里单股的变更 */
export interface DiffChange {
  ticker: string;
  name: string;
  new_reason_points: RawReason[];
  new_range_trends: RawRange[];
}

/** 第2层：diff/{date}.json 结构 */
export interface DiffFile {
  scan_date: string;
  baseline: string;       // 基线快照日期
  changes: DiffChange[];
}

/** 第3层：候选清单里的单股 */
export interface CandidateEntry {
  ticker: string;
  name: string;
  top_trend: {
    type: "SHORT" | "LONG";
    percent: number;
    days: number;
    ongoing: boolean;     // end 靠近扫描日
  } | null;               // 无区间趋势时为 null
  new_today: { reasons: number; ranges: number };
}

/** 第3层：derived/{date}-candidates.json 结构 */
export interface CandidatesFile {
  scan_date: string;
  candidates: CandidateEntry[];
}
```

- [ ] **Step 2: 类型检查确认无误**

Run: `npx tsc --noEmit`
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
git add src/watchlist/types.ts
git commit -m "feat(watchlist): TS types for universe/raw/diff/candidates"
```

---

## Task 3: diff 核心逻辑（TS 纯函数）

**Files:**
- Create: `src/watchlist/diff.ts`
- Test: `tests/ts/watchlist/diff.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ts/watchlist/diff.test.ts
import { describe, it, expect } from "vitest";
import { computeDiff } from "../../src/watchlist/diff";
import type { RawSnapshotFile, DiffFile } from "../../src/watchlist/types";

function makeSnapshot(date: string, stocks: Record<string, any>): RawSnapshotFile {
  return {
    scan_date: date, begin_ms: 0, end_ms: 0, begin_date: date, end_date: date,
    window_months: 14, scanned: 0, succeeded: 0, failed: 0, stocks,
  };
}

describe("computeDiff", () => {
  it("finds newly added reason points by timestamp", () => {
    const baseline = makeSnapshot("2026-06-16", {
      "SH688146": { name: "中船特气", reason_list: [{ timestamp: 1000, reason: "old" }] },
    });
    const today = makeSnapshot("2026-06-17", {
      "SH688146": {
        name: "中船特气",
        reason_list: [
          { timestamp: 1000, reason: "old" },
          { timestamp: 2000, reason: "new today" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].new_reason_points).toEqual([{ timestamp: 2000, reason: "new today" }]);
  });

  it("finds newly added range trends by begin+end key", () => {
    const baseline = makeSnapshot("2026-06-16", {
      "SH688146": { name: "中船特气", range_reason_list: [{ begin: 100, end: 200, type: "SHORT", percent: 10, summary: "old", points: "" }] },
    });
    const today = makeSnapshot("2026-06-17", {
      "SH688146": {
        name: "中船特气",
        range_reason_list: [
          { begin: 100, end: 200, type: "SHORT", percent: 12, summary: "old-updated", points: "" },
          { begin: 300, end: 400, type: "LONG", percent: 50, summary: "new", points: "" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].new_range_trends).toEqual([
      { begin: 300, end: 400, type: "LONG", percent: 50, summary: "new", points: "" },
    ]);
  });

  it("does not flag a stock with no changes", () => {
    const baseline = makeSnapshot("2026-06-16", { "SH688146": { name: "x", reason_list: [{ timestamp: 1, reason: "a" }] } });
    const today = makeSnapshot("2026-06-17", { "SH688146": { name: "x", reason_list: [{ timestamp: 1, reason: "a" }] } });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("treats all elements as new when baseline is null (first scan)", () => {
    const today = makeSnapshot("2026-06-17", {
      "SH688146": { name: "中船特气", reason_list: [{ timestamp: 1, reason: "first" }] },
    });
    const diff = computeDiff(today, null);
    expect(diff.changes[0].new_reason_points).toHaveLength(1);
    expect(diff.baseline).toBe("");
  });

  it("skips stocks with scan_error", () => {
    const baseline = makeSnapshot("2026-06-16", {});
    const today = makeSnapshot("2026-06-17", { "SH000001": { name: "x", scan_error: "timeout" } });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("captures stocks present in baseline but missing today as no-change (not deleted)", () => {
    const baseline = makeSnapshot("2026-06-16", { "SH688146": { name: "x", reason_list: [{ timestamp: 1, reason: "a" }] } });
    const today = makeSnapshot("2026-06-17", {});
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ts/watchlist/diff.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// src/watchlist/diff.ts
import type { RawSnapshotFile, DiffFile, DiffChange, RawReason, RawRange } from "./types";

/** range_reason_list 的唯一键：begin+end 组合（区间身份） */
function rangeKey(r: RawRange): string {
  return `${r.begin}-${r.end}`;
}

/**
 * Compute diff between today's snapshot and a baseline snapshot.
 * Returns the set of newly-added reason points and range trends per stock.
 *
 * Diff rule (per spec §5 第2层):
 *   - reason_list: 集合求差，以 timestamp 为主键
 *   - range_reason_list: 集合求差，以 begin+end 组合为主键
 *     （即使雪球更新了某区间的 percent，只要 begin+end 不变就不重复计）
 *
 * @param today 今日快照
 * @param baseline 基线快照；null 表示首次扫描（全部算新增）
 */
export function computeDiff(today: RawSnapshotFile, baseline: RawSnapshotFile | null): DiffFile {
  const changes: DiffChange[] = [];

  for (const [ticker, todayEntry] of Object.entries(today.stocks)) {
    // 跳过扫描失败的股票
    if (todayEntry.scan_error) continue;

    const baselineEntry = baseline?.stocks?.[ticker];

    // ── reason_list diff（timestamp 集合求差）──
    const baselineTs = new Set<number>();
    if (baselineEntry?.reason_list) {
      for (const r of baselineEntry.reason_list) baselineTs.add(r.timestamp);
    }
    const newReasons: RawReason[] = (todayEntry.reason_list ?? []).filter(
      (r) => !baselineTs.has(r.timestamp),
    );

    // ── range_reason_list diff（begin+end 集合求差）──
    const baselineRangeKeys = new Set<string>();
    if (baselineEntry?.range_reason_list) {
      for (const r of baselineEntry.range_reason_list) baselineRangeKeys.add(rangeKey(r));
    }
    const newRanges: RawRange[] = (todayEntry.range_reason_list ?? []).filter(
      (r) => !baselineRangeKeys.has(rangeKey(r)),
    );

    if (newReasons.length > 0 || newRanges.length > 0) {
      changes.push({
        ticker,
        name: todayEntry.name,
        new_reason_points: newReasons,
        new_range_trends: newRanges,
      });
    }
  }

  return {
    scan_date: today.scan_date,
    baseline: baseline?.scan_date ?? "",
    changes,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ts/watchlist/diff.test.ts`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/watchlist/diff.ts tests/ts/watchlist/diff.test.ts
git commit -m "feat(watchlist): diff core logic (set-subtraction by timestamp/begin+end)"
```

---

## Task 4: 候选排序逻辑（TS 纯函数）

**Files:**
- Create: `src/watchlist/candidates.ts`
- Test: `tests/ts/watchlist/candidates.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ts/watchlist/candidates.test.ts
import { describe, it, expect } from "vitest";
import { buildCandidates } from "../../src/watchlist/candidates";
import type { DiffFile } from "../../src/watchlist/types";

function makeDiff(changes: any[]): DiffFile {
  return { scan_date: "2026-06-17", baseline: "2026-06-16", changes };
}

describe("buildCandidates", () => {
  it("sorts by |percent| descending", () => {
    const diff = makeDiff([
      { ticker: "A", name: "a", new_reason_points: [], new_range_trends: [
        { begin: 100, end: 200, type: "SHORT", percent: 10, summary: "", points: "" },
      ]},
      { ticker: "B", name: "b", new_reason_points: [], new_range_trends: [
        { begin: 100, end: 200, type: "LONG", percent: 500, summary: "", points: "" },
      ]},
    ]);
    const cands = buildCandidates(diff, { scan_date: "2026-06-17" } as any);
    expect(cands.candidates[0].ticker).toBe("B");
    expect(cands.candidates[1].ticker).toBe("A");
  });

  it("extracts top_trend from the strongest range in today's snapshot", () => {
    // top_trend 必须取自今日快照（不是 diff），所以传入 rawToday
    const diff = makeDiff([
      { ticker: "SH688146", name: "中船特气", new_reason_points: [{ timestamp: 1, reason: "x", description: "" }], new_range_trends: [] },
    ]);
    const rawToday = {
      scan_date: "2026-06-17",
      stocks: { "SH688146": { name: "中船特气", range_reason_list: [
        { begin: 1, end: 9999999999999, type: "LONG" as const, percent: 756, summary: "", points: "" },
      ]}},
    } as any;
    const cands = buildCandidates(diff, rawToday);
    expect(cands.candidates[0].top_trend).toEqual({
      type: "LONG", percent: 756, days: expect.any(Number), ongoing: true,
    });
  });

  it("counts new_today from diff changes", () => {
    const diff = makeDiff([
      { ticker: "A", name: "a",
        new_reason_points: [{ timestamp: 1 }, { timestamp: 2 }] as any,
        new_range_trends: [{ begin: 1, end: 2 }] as any },
    ]);
    const cands = buildCandidates(diff, { scan_date: "x", stocks: {} } as any);
    expect(cands.candidates[0].new_today).toEqual({ reasons: 2, ranges: 1 });
  });

  it("top_trend null when stock has no ranges", () => {
    const diff = makeDiff([
      { ticker: "A", name: "a", new_reason_points: [{ timestamp: 1 }] as any, new_range_trends: [] },
    ]);
    const cands = buildCandidates(diff, { scan_date: "x", stocks: { "A": { name: "a" } } } as any);
    expect(cands.candidates[0].top_trend).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ts/watchlist/candidates.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// src/watchlist/candidates.ts
import type { DiffFile, RawSnapshotFile, CandidatesFile, CandidateEntry, RawRange } from "./types";

/** 判断区间是否"进行中"：end 在扫描日前后 7 天内 */
function isOngoing(range: RawRange, scanDateMs: number): boolean {
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return Math.abs(range.end - scanDateMs) <= sevenDays;
}

/** 区间跨度天数 */
function rangeDays(range: RawRange): number {
  return Math.round((range.end - range.begin) / (24 * 60 * 60 * 1000));
}

/**
 * 从该股今日的 range_reason_list 选出"最强趋势"：
 * 优先级：ongoing > 已结束，LONG > SHORT，|percent| 大 > 小
 */
function pickTopTrend(ranges: RawRange[] | undefined, scanDateMs: number): CandidateEntry["top_trend"] {
  if (!ranges || ranges.length === 0) return null;
  const scored = ranges.map((r) => ({
    r,
    ongoing: isOngoing(r, scanDateMs) ? 1 : 0,
    typeRank: r.type === "LONG" ? 1 : 0,
    absPct: Math.abs(r.percent),
  }));
  scored.sort((a, b) =>
    b.ongoing - a.ongoing ||
    b.typeRank - a.typeRank ||
    b.absPct - a.absPct,
  );
  const top = scored[0].r;
  return {
    type: top.type,
    percent: top.percent,
    days: rangeDays(top),
    ongoing: isOngoing(top, scanDateMs),
  };
}

/**
 * Build the candidate list from a diff and today's raw snapshot.
 * Sorted by |percent| of top_trend descending.
 *
 * @param diff 第2层 diff 结果
 * @param rawToday 今日 raw 快照（top_trend 取自此处的完整 range 列表）
 */
export function buildCandidates(diff: DiffFile, rawToday: RawSnapshotFile): CandidatesFile {
  // 扫描日 23:59:59 的毫秒时间戳，用于判断 ongoing
  const scanEndMs = Date.parse(rawToday.end_date + "T23:59:59+08:00") || rawToday.end_ms;

  const candidates: CandidateEntry[] = diff.changes.map((change) => {
    const rawEntry = rawToday.stocks[change.ticker];
    const topTrend = pickTopTrend(rawEntry?.range_reason_list, scanEndMs);
    return {
      ticker: change.ticker,
      name: change.name,
      top_trend: topTrend,
      new_today: {
        reasons: change.new_reason_points.length,
        ranges: change.new_range_trends.length,
      },
    };
  });

  // 按 |percent| 降序；无 top_trend 的排最后
  candidates.sort((a, b) => {
    const ap = a.top_trend ? Math.abs(a.top_trend.percent) : -1;
    const bp = b.top_trend ? Math.abs(b.top_trend.percent) : -1;
    return bp - ap;
  });

  return { scan_date: diff.scan_date, candidates };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ts/watchlist/candidates.test.ts`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/watchlist/candidates.ts tests/ts/watchlist/candidates.test.ts
git commit -m "feat(watchlist): candidate ranking by trend strength"
```

---

## Task 5: diff CLI 入口

**Files:**
- Create: `src/diff-cli.ts`

- [ ] **Step 1: 写 CLI**

```typescript
// src/diff-cli.ts
// 第2层 CLI：对比今日快照与基线快照，产出 diff。
//
// Usage:
//   npm run diff                              # 默认今日 vs 最近可用快照
//   npm run diff -- --date 2026-06-17         # 指定扫描日
//   npm run diff -- --baseline 2026-06-15     # 指定基线日
//   WATCHLIST_DIR=/custom/path npm run diff   # 自定义存储路径

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { computeDiff } from "./watchlist/diff";
import { writeAtomicJson } from "./watchlist/atomic-json";
import type { RawSnapshotFile, DiffFile } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function readRaw(date: string, dir: string): RawSnapshotFile | null {
  const fp = path.join(dir, "raw", `${date}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as RawSnapshotFile;
}

/** 找出 raw/ 目录下早于 today 的最近一个快照日期 */
function findLatestBaseline(today: string, dir: string): string | null {
  const rawDir = path.join(dir, "raw");
  if (!fs.existsSync(rawDir)) return null;
  const dates = fs.readdirSync(rawDir)
    .map((f) => f.replace(/\.json$/, ""))
    .filter((d) => d < today)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];

  const baselineIdx = args.indexOf("--baseline");
  const explicitBaseline = baselineIdx >= 0 ? args[baselineIdx + 1] : undefined;

  if (help) {
    console.log(`Usage: npm run diff [-- --date <YYYY-MM-DD>] [-- --baseline <YYYY-MM-DD>]

Options:
  --date <D>        扫描日（默认今天）
  --baseline <D>    基线快照日（默认最近可用）
  --help            显示帮助
  WATCHLIST_DIR     存储路径环境变量（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
    process.exit(0);
  }

  const today = readRaw(date, watchlistDir);
  if (!today) {
    console.error(`error: 今日快照不存在: ${path.join(watchlistDir, "raw", `${date}.json`)}`);
    console.error(`请先运行 npm run snapshot -- --date ${date}`);
    process.exit(1);
  }

  const baselineDate = explicitBaseline ?? findLatestBaseline(date, watchlistDir);
  const baseline = baselineDate ? readRaw(baselineDate, watchlistDir) : null;

  if (explicitBaseline && !baseline) {
    console.error(`error: 指定的基线快照不存在: ${baselineDate}`);
    process.exit(1);
  }

  const diff: DiffFile = computeDiff(today, baseline);
  const outDir = path.join(watchlistDir, "diff");
  const outFile = path.join(outDir, `${date}.json`);
  writeAtomicJson(outFile, diff);

  console.log(`diff 完成: ${date} vs ${baseline?.scan_date ?? "(首次扫描)"}`);
  console.log(`  变更股票数: ${diff.changes.length}`);
  console.log(`  输出: ${outFile}`);

  // 打印前 10 个变更摘要
  if (diff.changes.length > 0) {
    console.log("\n  前 10 个变更:");
    for (const c of diff.changes.slice(0, 10)) {
      const r = c.new_reason_points.length;
      const g = c.new_range_trends.length;
      console.log(`    ${c.ticker} ${c.name}: +${r}异动点, +${g}区间趋势`);
    }
    if (diff.changes.length > 10) console.log(`    ... 还有 ${diff.changes.length - 10} 个`);
  }
}

main();
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
git add src/diff-cli.ts
git commit -m "feat(watchlist): diff CLI entrypoint"
```

---

## Task 6: candidates CLI 入口

**Files:**
- Create: `src/candidates-cli.ts`

- [ ] **Step 1: 写 CLI**

```typescript
// src/candidates-cli.ts
// 第3层 CLI：从 diff + raw 生成候选清单。
//
// Usage:
//   npm run candidates                          # 默认今日
//   npm run candidates -- --date 2026-06-17
//   WATCHLIST_DIR=/custom/path npm run candidates

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { buildCandidates } from "./watchlist/candidates";
import { writeAtomicJson } from "./watchlist/atomic-json";
import type { RawSnapshotFile, DiffFile, CandidatesFile } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function readJson<T>(fp: string): T | null {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
}

function main(): void {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];

  if (help) {
    console.log(`Usage: npm run candidates [-- --date <YYYY-MM-DD>]

Options:
  --date <D>    扫描日（默认今天）
  --help        显示帮助
  WATCHLIST_DIR 存储路径环境变量（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
    process.exit(0);
  }

  const diff = readJson<DiffFile>(path.join(watchlistDir, "diff", `${date}.json`));
  if (!diff) {
    console.error(`error: diff 不存在: ${date}`);
    console.error(`请先运行 npm run diff -- --date ${date}`);
    process.exit(1);
  }

  const rawToday = readJson<RawSnapshotFile>(path.join(watchlistDir, "raw", `${date}.json`));
  if (!rawToday) {
    console.error(`error: 今日快照不存在: ${date}`);
    process.exit(1);
  }

  const candidates: CandidatesFile = buildCandidates(diff, rawToday);
  const outFile = path.join(watchlistDir, "derived", `${date}-candidates.json`);
  writeAtomicJson(outFile, candidates);

  console.log(`候选清单生成: ${date}`);
  console.log(`  候选股数: ${candidates.candidates.length}`);
  console.log(`  输出: ${outFile}`);

  // 打印前 10 个候选
  if (candidates.candidates.length > 0) {
    console.log("\n  前 10 个候选（按趋势强度降序）:");
    for (const c of candidates.candidates.slice(0, 10)) {
      const t = c.top_trend;
      const trendStr = t ? `${t.type} ${t.percent > 0 ? "+" : ""}${t.percent}% (${t.days}d${t.ongoing ? ",进行中" : ""})` : "无区间趋势";
      console.log(`    ${c.ticker} ${c.name}: ${trendStr} | 今日+${c.new_today.reasons}异动 +${c.new_today.ranges}区间`);
    }
  }
}

main();
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
git add src/candidates-cli.ts
git commit -m "feat(watchlist): candidates CLI entrypoint"
```

---

## Task 7: scan_universe.py（第 0 层采集）

**Files:**
- Create: `skills/watchlist/scripts/scan_universe.py`
- Test: `tests/scripts/test_scan_universe.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/scripts/test_scan_universe.py
"""
Tests for scan_universe.py (network-free: pure functions dedupe + symbol conversion).
"""
import sys
from pathlib import Path

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "watchlist" / "scripts"))

from scan_universe import dedupe_stocks, to_xueqiu_symbol  # noqa: E402


def test_to_xueqiu_symbol_shanghai():
    assert to_xueqiu_symbol("600519") == "SH600519"
    assert to_xueqiu_symbol("688146") == "SH688146"


def test_to_xueqiu_symbol_shenzhen():
    assert to_xueqiu_symbol("000001") == "SZ000001"
    assert to_xueqiu_symbol("300750") == "SZ300750"


def test_dedupe_removes_duplicate_codes():
    stocks = [
        {"code": "600519", "name": "贵州茅台", "f13": 1},
        {"code": "600519", "name": "贵州茅台", "f13": 1},  # dup
        {"code": "000001", "name": "平安银行", "f13": 0},
    ]
    result = dedupe_stocks(stocks)
    assert len(result) == 2
    codes = [s["code"] for s in result]
    assert "600519" in codes and "000001" in codes


def test_dedupe_excludes_beijing_exchange():
    # 北交所 8xx / 920xxx 不应出现在结果里（扫描时已用 fs 排除，但去重也做防御）
    stocks = [
        {"code": "600519", "name": "贵州茅台", "f13": 1},
        {"code": "920178", "name": "锐翔智能", "f13": 0},  # 北交所
    ]
    result = dedupe_stocks(stocks)
    codes = [s["code"] for s in result]
    assert "920178" not in codes
    assert len(result) == 1


def test_dedupe_output_has_symbol_field():
    stocks = [{"code": "600519", "name": "贵州茅台", "f13": 1}]
    result = dedupe_stocks(stocks)
    assert result[0]["symbol"] == "SH600519"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/scripts/test_scan_universe.py -v`
Expected: FAIL（ImportError，模块不存在）

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
"""
第0层：全市场 A 股清单刷新。
从东方财富 push2 clist 分页拉取沪深全量（排除北交所），去重，转雪球 symbol。

输出 ~/.openclaw/watchlist/universe.json
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
import http_helpers
from http_helpers import em_get, output_json, record_call


# 沪深全量：深主板 m:0 t:6 / 创业板 m:0 t:80 / 沪主板 m:1 t:2 / 科创板 m:1 t:23
# 不含北交所 m:0 t:81（雪球对北交所次新股无异动数据）
CLIST_FS = "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23"
CLIST_URL = "https://82.push2.eastmoney.com/api/qt/clist/get"
PAGE_SIZE = 100  # 东财硬上限（实测 pz>100 仍只返回 100）


def to_xueqiu_symbol(code: str) -> str:
    """纯数字代码 → 雪球 symbol。6→SH，0/3→SZ（实测 200 样本零误差）。"""
    if code.startswith("6"):
        return "SH" + code
    if code.startswith(("0", "3")):
        return "SZ" + code
    raise ValueError(f"无法识别的代码前缀（应排除北交所）: {code}")


def dedupe_stocks(raw_items: list) -> list:
    """去重并附加 symbol 字段，同时防御性排除北交所。

    raw_items: [{"code": "600519", "name": "...", "f13": 1}, ...]
    东财把股票同时归入多个分类，会产生重复（实测 5863→5533）。
    """
    seen = set()
    result = []
    for it in raw_items:
        code = str(it.get("code", ""))
        # 防御：排除北交所（8xx / 92xxxx），即使 fs 参数漏了
        if code.startswith("8") or code.startswith("92"):
            continue
        if code in seen or not code:
            continue
        seen.add(code)
        try:
            symbol = to_xueqiu_symbol(code)
        except ValueError:
            continue
        result.append({
            "code": code,
            "symbol": symbol,
            "name": str(it.get("name", "")).strip(),
        })
    return result


def fetch_all_pages(max_pages: int = 80) -> list:
    """分页拉取东财 clist 全量。每页 PAGE_SIZE 条，带重试。"""
    all_items = []
    page = 1
    while page <= max_pages:
        params = {
            "pn": str(page), "pz": str(PAGE_SIZE), "po": "1", "np": "1",
            "ut": "bd1d9ddb04089700cf9c27f6f7426752",
            "fltt": "2", "invt": "2", "fid": "f3",
            "fs": CLIST_FS, "fields": "f12,f13,f14",
        }
        start = time.monotonic()
        try:
            r = em_get(CLIST_URL, params=params, timeout=15)
            d = r.json()
        except Exception as e:
            record_call("universe/clist", success=False, error=str(e),
                        duration_ms=(time.monotonic() - start) * 1000)
            raise
        diff = d.get("data", {}).get("diff", []) or []
        total = d.get("data", {}).get("total", 0)
        for it in diff:
            all_items.append({
                "code": str(it.get("f12", "")),
                "name": it.get("f14", ""),
                "f13": it.get("f13"),
            })
        record_call("universe/clist", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        if page * PAGE_SIZE >= total:
            break
        page += 1
        time.sleep(0.2)
    return all_items


def main():
    import argparse
    parser = argparse.ArgumentParser(description="刷新全市场 A 股清单")
    parser.add_argument("--out", default=None, help="输出路径（默认 ~/.openclaw/watchlist/universe.json）")
    args = parser.parse_args()

    default_dir = os.path.expanduser("~/.openclaw/watchlist")
    out_path = args.out or os.path.join(default_dir, "universe.json")

    print(f"[universe] 拉取东财 clist 全量...", file=sys.stderr)
    raw_items = fetch_all_pages()
    print(f"[universe] 原始 {len(raw_items)} 条", file=sys.stderr)

    stocks = dedupe_stocks(raw_items)
    print(f"[universe] 去重后 {len(stocks)} 条", file=sys.stderr)

    # 东八区时间
    tz = timezone(timedelta(hours=8))
    payload = {
        "updated_at": datetime.now(tz).isoformat(timespec="seconds"),
        "source": "eastmoney clist",
        "total": len(stocks),
        "stocks": stocks,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)
    print(f"[universe] 写入 {out_path} ({len(stocks)} 股)", file=sys.stderr)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/scripts/test_scan_universe.py -v`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 手动冒烟测试（真实网络）**

Run: `python skills/watchlist/scripts/scan_universe.py`
Expected: stderr 输出 `去重后 5533 条` 左右，生成 `~/.openclaw/watchlist/universe.json`。

- [ ] **Step 6: 提交**

```bash
git add skills/watchlist/scripts/scan_universe.py tests/scripts/test_scan_universe.py
git commit -m "feat(watchlist): scan_universe.py (eastmoney clist pagination + dedupe)"
```

---

## Task 8: snapshot.py（第 1 层采集）

**Files:**
- Create: `skills/watchlist/scripts/snapshot.py`
- Test: `tests/scripts/test_snapshot.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/scripts/test_snapshot.py
"""
Tests for snapshot.py (network-free: window calc + single-stock parse + diff key).
"""
import sys
from pathlib import Path

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "watchlist" / "scripts"))

from snapshot import compute_window, parse_xueqiu_response  # noqa: E402


def test_compute_window_end_is_today_2359():
    # 扫描日 2026-06-17 → end_ms 应是该日 23:59:59 北京时间
    begin_ms, end_ms, begin_date, end_date = compute_window("2026-06-17")
    assert end_date == "2026-06-17"
    # begin_date 应是约 14 个月前
    assert begin_date < "2025-06-17"
    assert begin_ms < end_ms


def test_compute_window_begin_is_14_months_back():
    # 2026-06-17 减 14 个月 = 2025-04-17 附近
    begin_ms, end_ms, begin_date, end_date = compute_window("2026-06-17")
    # 月份减法：6月 - 14 = 去年4月
    assert begin_date.startswith("2025-04")


def test_parse_xueqiu_response_normal():
    raw = {
        "code": 200,
        "data": {
            "reason_list": [{"timestamp": 1000, "reason": "a", "description": "d"}],
            "range_reason_list": [{"begin": 1, "end": 2, "type": "LONG", "percent": 50, "summary": "s", "points": "p"}],
        },
    }
    result = parse_xueqiu_response(raw)
    assert result["reason_list"] == raw["data"]["reason_list"]
    assert result["range_reason_list"] == raw["data"]["range_reason_list"]


def test_parse_xueqiu_response_empty_lists():
    raw = {"code": 200, "data": {"reason_list": [], "range_reason_list": []}}
    result = parse_xueqiu_response(raw)
    assert result["reason_list"] == []
    assert result["range_reason_list"] == []


def test_parse_xueqiu_response_missing_fields():
    # 雪球某些股可能缺字段
    raw = {"code": 200, "data": {}}
    result = parse_xueqiu_response(raw)
    assert result["reason_list"] == []
    assert result["range_reason_list"] == []
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/scripts/test_snapshot.py -v`
Expected: FAIL（ImportError）

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
"""
第1层：全市场雪球异动快照。
并发扫描 universe.json 里的所有股票，每股存完整 reason_list + range_reason_list。

输出 ~/.openclaw/watchlist/raw/{date}.json
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

XUEQIU_URL = "https://xueqiu.com/rainbow/ai/abnormal/reasons.json"
XUEQIU_COOKIE = "xq_a_token=XqTest6f8800ddb9f1e382c937c39fa0ea7f2c4149a3ea;"
XUEQIU_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
BEIJING_TZ = timezone(timedelta(hours=8))
WINDOW_MONTHS = 14


def compute_window(scan_date: str):
    """计算雪球时间窗口。

    scan_date: "YYYY-MM-DD"
    返回 (begin_ms, end_ms, begin_date, end_date)
    end = scan_date 23:59:59 北京时间
    begin = end 往前推 14 个月（月份对齐，非精确天数）
    """
    end_dt = datetime.strptime(scan_date, "%Y-%m-%d").replace(
        hour=23, minute=59, second=59, tzinfo=BEIJING_TZ)
    end_ms = int(end_dt.timestamp() * 1000)

    # 月份减法：处理跨年
    y, m = int(scan_date[:4]), int(scan_date[5:7])
    m -= WINDOW_MONTHS
    while m <= 0:
        m += 12
        y -= 1
    begin_dt = datetime(y, m, 1, 0, 0, 0, tzinfo=BEIJING_TZ)
    begin_ms = int(begin_dt.timestamp() * 1000)
    begin_date = begin_dt.strftime("%Y-%m-%d")

    return begin_ms, end_ms, begin_date, scan_date


def parse_xueqiu_response(raw: dict) -> dict:
    """从雪球响应提取 reason_list / range_reason_list，缺字段返回空数组。"""
    data = raw.get("data", {}) or {}
    return {
        "reason_list": data.get("reason_list", []) or [],
        "range_reason_list": data.get("range_reason_list", []) or [],
    }


def fetch_one(symbol: str, begin_ms: int, end_ms: int, timeout: int = 15):
    """请求单只股票的雪球异动数据。返回 (symbol, result_dict_or_error)。"""
    start = time.monotonic()
    try:
        r = requests.get(
            XUEQIU_URL,
            params={"symbol": symbol, "begin": begin_ms, "end": end_ms},
            cookies={"xq_a_token": "XqTest6f8800ddb9f1e382c937c39fa0ea7f2c4149a3ea"},
            headers={"user-agent": XUEQIU_UA},
            timeout=timeout,
        )
        r.raise_for_status()
        raw = r.json()
        duration = (time.monotonic() - start) * 1000
        if raw.get("code") != 200:
            return symbol, {"scan_error": f"xueqiu code={raw.get('code')}", "duration_ms": duration}
        parsed = parse_xueqiu_response(raw)
        parsed["duration_ms"] = duration
        return symbol, parsed
    except Exception as e:
        duration = (time.monotonic() - start) * 1000
        return symbol, {"scan_error": f"{type(e).__name__}: {str(e)[:120]}", "duration_ms": duration}


def fetch_one_with_retry(symbol: str, begin_ms: int, end_ms: int):
    """单股 + 重试 1 次（仅网络错误）。"""
    symbol, result = fetch_one(symbol, begin_ms, end_ms)
    if "scan_error" in result:
        # 重试一次
        symbol, result = fetch_one(symbol, begin_ms, end_ms)
    # 去掉 duration_ms（不入快照）
    result.pop("duration_ms", None)
    return symbol, result


def main():
    parser = argparse.ArgumentParser(description="全市场雪球异动快照")
    parser.add_argument("--date", default=None, help="扫描日 YYYY-MM-DD（默认今天）")
    parser.add_argument("--concurrency", type=int, default=3, help="并发数（默认 3，范围 1-5）")
    parser.add_argument("--watchlist-dir", default=None, help="存储目录")
    parser.add_argument("--limit", type=int, default=None, help="只扫前 N 只（调试用）")
    args = parser.parse_args()

    watchlist_dir = args.watchlist_dir or os.path.expanduser("~/.openclaw/watchlist")
    today = args.date or datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    concurrency = max(1, min(5, args.concurrency))

    # 读 universe
    universe_path = os.path.join(watchlist_dir, "universe.json")
    if not os.path.exists(universe_path):
        print(f"error: universe.json 不存在，请先运行 scan_universe", file=sys.stderr)
        sys.exit(1)
    with open(universe_path, encoding="utf-8") as f:
        universe = json.load(f)
    stocks_list = universe["stocks"]
    if args.limit:
        stocks_list = stocks_list[:args.limit]

    total = len(stocks_list)
    begin_ms, end_ms, begin_date, end_date = compute_window(today)
    print(f"[snapshot] 扫描 {total} 股 | 窗口 {begin_date}~{end_date} | 并发 {concurrency}", file=sys.stderr)

    stocks_out = {}
    succeeded = 0
    failed = 0
    completed = 0
    t0 = time.monotonic()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(fetch_one_with_retry, s["symbol"], begin_ms, end_ms): s
            for s in stocks_list
        }
        for future in as_completed(futures):
            stock = futures[future]
            symbol, result = future.result()
            name = stock.get("name", "")
            entry = {"name": name, **result}
            stocks_out[symbol] = entry
            if "scan_error" in result:
                failed += 1
            else:
                succeeded += 1
            completed += 1
            if completed % 100 == 0 or completed == total:
                elapsed = time.monotonic() - t0
                rate = completed / elapsed if elapsed > 0 else 0
                eta = (total - completed) / rate if rate > 0 else 0
                print(f"[snapshot] {completed}/{total} (成功 {succeeded}, 失败 {failed}) "
                      f"| {elapsed:.0f}s 已用, ~{eta:.0f}s 剩余", file=sys.stderr)

    payload = {
        "scan_date": today,
        "begin_ms": begin_ms,
        "end_ms": end_ms,
        "begin_date": begin_date,
        "end_date": end_date,
        "window_months": WINDOW_MONTHS,
        "scanned": total,
        "succeeded": succeeded,
        "failed": failed,
        "stocks": stocks_out,
    }

    raw_dir = os.path.join(watchlist_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    out_path = os.path.join(raw_dir, f"{today}.json")
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(f"[snapshot] 写入 {out_path} (成功 {succeeded}/{total})", file=sys.stderr)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/scripts/test_snapshot.py -v`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 手动冒烟测试（小样本真实网络）**

Run: `python skills/watchlist/scripts/snapshot.py --limit 5 --date 2026-06-17`
Expected: 扫描 5 股，生成 `~/.openclaw/watchlist/raw/2026-06-17.json`，其中 SH688146 应有非空 reason_list。

- [ ] **Step 6: 提交**

```bash
git add skills/watchlist/scripts/snapshot.py tests/scripts/test_snapshot.py
git commit -m "feat(watchlist): snapshot.py (concurrent xueqiu scan + retry)"
```

---

## Task 9: scan-all 串跑 CLI

**Files:**
- Create: `src/scan-all-cli.ts`

- [ ] **Step 1: 写 CLI**

```typescript
// src/scan-all-cli.ts
// 串跑第0→1→2→3层全流程。
//
// Usage:
//   npm run scan-all                              # 默认今天，并发 3
//   npm run scan-all -- --date 2026-06-17 --concurrency 5

import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as fs from "fs";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
const PROJECT_ROOT = path.resolve(__dirname, "..");

function resolvePython(): string {
  return process.env.TRADING_PYTHON || "python3";
}

function runPython(script: string, extraArgs: string[], watchlistDir: string) {
  const scriptPath = path.join(PROJECT_ROOT, "skills", "watchlist", "scripts", script);
  const args = [scriptPath, "--watchlist-dir", watchlistDir, ...extraArgs];
  console.log(`\n▶ python ${script} ${extraArgs.join(" ")}`);
  execFileSync(resolvePython(), args, { stdio: "inherit", env: process.env });
}

function runNode(script: string, extraArgs: string[], watchlistDir: string) {
  const scriptPath = path.join(PROJECT_ROOT, "dist", script);
  if (!fs.existsSync(scriptPath)) {
    console.error(`error: ${scriptPath} 不存在，请先 npm run build`);
    process.exit(1);
  }
  const args = [scriptPath, ...extraArgs];
  console.log(`\n▶ node ${script} ${extraArgs.join(" ")}`);
  execFileSync("node", args, {
    stdio: "inherit",
    env: { ...process.env, WATCHLIST_DIR: watchlistDir },
  });
}

function main() {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];
  const concIdx = args.indexOf("--concurrency");
  const concurrency = concIdx >= 0 && args[concIdx + 1] ? args[concIdx + 1] : "3";

  if (help) {
    console.log(`Usage: npm run scan-all [-- --date <D> --concurrency <N>]

串跑全流程：universe → snapshot → diff → candidates
  --date <D>          扫描日（默认今天）
  --concurrency <N>   snapshot 并发（默认 3）
  WATCHLIST_DIR       存储路径（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
    process.exit(0);
  }

  const pyArgs = (a: string[]) => a;
  const dateArgs = ["--date", date];

  runPython("scan_universe.py", ["--watchlist-dir", watchlistDir], watchlistDir);
  runPython("snapshot.py", ["--watchlist-dir", watchlistDir, "--date", date, "--concurrency", concurrency], watchlistDir);
  runNode("diff-cli.js", ["--date", date], watchlistDir);
  runNode("candidates-cli.js", ["--date", date], watchlistDir);

  console.log(`\n✓ 全流程完成: ${date}`);
  console.log(`  候选清单: ${path.join(watchlistDir, "derived", `${date}-candidates.json`)}`);
}

main();
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `npm run build`
Expected: 无报错，生成 `dist/*.js`

- [ ] **Step 3: 提交**

```bash
git add src/scan-all-cli.ts
git commit -m "feat(watchlist): scan-all CLI (串跑 0→1→2→3)"
```

---

## Task 10: package.json + openclaw.plugin.json 注册

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`
- Create: `skills/watchlist/SKILL.md`

- [ ] **Step 1: 在 package.json 加 scripts**

在 `package.json` 的 `scripts` 块里，`"source-health"` 行之后加入：

```json
    "scan-universe": "python skills/watchlist/scripts/scan_universe.py",
    "snapshot": "python skills/watchlist/scripts/snapshot.py",
    "diff": "node dist/diff-cli.js",
    "candidates": "node dist/candidates-cli.js",
    "scan-all": "node dist/scan-all-cli.js",
```

- [ ] **Step 2: 在 openclaw.plugin.json 注册 skill**

在 `openclaw.plugin.json` 的 `skills` 数组末尾加入：

```json
    "./skills/watchlist"
```

- [ ] **Step 3: 写 SKILL.md**

```markdown
# Watchlist 股票池

每日扫描全市场 A 股的雪球异动数据，自动发现候选股。

## 数据流

```
universe (东财清单) → raw 雪球快照 → diff 新增异动 → candidates 候选清单
```

详见 `docs/superpowers/specs/2026-06-17-watchlist-stock-pool-design.md`。

## 脚本

| 脚本 | 作用 |
|------|------|
| `scan_universe.py` | 东财 clist 全市场清单（去重 + symbol 转换） |
| `snapshot.py` | 雪球异动并发扫描（滚动 14 个月窗口） |

## 用法

```bash
npm run scan-universe          # 刷新清单
npm run snapshot -- --date 2026-06-17
npm run diff -- --date 2026-06-17
npm run candidates -- --date 2026-06-17
npm run scan-all -- --date 2026-06-17   # 一键全流程
```
```

- [ ] **Step 4: 验证 build + 命令可用**

Run: `npm run build && npm run diff -- --help`
Expected: 构建无报错；diff --help 输出用法。

- [ ] **Step 5: 提交**

```bash
git add package.json openclaw.plugin.json skills/watchlist/SKILL.md
git commit -m "feat(watchlist): register CLI scripts + plugin skill"
```

---

## Task 11: 端到端验证

**Files:** 无（纯验证）

- [ ] **Step 1: 跑全部单元测试**

Run: `npm test && python -m pytest tests/scripts/ -v`
Expected: 所有 TS 和 Python 测试通过。

- [ ] **Step 2: 类型检查 + lint**

Run: `npm run build && npm run lint && npx tsc --noEmit`
Expected: 全部通过。

- [ ] **Step 3: 端到端冒烟（小样本）**

Run:
```bash
npm run scan-universe
python skills/watchlist/scripts/snapshot.py --limit 20 --date 2026-06-17
npm run diff -- --date 2026-06-17
npm run candidates -- --date 2026-06-17
```
Expected:
- universe.json 含 ~5533 股
- raw/2026-06-17.json 含 20 股快照
- diff/2026-06-17.json 生成（首次扫描，baseline 为空，所有有数据的股都算新增）
- derived/2026-06-17-candidates.json 生成，候选按趋势强度排序

- [ ] **Step 4: 检查输出可读性**

Run: `cat ~/.openclaw/watchlist/derived/2026-06-17-candidates.json | python -m json.tool | head -40`
Expected: 能看到候选股、top_trend、new_today，结构清晰。

- [ ] **Step 5: 提交（如有遗留改动）**

```bash
git add -A
git status   # 确认无意外改动
git commit -m "test(watchlist): e2e verification passed" --allow-empty
```

---

## 自检（Self-Review）

**1. Spec 覆盖**：
- 第0层 universe（去重/symbol）：Task 7 ✓
- 第1层 raw 快照（并发/重试/失败隔离）：Task 8 ✓
- 第2层 diff（集合求差）：Task 3 ✓
- 第3层 候选排序：Task 4 ✓
- 存储（JSON + 原子写 + watchlist/ 目录）：Task 1, 各 Task 输出路径 ✓
- CLI（4 命令 + 串跑）：Task 5, 6, 9 ✓
- 参数（滚动14月/并发3-5/北交所排除）：Task 7 (fs), Task 8 (compute_window), Task 8 (concurrency clamp) ✓
- 健康追踪（record_call）：Task 7 (universe/clist) ✓ — 注：snapshot 的 record_call 可后续补充，第一期非阻塞

**2. Placeholder 扫描**：无 TBD/TODO。所有代码步骤含完整代码。✓

**3. 类型一致性**：
- `RawStockEntry.scan_error`、`reason_list`、`range_reason_list` 在 diff.ts/candidates.ts/snapshot.py 三处口径一致 ✓
- `DiffChange.new_reason_points` / `new_range_trends` 类型在 types.ts 定义、diff.ts 生产、candidates.ts 消费，一致 ✓
- `compute_window` 返回值在 snapshot.py 测试与实现一致 ✓

**4. 一个已知简化**（非缺陷）：snapshot.py 的健康追踪（record_call）未完整接入 `http_helpers`，因为 snapshot 用的是 requests 直接调用雪球而非 em_get/http_get。第一期可接受（雪球成功/失败已在快照的 succeeded/failed 字段体现）；第二期可补一个 xueqiu 专用的健康追踪。
