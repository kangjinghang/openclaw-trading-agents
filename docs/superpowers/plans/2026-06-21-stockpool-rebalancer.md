# Portfolio Rebalancer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build portfolio-rebalancer module: takes ranker top-N + user holdings → outputs rebalance plan (BUY/SELL/ADD/REDUCE/HOLD actions with target weights, respecting 10 hard constraints + 7-day anti-churn).

**Architecture:** 6-stage pipeline: `holdings-loader → candidate-selector → shallow-analyzer (2 LLM/stock) → rebalancer (1 LLM, decision_deep, revise loop) → constraint-validator (10 rules, pure code) → execution-planner (pure code)`. Total ~31 LLM calls, ~8-12 min runtime.

**Tech Stack:** TypeScript (strict), Node.js, OpenAI client, existing `src/watchlist/*` modules + `src/llm-client.ts` + `src/trace-logger.ts` + `src/exec-python.ts`.

**Spec:** [`docs/superpowers/specs/2026-06-21-stockpool-rebalancer-design.md`](../specs/2026-06-21-stockpool-rebalancer-design.md)

**Conventions:**
- TDD: write test → fail → implement → pass → commit
- Mock LLM caller (pattern from `src/watchlist/ranker.ts:RankLlmCaller`)
- Atomic JSON writes (`src/watchlist/atomic-json.ts`)
- TraceLogger for LLM call auditing
- Pure logic first, LLM-coupled last

---

### Task 1: 类型定义（rebalance-types.ts）

**Files:**
- Create: `src/watchlist/rebalance-types.ts`

No tests — pure type declarations. Foundation for all later tasks.

- [ ] **Step 1: Create the file with all interfaces**

```typescript
// src/watchlist/rebalance-types.ts

// ═══ 输入 ═══

export interface Position {
  ticker: string;
  name: string;
  weight: number;                  // 0-1
  entry_price: number;
  entry_date: string;              // "YYYY-MM-DD"
  shares: number;
  sector: string;
}

export interface Holdings {
  updated_at: string;
  cash_pct: number;
  positions: Position[];
}

export interface LastRebalanceAction {
  action: "BUY" | "SELL" | "ADD" | "REDUCE";
  ticker: string;
  weight: number;
}

export interface LastRebalance {
  date: string;
  actions: LastRebalanceAction[];
}

// ═══ shallow-analyzer 产物 ═══

export interface AnalystReport {
  thesis: string;
  fitness_score: number;           // 0-10
  data_freshness: string;          // "YYYY-MM-DD"
  key_signals: string[];
  data_gaps: string[];
}

export interface RiskFlag {
  flag: string;
  severity: "低" | "中" | "高";
  detail: string;
}

export interface RiskReport {
  risk_flags: RiskFlag[];
  overall_risk: "low" | "medium" | "high";
  deal_breaker: boolean;
}

export interface StockReport {
  ticker: string;
  name: string;
  sector: string;
  thesis: string;
  fitness_score: number;
  key_signals: string[];
  data_gaps: string[];
  risk_flags: RiskFlag[];
  overall_risk: "low" | "medium" | "high";
  deal_breaker: boolean;
  is_held: boolean;
  current_weight: number;          // is_held=false → 0
  days_held: number;               // is_held=false → 0
  locked: boolean;                 // is_held=false → false
  ranker_score?: number;
}

// ═══ rebalancer 产物 ═══

export type ActionType = "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD";

export interface Evaluation {
  ticker: string;
  judgment: "BUY" | "HOLD" | "REDUCE" | "SELL" | "SKIP";
  brief: string;
}

export interface Action {
  action: ActionType;
  ticker: string;
  name: string;
  current_weight: number;
  target_weight: number;
  delta: number;
  reason: string;
  priority: number;                // 1=SELL, 2=REDUCE, 3=BUY, 4=ADD, 5=HOLD
}

export interface PortfolioAfter {
  positions: Array<{ ticker: string; weight: number }>;
  cash_pct: number;
}

export interface RebalancePlan {
  evaluations: Evaluation[];
  actions: Action[];
  portfolio_after: PortfolioAfter;
  summary: string;
}

// ═══ constraint-validator ═══

export interface ConstraintViolation {
  rule: string;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  violations: ConstraintViolation[];
}

// ═══ execution-planner ═══

export interface ExecutionStep {
  step: number;
  action: Exclude<ActionType, "HOLD">;
  ticker: string;
  name: string;
  weight_delta: number;
  est_cash_after: number;
  note?: string;
}

export interface ExecutionPlan {
  execution_sequence: ExecutionStep[];
  final_state: PortfolioAfter;
  warnings: string[];
}

// ═══ 完整 plan.json ═══

export interface RebalancePlanFile {
  scan_date: string;
  written_at: string;
  status: "ok" | "constraint_violation";
  model: string;
  tokens: number;
  holdings_before: Holdings;
  candidates: Array<{ ticker: string; ranker_score: number }>;
  last_rebalance: LastRebalance | null;
  reports: StockReport[];
  rebalancer_output: RebalancePlan;
  constraint_check: {
    passed: boolean;
    violations: string[];
    revise_count: number;
  };
  execution_plan: ExecutionPlan;
}

// ═══ 配置 ═══

export interface RebalanceConstraints {
  single_name: number;
  single_sector: number;
  daily_turnover: number;
  cash_reserve: number;
}

export interface RebalanceConfig {
  top_n: number;
  constraints: RebalanceConstraints;
  anti_churn_days: number;
  max_revise_retries: number;
  run_optional_scripts: boolean;
}

export const DEFAULT_REBALANCE_CONFIG: RebalanceConfig = {
  top_n: 10,
  constraints: {
    single_name: 0.15,
    single_sector: 0.30,
    daily_turnover: 0.30,
    cash_reserve: 0.10,
  },
  anti_churn_days: 7,
  max_revise_retries: 2,
  run_optional_scripts: false,
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: tsc passes with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/watchlist/rebalance-types.ts
git commit -m "feat(rebalance): add type definitions for rebalancer module"
```

---

### Task 2: holdings-loader（读 + 校验 + 计算 locked）

**Files:**
- Create: `src/watchlist/holdings-loader.ts`
- Test: `tests/ts/watchlist/holdings-loader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ts/watchlist/holdings-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadHoldings, validateHoldings, computeLocked } from "../../../src/watchlist/holdings-loader";
import type { Holdings } from "../../../src/watchlist/rebalance-types";

const VALID: Holdings = {
  updated_at: "2026-06-21T20:00:00+08:00",
  cash_pct: 0.15,
  positions: [
    { ticker: "SH600519", name: "贵州茅台", weight: 0.20, entry_price: 1700, entry_date: "2026-05-20", shares: 100, sector: "白酒" },
    { ticker: "SZ300319", name: "麦捷科技", weight: 0.05, entry_price: 25, entry_date: "2026-06-15", shares: 200, sector: "电子" },
  ],
};

describe("validateHoldings", () => {
  it("通过：sum(positions.weight) + cash_pct ≈ 1.0", () => {
    expect(validateHoldings(VALID)).toEqual({ ok: true, error: null });
  });

  it("失败：sum ≠ 1.0", () => {
    const bad = { ...VALID, cash_pct: 0.50 };  // 0.20+0.05+0.50 = 0.75
    const r = validateHoldings(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/权重和.*0\.75/);
  });

  it("失败：缺 sector 字段", () => {
    const bad: Holdings = { ...VALID, positions: [{ ...VALID.positions[0], sector: "" }] };
    const r = validateHoldings(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sector/);
  });
});

describe("computeLocked", () => {
  it("entry_date 在 7 天内 → locked=true", () => {
    // 2026-06-15 → 2026-06-21 = 6 天
    expect(computeLocked("2026-06-15", "2026-06-21", 7)).toBe(true);
  });

  it("entry_date 在 7 天前或更早 → locked=false", () => {
    expect(computeLocked("2026-06-14", "2026-06-21", 7)).toBe(false);
  });

  it("anti_churn_days=0 → 永不锁定", () => {
    expect(computeLocked("2026-06-21", "2026-06-21", 0)).toBe(false);
  });

  it("entry_date 格式错误 → locked=false（防御性）", () => {
    expect(computeLocked("invalid", "2026-06-21", 7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/holdings-loader.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

```typescript
// src/watchlist/holdings-loader.ts
import * as fs from "fs";
import type { Holdings } from "./rebalance-types";

export interface ValidationResult { ok: boolean; error: string | null; }

/** 校验 holdings schema + 权重和。 */
export function validateHoldings(h: Holdings): ValidationResult {
  if (!Array.isArray(h.positions)) return { ok: false, error: "positions 必须是数组" };
  if (typeof h.cash_pct !== "number" || h.cash_pct < 0 || h.cash_pct > 1) {
    return { ok: false, error: `cash_pct ${h.cash_pct} 不在 [0,1]` };
  }
  for (const p of h.positions) {
    if (!p.sector || !p.sector.trim()) {
      return { ok: false, error: `${p.ticker} 缺 sector 字段` };
    }
    if (!p.entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(p.entry_date)) {
      return { ok: false, error: `${p.ticker} entry_date 格式错误: ${p.entry_date}` };
    }
  }
  const sum = h.positions.reduce((s, p) => s + p.weight, 0) + h.cash_pct;
  if (Math.abs(sum - 1.0) > 0.001) {
    return { ok: false, error: `权重和 ${sum.toFixed(3)} 不等于 1.0（positions + cash）` };
  }
  return { ok: true, error: null };
}

/** 计算某 entry_date 在 currentDate 下是否被 anti-churn 锁定。
 *  antiChurnDays=0 表示永不锁定。格式错误也返回 false（防御性）。 */
export function computeLocked(entryDate: string, currentDate: string, antiChurnDays: number): boolean {
  if (antiChurnDays <= 0) return false;
  const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
  const current = new Date(currentDate + "T00:00:00+08:00").getTime();
  if (isNaN(entry) || isNaN(current)) return false;
  const daysHeld = Math.floor((current - entry) / (24 * 60 * 60 * 1000));
  return daysHeld < antiChurnDays;
}

/** 读 holdings.json 文件 + 校验。文件不存在或校验失败抛错。 */
export function loadHoldings(filePath: string): Holdings {
  if (!fs.existsSync(filePath)) {
    throw new Error(`holdings.json 不存在: ${filePath}\n请手动创建，schema 见 rebalance-types.ts:Holdings`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Holdings;
  const v = validateHoldings(raw);
  if (!v.ok) throw new Error(`holdings.json 校验失败: ${v.error}`);
  return raw;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/holdings-loader.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/holdings-loader.ts tests/ts/watchlist/holdings-loader.test.ts
git commit -m "feat(rebalance): add holdings-loader with schema validation + anti-churn lock check"
```

---

### Task 3: candidate-selector（合并 ranker + 持仓 + 标状态）

**Files:**
- Create: `src/watchlist/candidate-selector.ts`
- Test: `tests/ts/watchlist/candidate-selector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ts/watchlist/candidate-selector.test.ts
import { describe, it, expect } from "vitest";
import { selectCandidates } from "../../../src/watchlist/candidate-selector";
import type { Holdings, Position } from "../../../src/watchlist/rebalance-types";
import type { ScanSummary } from "../../../src/watchlist/types";

function makePosition(over: Partial<Position> = {}): Position {
  return { ticker: "SH600519", name: "贵州茅台", weight: 0.1, entry_price: 100, entry_date: "2026-06-01", shares: 100, sector: "白酒", ...over };
}

function makeScan(topPicks: Array<{ ticker: string; name: string; score: number; group: "LONG" | "SHORT"; percent: number; days: number; range_kind: "continued" | "new"; reason: string }> = []): ScanSummary {
  return {
    scan_date: "2026-06-21",
    total_candidates: 178,
    groups: { LONG: { total: 35, ranked: 7, excluded: 5, fallback: false }, SHORT: { total: 44, pre_filter: 138, post_common_filter: 110, ranked: 8, excluded: 5, fallback: false } },
    top_picks: topPicks,
  };
}

describe("selectCandidates", () => {
  it("合并 ranker top-N + 持仓，按 ticker 去重", () => {
    const scan = makeScan([
      { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "..." },
      { ticker: "SH600183", name: "生益科技", score: 9.2, group: "LONG", percent: 258, days: 77, range_kind: "continued", reason: "..." },
    ]);
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.85,
      positions: [
        makePosition({ ticker: "SH600519", name: "贵州茅台", sector: "白酒" }),
        makePosition({ ticker: "SZ300319", name: "麦捷科技", entry_date: "2026-06-15", sector: "电子" }),  // 跟候选重叠
      ],
    };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    const tickers = result.map(c => c.ticker);
    expect(tickers).toEqual(expect.arrayContaining(["SZ300319", "SH600183", "SH600519"]));
    expect(tickers.filter(t => t === "SZ300319")).toHaveLength(1);  // 去重
  });

  it("ranker top-N 截取前 N 支", () => {
    const picks = Array.from({ length: 15 }, (_, i) => ({
      ticker: `SZ30000${i}`, name: `s${i}`, score: 9 - i * 0.1, group: "LONG" as const,
      percent: 50, days: 30, range_kind: "continued" as const, reason: "r",
    }));
    const scan = makeScan(picks);
    const holdings: Holdings = { updated_at: "x", cash_pct: 1.0, positions: [] };
    const result = selectCandidates(scan, holdings, { topN: 5, currentDate: "2026-06-21", antiChurnDays: 7 });
    expect(result).toHaveLength(5);
    expect(result[0].ticker).toBe("SZ300000");  // 按 score 降序
  });

  it("持仓标 is_held=true + current_weight + days_held", () => {
    const scan = makeScan([]);
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [makePosition({ ticker: "SH600519", name: "贵州茅台", weight: 0.20, entry_date: "2026-06-01", sector: "白酒" })],
    };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    const held = result.find(c => c.ticker === "SH600519")!;
    expect(held.is_held).toBe(true);
    expect(held.current_weight).toBe(0.20);
    expect(held.days_held).toBe(20);
    expect(held.locked).toBe(false);  // 20 天 > 7 天
  });

  it("持仓 entry_date 在 7 天内 → locked=true", () => {
    const scan = makeScan([]);
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [makePosition({ ticker: "SZ300319", entry_date: "2026-06-18", sector: "电子" })],
    };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    expect(result[0].locked).toBe(true);  // 3 天 < 7 天
  });

  it("候选股（非持仓）is_held=false + current_weight=0 + locked=false", () => {
    const scan = makeScan([
      { ticker: "SH600183", name: "生益科技", score: 9.2, group: "LONG", percent: 258, days: 77, range_kind: "continued", reason: "r" },
    ]);
    const holdings: Holdings = { updated_at: "x", cash_pct: 1.0, positions: [] };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    expect(result[0]).toMatchObject({ is_held: false, current_weight: 0, locked: false, days_held: 0 });
    expect(result[0].ranker_score).toBe(9.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/candidate-selector.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

```typescript
// src/watchlist/candidate-selector.ts
import type { ScanSummary } from "./types";
import type { Holdings, Position } from "./rebalance-types";
import { computeLocked } from "./holdings-loader";

export interface CandidateMeta {
  ticker: string;
  name: string;
  is_held: boolean;
  current_weight: number;
  days_held: number;
  locked: boolean;
  ranker_score?: number;
}

export interface SelectOptions {
  topN: number;
  currentDate: string;       // "YYYY-MM-DD"
  antiChurnDays: number;
}

export function selectCandidates(scan: ScanSummary, holdings: Holdings, opts: SelectOptions): CandidateMeta[] {
  const map = new Map<string, CandidateMeta>();

  // 1. ranker top-N
  const top = scan.top_picks.slice(0, opts.topN);
  for (const p of top) {
    map.set(p.ticker, {
      ticker: p.ticker,
      name: p.name,
      is_held: false,
      current_weight: 0,
      days_held: 0,
      locked: false,
      ranker_score: p.score,
    });
  }

  // 2. 合并持仓（去重：若已存在，覆盖持仓信息）
  for (const pos of holdings.positions) {
    const daysHeld = computeDaysHeld(pos.entry_date, opts.currentDate);
    const locked = computeLocked(pos.entry_date, opts.currentDate, opts.antiChurnDays);
    const existing = map.get(pos.ticker);
    if (existing) {
      existing.is_held = true;
      existing.current_weight = pos.weight;
      existing.days_held = daysHeld;
      existing.locked = locked;
      // 保留 name 和 ranker_score
    } else {
      map.set(pos.ticker, {
        ticker: pos.ticker,
        name: pos.name,
        is_held: true,
        current_weight: pos.weight,
        days_held: daysHeld,
        locked: locked,
      });
    }
  }

  return Array.from(map.values());
}

function computeDaysHeld(entryDate: string, currentDate: string): number {
  const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
  const cur = new Date(currentDate + "T00:00:00+08:00").getTime();
  if (isNaN(entry) || isNaN(cur)) return 0;
  return Math.floor((cur - entry) / (24 * 60 * 60 * 1000));
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/candidate-selector.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/candidate-selector.ts tests/ts/watchlist/candidate-selector.test.ts
git commit -m "feat(rebalance): add candidate-selector merging ranker top-N with holdings"
```

---

### Task 4: constraint-validator 规则 1-5（权重 + 单仓 + 单行业 + 换手 + 现金）

**Files:**
- Create: `src/watchlist/constraint-validator.ts`
- Test: `tests/ts/watchlist/constraint-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ts/watchlist/constraint-validator.test.ts
import { describe, it, expect } from "vitest";
import { validateRebalance } from "../../../src/watchlist/constraint-validator";
import type { RebalancePlan, RebalanceConstraints } from "../../../src/watchlist/rebalance-types";

const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10 };

function makeAction(over: Partial<RebalancePlan["actions"][0]> = {}): RebalancePlan["actions"][0] {
  return { action: "HOLD", ticker: "X", name: "x", current_weight: 0.10, target_weight: 0.10, delta: 0, reason: "r", priority: 5, ...over };
}

function makePlan(actions: RebalancePlan["actions"]): RebalancePlan {
  return { evaluations: [], actions, portfolio_after: { positions: [], cash_pct: 0 }, summary: "" };
}

describe("validateRebalance 规则 1: 权重和=1", () => {
  it("通过：sum(target) + cash = 1.0", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.40 }),
      makeAction({ ticker: "B", target_weight: 0.50, action: "HOLD" }),
    ]);
    plan.portfolio_after.cash_pct = 0.10;
    const r = validateRebalance(plan, { sectors: { A: "电子", B: "白酒" }, held: new Map(), tickersInPool: new Set(["A", "B"]) }, C);
    expect(r.passed).toBe(true);
  });

  it("失败：sum=0.97", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.50 })]);
    plan.portfolio_after.cash_pct = 0.10;  // 0.50 + 0.10 = 0.60 ≠ 1.0
    const r = validateRebalance(plan, { sectors: { A: "电子" }, held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.passed).toBe(false);
    expect(r.violations.some(v => v.rule.includes("权重和"))).toBe(true);
  });
});

describe("validateRebalance 规则 2: 单仓 ≤15%", () => {
  it("通过：max weight=0.15", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.15 }),
      makeAction({ ticker: "B", target_weight: 0.15, action: "HOLD" }),
    ]);
    plan.portfolio_after.cash_pct = 0.70;
    const r = validateRebalance(plan, { sectors: { A: "x", B: "y" }, held: new Map(), tickersInPool: new Set(["A", "B"]) }, C);
    expect(r.passed).toBe(true);
  });

  it("失败：weight=0.18 超 15%", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.18 })]);
    plan.portfolio_after.cash_pct = 0.82;
    const r = validateRebalance(plan, { sectors: { A: "x" }, held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("单仓") && v.detail.includes("0.18"))).toBe(true);
  });
});

describe("validateRebalance 规则 3: 单行业 ≤30%", () => {
  it("失败：PCB 行业 sum=0.35", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.18, action: "BUY" }),
      makeAction({ ticker: "B", target_weight: 0.17, action: "BUY" }),
    ]);
    plan.portfolio_after.cash_pct = 0.65;
    const r = validateRebalance(plan, { sectors: { A: "PCB", B: "PCB" }, held: new Map(), tickersInPool: new Set(["A", "B"]) }, C);
    expect(r.violations.some(v => v.rule.includes("单行业") && v.detail.includes("0.35"))).toBe(true);
  });
});

describe("validateRebalance 规则 4: 日换手 ≤30%", () => {
  it("失败：sum|delta|=0.35", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.20, target_weight: 0.05, delta: -0.15, action: "REDUCE" }),
      makeAction({ ticker: "B", current_weight: 0, target_weight: 0.20, delta: 0.20, action: "BUY" }),
    ]);
    plan.portfolio_after.cash_pct = 0.10;
    const r = validateRebalance(plan, { sectors: { A: "x", B: "y" }, held: new Map(), tickersInPool: new Set(["A", "B"]) }, C);
    expect(r.violations.some(v => v.rule.includes("日换手") && v.detail.includes("0.35"))).toBe(true);
  });
});

describe("validateRebalance 规则 5: 现金 ≥10%", () => {
  it("失败：cash=0.08", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.92 })]);
    plan.portfolio_after.cash_pct = 0.08;
    const r = validateRebalance(plan, { sectors: { A: "x" }, held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("现金") && v.detail.includes("0.08"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/constraint-validator.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement rules 1-5**

```typescript
// src/watchlist/constraint-validator.ts
import type {
  Action, ConstraintViolation, RebalancePlan,
  RebalanceConstraints, ValidationResult,
} from "./rebalance-types";

export interface ValidationContext {
  sectors: Map<string, string>;        // ticker → sector
  held: Map<string, { days_held: number; locked: boolean }>;  // ticker → holding state
  tickersInPool: Set<string>;          // 所有候选+持仓的 ticker
  recentSoldTickers: Set<string>;      // last_rebalance 7 天内 SELL 的 ticker
}

export function validateRebalance(
  plan: RebalancePlan,
  ctx: ValidationContext,
  c: RebalanceConstraints,
): ValidationResult {
  const violations: ConstraintViolation[] = [];

  // 规则 1: 权重和=1（含 HOLD 的 target_weight）
  const sumWeight = plan.actions.reduce((s, a) => s + a.target_weight, 0);
  const totalWithCash = sumWeight + plan.portfolio_after.cash_pct;
  if (Math.abs(totalWithCash - 1.0) > 0.001) {
    violations.push({
      rule: "1. 权重和=1",
      detail: `权重和 ${totalWithCash.toFixed(3)} 不等于 1.0（positions ${sumWeight.toFixed(3)} + cash ${plan.portfolio_after.cash_pct.toFixed(3)}）`,
    });
  }

  // 规则 2: 单仓 ≤ single_name
  for (const a of plan.actions) {
    if (a.target_weight > c.single_name + 0.0001) {
      violations.push({
        rule: "2. 单仓上限",
        detail: `${a.ticker} target_weight ${a.target_weight.toFixed(3)} 超 ${c.single_name} 上限`,
      });
    }
  }

  // 规则 3: 单行业 ≤ single_sector
  const sectorSums = new Map<string, number>();
  for (const a of plan.actions) {
    if (a.target_weight <= 0) continue;
    const sector = ctx.sectors.get(a.ticker);
    if (!sector) continue;
    sectorSums.set(sector, (sectorSums.get(sector) ?? 0) + a.target_weight);
  }
  for (const [sector, sum] of sectorSums) {
    if (sum > c.single_sector + 0.0001) {
      violations.push({
        rule: "3. 单行业上限",
        detail: `${sector} 行业 sum ${sum.toFixed(3)} 超 ${c.single_sector} 上限`,
      });
    }
  }

  // 规则 4: 日换手 ≤ daily_turnover
  const turnover = plan.actions.reduce((s, a) => s + Math.abs(a.delta), 0);
  if (turnover > c.daily_turnover + 0.0001) {
    violations.push({
      rule: "4. 日换手上限",
      detail: `sum(|delta|) ${turnover.toFixed(3)} 超 ${c.daily_turnover} 上限`,
    });
  }

  // 规则 5: 现金 ≥ cash_reserve
  if (plan.portfolio_after.cash_pct < c.cash_reserve - 0.0001) {
    violations.push({
      rule: "5. 现金下限",
      detail: `cash_pct ${plan.portfolio_after.cash_pct.toFixed(3)} 不足 ${c.cash_reserve} 下限`,
    });
  }

  return { passed: violations.length === 0, violations };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/constraint-validator.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/constraint-validator.ts tests/ts/watchlist/constraint-validator.test.ts
git commit -m "feat(rebalance): add constraint validator rules 1-5 (weight/name/sector/turnover/cash)"
```

---

### Task 5: constraint-validator 规则 6-10（anti-churn + action 一致性 + ticker + sector）

**Files:**
- Modify: `src/watchlist/constraint-validator.ts`
- Modify: `tests/ts/watchlist/constraint-validator.test.ts`

- [ ] **Step 1: Add tests for rules 6-10**

Append to `tests/ts/watchlist/constraint-validator.test.ts`:

```typescript
describe("validateRebalance 规则 6: anti-churn 卖锁", () => {
  it("失败：locked 持仓被 SELL", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true }]]);
    const r = validateRebalance(plan, { sectors: { A: "x" }, held, tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 卖锁"))).toBe(true);
  });

  it("通过：locked 持仓被 HOLD", () => {
    const plan = makePlan([makeAction({ ticker: "A", action: "HOLD", current_weight: 0.10, target_weight: 0.10, delta: 0 })]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true }]]);
    const r = validateRebalance(plan, { sectors: { A: "x" }, held, tickersInPool: new Set(["A"]) }, C);
    expect(r.passed).toBe(true);
  });
});

describe("validateRebalance 规则 7: anti-churn 买锁", () => {
  it("失败：BUY 最近 SELL 过的 ticker", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0, target_weight: 0.10, delta: 0.10, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const recentSold = new Set(["A"]);
    const r = validateRebalance(plan, { sectors: { A: "x" }, held: new Map(), tickersInPool: new Set(["A"]), recentSoldTickers: recentSold }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 买锁"))).toBe(true);
  });
});

describe("validateRebalance 规则 8: action 一致性", () => {
  it("失败：action=BUY 但 current>0", () => {
    const plan = makePlan([makeAction({ action: "BUY", current_weight: 0.05, target_weight: 0.10, delta: 0.05 })]);
    plan.portfolio_after.cash_pct = 0.90;
    const r = validateRebalance(plan, { sectors: { X: "x" }, held: new Map(), tickersInPool: new Set(["X"]) }, C);
    expect(r.violations.some(v => v.rule.includes("action 一致性") && v.detail.includes("BUY"))).toBe(true);
  });

  it("失败：action=HOLD 但 target≠current", () => {
    const plan = makePlan([makeAction({ action: "HOLD", current_weight: 0.10, target_weight: 0.15, delta: 0.05, ticker: "X" })]);
    plan.portfolio_after.cash_pct = 0.85;
    const r = validateRebalance(plan, { sectors: { X: "x" }, held: new Map(), tickersInPool: new Set(["X"]) }, C);
    expect(r.violations.some(v => v.rule.includes("action 一致性") && v.detail.includes("HOLD"))).toBe(true);
  });
});

describe("validateRebalance 规则 9: ticker 在候选池", () => {
  it("失败：幻觉 ticker 不在 pool", () => {
    const plan = makePlan([makeAction({ ticker: "FAKE", target_weight: 0.10, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const r = validateRebalance(plan, { sectors: { FAKE: "x" }, held: new Map(), tickersInPool: new Set(["REAL"]) }, C);
    expect(r.violations.some(v => v.rule.includes("ticker 在候选池") && v.detail.includes("FAKE"))).toBe(true);
  });
});

describe("validateRebalance 规则 10: sector 非空", () => {
  it("失败：target>0 但 sector 缺失", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.10, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const r = validateRebalance(plan, { sectors: {}, held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("sector 非空") && v.detail.includes("A"))).toBe(true);
  });
});
```

Also fix the `makeAction` default to use a non-empty sector context for older tests that don't care — the existing tests already pass `sectors: { A: "x", B: "y" }` so they're fine.

- [ ] **Step 2: Run test to verify failures**

Run: `npx vitest run tests/ts/watchlist/constraint-validator.test.ts`
Expected: 6 new tests FAIL (rules 6-10 not implemented).

- [ ] **Step 3: Add rules 6-10 to implementation**

Append to `src/watchlist/constraint-validator.ts` inside `validateRebalance`, before `return`:

```typescript
  // 规则 6: anti-churn 卖锁 — locked 持仓禁止 SELL/REDUCE
  for (const a of plan.actions) {
    if (a.action === "SELL" || a.action === "REDUCE") {
      const h = ctx.held.get(a.ticker);
      if (h?.locked) {
        violations.push({
          rule: "6. anti-churn 卖锁",
          detail: `${a.ticker} 持仓 ${h.days_held} 天 < anti_churn_days，locked，禁止 ${a.action}`,
        });
      }
    }
  }

  // 规则 7: anti-churn 买锁 — 最近 SELL 过的 ticker 禁止 BUY
  if (ctx.recentSoldTickers) {
    for (const a of plan.actions) {
      if (a.action === "BUY" && ctx.recentSoldTickers.has(a.ticker)) {
        violations.push({
          rule: "7. anti-churn 买锁",
          detail: `${a.ticker} 7 天内刚 SELL 过，禁止立即 BUY`,
        });
      }
    }
  }

  // 规则 8: action 一致性
  for (const a of plan.actions) {
    const inconsistent: string[] = [];
    if (a.action === "BUY" && a.current_weight > 0.0001) inconsistent.push("BUY 但 current>0");
    if (a.action === "SELL" && a.target_weight > 0.0001) inconsistent.push("SELL 但 target>0");
    if (a.action === "ADD" && a.current_weight < 0.0001) inconsistent.push("ADD 但 current=0");
    if (a.action === "ADD" && a.target_weight <= a.current_weight) inconsistent.push("ADD 但 target≤current");
    if (a.action === "REDUCE" && a.current_weight < 0.0001) inconsistent.push("REDUCE 但 current=0");
    if (a.action === "REDUCE" && a.target_weight <= 0) inconsistent.push("REDUCE 但 target≤0");
    if (a.action === "REDUCE" && a.target_weight >= a.current_weight) inconsistent.push("REDUCE 但 target≥current");
    if (a.action === "HOLD" && Math.abs(a.target_weight - a.current_weight) > 0.0001) inconsistent.push("HOLD 但 target≠current");
    if (inconsistent.length > 0) {
      violations.push({ rule: "8. action 一致性", detail: `${a.ticker} ${a.action}: ${inconsistent.join("; ")}` });
    }
  }

  // 规则 9: ticker 在候选/持仓池
  for (const a of plan.actions) {
    if (!ctx.tickersInPool.has(a.ticker)) {
      violations.push({
        rule: "9. ticker 在候选池",
        detail: `${a.ticker} 不在评估范围（幻觉 ticker）`,
      });
    }
  }

  // 规则 10: sector 非空
  for (const a of plan.actions) {
    if (a.target_weight > 0.0001 && !ctx.sectors.get(a.ticker)) {
      violations.push({
        rule: "10. sector 非空",
        detail: `${a.ticker} target>0 但 sector 缺失`,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}
```

- [ ] **Step 4: Run test to verify all pass**

Run: `npx vitest run tests/ts/watchlist/constraint-validator.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/constraint-validator.ts tests/ts/watchlist/constraint-validator.test.ts
git commit -m "feat(rebalance): add constraint validator rules 6-10 (anti-churn/consistency/ticker/sector)"
```

---

### Task 6: constraint-validator composeViolations（拼 revise feedback）

**Files:**
- Modify: `src/watchlist/constraint-validator.ts`
- Modify: `tests/ts/watchlist/constraint-validator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to test file:

```typescript
import { composeReviseFeedback } from "../../../src/watchlist/constraint-validator";

describe("composeReviseFeedback", () => {
  it("把 violations 拼成 LLM 友好的 feedback 字符串", () => {
    const violations = [
      { rule: "2. 单仓上限", detail: "SZ300319 weight 0.18 超 0.15" },
      { rule: "4. 日换手上限", detail: "sum(|delta|) 0.35 超 0.30" },
    ];
    const feedback = composeReviseFeedback(violations);
    expect(feedback).toContain("违反了以下约束");
    expect(feedback).toContain("1. [2. 单仓上限]");
    expect(feedback).toContain("SZ300319 weight 0.18");
    expect(feedback).toContain("2. [4. 日换手上限]");
    expect(feedback).toContain("请重新输出");
  });

  it("空 violations 返回空字符串", () => {
    expect(composeReviseFeedback([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/constraint-validator.test.ts -t composeReviseFeedback`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/watchlist/constraint-validator.ts`:

```typescript
/** 把 violations 拼成 LLM revise 用的 feedback 字符串。空 violations 返回空。 */
export function composeReviseFeedback(violations: ConstraintViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map((v, i) => `${i + 1}. [${v.rule}] ${v.detail}`);
  return [
    "你的上一次方案违反了以下约束，请修正：",
    "",
    ...lines,
    "",
    "请重新输出 REBALANCE_PLAN，确保满足所有硬约束。",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/constraint-validator.test.ts`
Expected: 15 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/constraint-validator.ts tests/ts/watchlist/constraint-validator.test.ts
git commit -m "feat(rebalance): add composeReviseFeedback for LLM revise loop"
```

---

### Task 7: execution-planner（排序 + cash 累计）

**Files:**
- Create: `src/watchlist/execution-planner.ts`
- Test: `tests/ts/watchlist/execution-planner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ts/watchlist/execution-planner.test.ts
import { describe, it, expect } from "vitest";
import { buildExecutionPlan } from "../../../src/watchlist/execution-planner";
import type { Action, RebalancePlan } from "../../../src/watchlist/rebalance-types";

function a(over: Partial<Action> = {}): Action {
  return { action: "HOLD", ticker: "X", name: "x", current_weight: 0.10, target_weight: 0.10, delta: 0, reason: "r", priority: 5, ...over };
}

function plan(actions: Action[], cashPct: number): RebalancePlan {
  return { evaluations: [], actions, portfolio_after: { positions: [], cash_pct: cashPct }, summary: "" };
}

describe("buildExecutionPlan", () => {
  it("过滤 HOLD actions", () => {
    const p = plan([a({ action: "HOLD" }), a({ action: "SELL", ticker: "B", priority: 1 })], 0.20);
    const ep = buildExecutionPlan(p, 0.15);
    expect(ep.execution_sequence).toHaveLength(1);
    expect(ep.execution_sequence[0].action).toBe("SELL");
  });

  it("按 priority 排序：SELL → REDUCE → BUY → ADD", () => {
    const p = plan([
      a({ action: "ADD", ticker: "ADD", priority: 4, delta: 0.05 }),
      a({ action: "BUY", ticker: "BUY", priority: 3, delta: 0.10 }),
      a({ action: "SELL", ticker: "SELL", priority: 1, delta: -0.15 }),
      a({ action: "REDUCE", ticker: "RED", priority: 2, delta: -0.10 }),
    ], 0.20);
    const ep = buildExecutionPlan(p, 0.15);
    expect(ep.execution_sequence.map(s => s.ticker)).toEqual(["SELL", "RED", "BUY", "ADD"]);
  });

  it("同 priority 按 |delta| desc", () => {
    const p = plan([
      a({ action: "BUY", ticker: "SMALL", priority: 3, delta: 0.05 }),
      a({ action: "BUY", ticker: "BIG", priority: 3, delta: 0.15 }),
    ], 0.20);
    const ep = buildExecutionPlan(p, 0.50);
    expect(ep.execution_sequence.map(s => s.ticker)).toEqual(["BIG", "SMALL"]);
  });

  it("cash 累计：SELL 后 cash 增加，BUY 后减少", () => {
    const p = plan([
      a({ action: "SELL", ticker: "S", priority: 1, delta: -0.10 }),
      a({ action: "BUY", ticker: "B", priority: 3, delta: 0.05 }),
    ], 0.15);
    const ep = buildExecutionPlan(p, 0.15);  // 初始 cash 15%
    expect(ep.execution_sequence[0]).toMatchObject({ ticker: "S", weight_delta: -0.10, est_cash_after: 0.25 });  // 0.15+0.10
    expect(ep.execution_sequence[1]).toMatchObject({ ticker: "B", weight_delta: 0.05, est_cash_after: 0.20 });   // 0.25-0.05
  });

  it("BUY cash 不足 → 标 warning，仍保留步骤（让用户看到）", () => {
    const p = plan([
      a({ action: "BUY", ticker: "B", priority: 3, delta: 0.20 }),
    ], 0.05);  // cash 只有 5%，不够 20%
    const ep = buildExecutionPlan(p, 0.05);
    expect(ep.warnings.length).toBeGreaterThan(0);
    expect(ep.warnings[0]).toMatch(/cash.*不足/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/execution-planner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/watchlist/execution-planner.ts
import type { Action, ExecutionPlan, ExecutionStep, RebalancePlan } from "./rebalance-types";

/** 把 plan 的 actions 排序成可执行 sequence + cash 累计。 */
export function buildExecutionPlan(plan: RebalancePlan, initialCash: number): ExecutionPlan {
  // 1. 过滤 HOLD
  const actionable = plan.actions.filter(a => a.action !== "HOLD");

  // 2. 按 priority 升序，同 priority 按 |delta| 降序
  const sorted = [...actionable].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.abs(b.delta) - Math.abs(a.delta);
  });

  // 3. 累计 cash + 构造 steps
  const steps: ExecutionStep[] = [];
  const warnings: string[] = [];
  let cash = initialCash;
  sorted.forEach((a, idx) => {
    const newCash = cash - a.delta;  // delta 正=买入（cash 减少），负=卖出（cash 增加）
    if (a.delta > 0 && newCash < -0.0001) {
      warnings.push(`${a.action} ${a.ticker} 需 ${a.delta.toFixed(3)} 但 cash 不足（剩余 ${cash.toFixed(3)})`);
    }
    const step: ExecutionStep = {
      step: idx + 1,
      action: a.action as Exclude<Action["action"], "HOLD">,
      ticker: a.ticker,
      name: a.name,
      weight_delta: a.delta,
      est_cash_after: Math.max(0, newCash),
      note: a.delta < 0 ? "释放资金" : (a.delta > 0 ? "使用资金" : undefined),
    };
    steps.push(step);
    cash = newCash;
  });

  return {
    execution_sequence: steps,
    final_state: plan.portfolio_after,
    warnings,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/execution-planner.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/execution-planner.ts tests/ts/watchlist/execution-planner.test.ts
git commit -m "feat(rebalance): add execution-planner with priority sort + cash tracking"
```

---

### Task 8: shallow-analyzer - analyst-role prompt + parse

**Files:**
- Create: `src/watchlist/shallow-analyzer.ts`
- Test: `tests/ts/watchlist/shallow-analyzer.test.ts`

- [ ] **Step 1: Write the failing test for prompt formatting + parsing**

```typescript
// tests/ts/watchlist/shallow-analyzer.test.ts
import { describe, it, expect } from "vitest";
import { formatAnalystPrompt, parseAnalystReport } from "../../../src/watchlist/shallow-analyzer";

describe("formatAnalystPrompt", () => {
  it("渲染包含 ticker/sector + 数据摘要", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319",
      name: "麦捷科技",
      sector: "电子",
      kline: { pct_5d: 12.3, pct_20d: 45.6, support: 25.0, resistance: 30.0 },
      news: ["新闻 1", "新闻 2"],
      hot_money: { net_5d: 1.2e8 },
      fundamentals: { pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8 },
      ranker_thesis: "TLVR 电感获英伟达认证",
    });
    expect(prompt).toContain("SZ300319 麦捷科技");
    expect(prompt).toContain("电子");
    expect(prompt).toContain("12.3");
    expect(prompt).toContain("新闻 1");
    expect(prompt).toContain("1.2e+8");
    expect(prompt).toContain("英伟达认证");
  });
});

describe("parseAnalystReport", () => {
  it("解析裸 JSON", () => {
    const content = JSON.stringify({
      thesis: "TLVR 电感订单放量",
      fitness_score: 8.5,
      data_freshness: "2026-06-21",
      key_signals: ["订单排至27年", "涨停突破"],
      data_gaps: [],
    });
    const r = parseAnalystReport(content);
    expect(r).not.toBeNull();
    expect(r!.thesis).toBe("TLVR 电感订单放量");
    expect(r!.fitness_score).toBe(8.5);
  });

  it("解析 ```json 代码块包裹", () => {
    const content = "```json\n" + JSON.stringify({
      thesis: "x", fitness_score: 7, data_freshness: "2026-06-21", key_signals: [], data_gaps: [],
    }) + "\n```";
    expect(parseAnalystReport(content)?.fitness_score).toBe(7);
  });

  it("字段缺失填默认值", () => {
    const content = JSON.stringify({ thesis: "x" });
    const r = parseAnalystReport(content);
    expect(r).not.toBeNull();
    expect(r!.fitness_score).toBe(0);
    expect(r!.key_signals).toEqual([]);
  });

  it("非 JSON 返回 null", () => {
    expect(parseAnalystReport("不是 JSON")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/shallow-analyzer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement formatAnalystPrompt + parseAnalystReport**

```typescript
// src/watchlist/shallow-analyzer.ts
import type { AnalystReport } from "./rebalance-types";

export interface StockData {
  ticker: string;
  name: string;
  sector: string;
  kline: { pct_5d: number; pct_20d: number; support: number; resistance: number };
  news: string[];
  hot_money: { net_5d: number };
  fundamentals: { pe: number; pb: number; rev_q1: number; np_q1: number };
  ranker_thesis?: string;
}

const ANALYST_PROMPT_TEMPLATE = `# 角色
你是 A 股证券分析师，对单只股票做综合评估。

# 任务
基于以下数据，输出 thesis + fitness + 关键信号。要求 reason 含具体词（产品/客户/数据/业务节点），
禁止模糊词（共振/资金追捧/活跃/爆发力强）。

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，支撑 {support} / 压力 {resistance}）
## 新闻（最近 7 天 top）
{news_bullets}
## 资金流向（5 日净流入 {net_5d}）
## 基本面（PE {pe} / PB {pb} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）
{ranker_section}

# 输出格式（严格 JSON）
{
  "thesis": "...",
  "fitness_score": 0-10,
  "data_freshness": "YYYY-MM-DD",
  "key_signals": ["...", "..."],
  "data_gaps": ["..."]
}`;

export function formatAnalystPrompt(d: StockData): string {
  const newsBullets = d.news.map(n => `- ${n}`).join("\n") || "- (无)";
  const rankerSection = d.ranker_thesis ? `## ranker 评估（ranker 给的 thesis）\n${d.ranker_thesis}` : "";
  return ANALYST_PROMPT_TEMPLATE
    .replace("{ticker}", d.ticker)
    .replace("{name}", d.name)
    .replace("{sector}", d.sector)
    .replace("{pct_5d}", String(d.kline.pct_5d))
    .replace("{pct_20d}", String(d.kline.pct_20d))
    .replace("{support}", String(d.kline.support))
    .replace("{resistance}", String(d.kline.resistance))
    .replace("{news_bullets}", newsBullets)
    .replace("{net_5d}", String(d.hot_money.net_5d))
    .replace("{pe}", String(d.fundamentals.pe))
    .replace("{pb}", String(d.fundamentals.pb))
    .replace("{rev_q1}", String(d.fundamentals.rev_q1))
    .replace("{np_q1}", String(d.fundamentals.np_q1))
    .replace("{ranker_section}", rankerSection);
}

/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
export function parseAnalystReport(content: string): AnalystReport | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  return {
    thesis: typeof o.thesis === "string" ? o.thesis : "",
    fitness_score: typeof o.fitness_score === "number" ? o.fitness_score : 0,
    data_freshness: typeof o.data_freshness === "string" ? o.data_freshness : "",
    key_signals: Array.isArray(o.key_signals) ? (o.key_signals as string[]).filter(s => typeof s === "string") : [],
    data_gaps: Array.isArray(o.data_gaps) ? (o.data_gaps as string[]).filter(s => typeof s === "string") : [],
  };
}

/** 从 LLM 输出抽 JSON（先 ```json 代码块，再找平衡花括号）。复用 ranker 同款逻辑。 */
function extractJson(content: string): unknown | null {
  if (!content) return null;
  const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }
  const start = content.indexOf("{");
  if (start === -1) return null;
  let depth = 0, endIdx = -1, inStr = false, escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  try { return JSON.parse(content.slice(start, endIdx + 1)); } catch { return null; }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/shallow-analyzer.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/shallow-analyzer.ts tests/ts/watchlist/shallow-analyzer.test.ts
git commit -m "feat(rebalance): add analyst-role prompt formatting + parsing"
```

---

### Task 9: shallow-analyzer - risk-role prompt + parse + buildStockReport

**Files:**
- Modify: `src/watchlist/shallow-analyzer.ts`
- Modify: `tests/ts/watchlist/shallow-analyzer.test.ts`

- [ ] **Step 1: Add tests for risk-role + report combining**

Append to test file:

```typescript
import { formatRiskPrompt, parseRiskReport, buildStockReport } from "../../../src/watchlist/shallow-analyzer";
import type { AnalystReport, CandidateMeta } from "../../../src/watchlist/rebalance-types";

describe("formatRiskPrompt", () => {
  it("包含同 analyst 的数据 + analyst 给的 thesis", () => {
    const data: any = {
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 12, pct_20d: 45, support: 25, resistance: 30 },
      news: ["n1"], hot_money: { net_5d: 1 }, fundamentals: { pe: 50, pb: 5, rev_q1: 1, np_q1: 0.1 },
    };
    const analyst: AnalystReport = {
      thesis: "TLVR 电感放量", fitness_score: 8.5, data_freshness: "2026-06-21",
      key_signals: ["订单排至27年"], data_gaps: [],
    };
    const p = formatRiskPrompt(data, analyst);
    expect(p).toContain("TLVR 电感放量");
    expect(p).toContain("SZ300319");
    expect(p).toContain("deal_breaker");
  });
});

describe("parseRiskReport", () => {
  it("解析 risk_flags + overall_risk + deal_breaker", () => {
    const content = JSON.stringify({
      risk_flags: [{ flag: "估值过高", severity: "中", detail: "PE 80x 历史 95% 分位" }],
      overall_risk: "medium",
      deal_breaker: false,
    });
    const r = parseRiskReport(content);
    expect(r).not.toBeNull();
    expect(r!.risk_flags).toHaveLength(1);
    expect(r!.overall_risk).toBe("medium");
    expect(r!.deal_breaker).toBe(false);
  });

  it("空 risk_flags 默认", () => {
    const r = parseRiskReport("{}");
    expect(r).not.toBeNull();
    expect(r!.risk_flags).toEqual([]);
    expect(r!.overall_risk).toBe("low");  // 缺字段默认 low
  });
});

describe("buildStockReport", () => {
  it("合并 analyst + risk + 持仓状态", () => {
    const analyst: AnalystReport = {
      thesis: "TLVR 电感", fitness_score: 8.5, data_freshness: "2026-06-21",
      key_signals: ["订单"], data_gaps: [],
    };
    const risk = {
      risk_flags: [{ flag: "估值", severity: "中" as const, detail: "PE 高" }],
      overall_risk: "medium" as const, deal_breaker: false,
    };
    const meta: CandidateMeta = {
      ticker: "SZ300319", name: "麦捷科技",
      is_held: true, current_weight: 0.05, days_held: 6, locked: true,
      ranker_score: 9.2,
    };
    const report = buildStockReport(meta, "电子", analyst, risk);
    expect(report).toMatchObject({
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      thesis: "TLVR 电感", fitness_score: 8.5,
      is_held: true, current_weight: 0.05, days_held: 6, locked: true,
      ranker_score: 9.2,
      overall_risk: "medium",
    });
  });
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx vitest run tests/ts/watchlist/shallow-analyzer.test.ts`
Expected: 5 new tests FAIL.

- [ ] **Step 3: Implement formatRiskPrompt + parseRiskReport + buildStockReport**

Append to `src/watchlist/shallow-analyzer.ts`:

```typescript
import type { AnalystReport, RiskFlag, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";

const RISK_PROMPT_TEMPLATE = `# 角色
你是 A 股风险分析师，识别单只股票的关键风险。

# 任务
基于以下数据 + analyst 给的 thesis，输出风险清单。不要做 Buy/Sell 判断。

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线 + 资金 + 基本面
（同 analyst-role 输入）

# Analyst thesis
{analyst_thesis}

# 输出格式（严格 JSON）
{
  "risk_flags": [
    { "flag": "...", "severity": "低|中|高", "detail": "..." }
  ],
  "overall_risk": "low|medium|high",
  "deal_breaker": false
}

deal_breaker=true 仅限：财务造假、退市风险、重大违规、产品/客户重大断裂等灾难性情况。`;

export function formatRiskPrompt(d: StockData, analyst: AnalystReport): string {
  return RISK_PROMPT_TEMPLATE
    .replace("{ticker}", d.ticker)
    .replace("{name}", d.name)
    .replace("{sector}", d.sector)
    .replace("{analyst_thesis}", `${analyst.thesis}（fitness ${analyst.fitness_score}）`);
}

export function parseRiskReport(content: string): RiskReport | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const flags = Array.isArray(o.risk_flags) ? (o.risk_flags as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(x => ({
      flag: typeof x.flag === "string" ? x.flag : "",
      severity: (["低", "中", "高"].includes(x.severity as string) ? x.severity : "低") as "低" | "中" | "高",
      detail: typeof x.detail === "string" ? x.detail : "",
    })) : [];
  const risk = ["low", "medium", "high"].includes(o.overall_risk as string) ? o.overall_risk as "low" | "medium" | "high" : "low";
  return {
    risk_flags: flags,
    overall_risk: risk,
    deal_breaker: o.deal_breaker === true,
  };
}

/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。 */
export function buildStockReport(
  meta: CandidateMeta,
  sector: string,
  analyst: AnalystReport,
  risk: RiskReport,
): StockReport {
  return {
    ticker: meta.ticker,
    name: meta.name,
    sector,
    thesis: analyst.thesis,
    fitness_score: analyst.fitness_score,
    key_signals: analyst.key_signals,
    data_gaps: analyst.data_gaps,
    risk_flags: risk.risk_flags,
    overall_risk: risk.overall_risk,
    deal_breaker: risk.deal_breaker,
    is_held: meta.is_held,
    current_weight: meta.current_weight,
    days_held: meta.days_held,
    locked: meta.locked,
    ranker_score: meta.ranker_score,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/shallow-analyzer.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/shallow-analyzer.ts tests/ts/watchlist/shallow-analyzer.test.ts
git commit -m "feat(rebalance): add risk-role prompt + buildStockReport combiner"
```

---

### Task 10: shallow-analyzer analyzeAll（并行 + mockable caller）

**Files:**
- Modify: `src/watchlist/shallow-analyzer.ts`
- Modify: `tests/ts/watchlist/shallow-analyzer.test.ts`

- [ ] **Step 1: Add test for analyzeAll with mock caller**

Append to test file:

```typescript
import { analyzeAll, type ShallowLlmCaller } from "../../../src/watchlist/shallow-analyzer";
import type { CandidateMeta } from "../../../src/watchlist/candidate-selector";

describe("analyzeAll", () => {
  it("对每只股跑 2 calls（analyst + risk），返回 StockReport 数组", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "SZ300319", name: "麦捷科技", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 9.2 },
      { ticker: "SH600183", name: "生益科技", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 9.0 },
    ];
    const dataByTicker = new Map<string, StockData>([
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "电子", kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2 }, news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1 } }],
      ["SH600183", { ticker: "SH600183", name: "生益科技", sector: "PCB", kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2 }, news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1 } }],
    ]);
    const mockCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") {
        return JSON.stringify({ thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      } else {
        return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
      }
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ ticker: "SZ300319", fitness_score: 8, overall_risk: "low" });
  });

  it("单股 LLM 失败 → 该股标 analyzed=false（跳过）", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "OK", name: "ok", is_held: false, current_weight: 0, days_held: 0, locked: false },
      { ticker: "FAIL", name: "fail", is_held: false, current_weight: 0, days_held: 0, locked: false },
    ];
    const dataByTicker = new Map<string, StockData>();
    for (const m of metas) {
      dataByTicker.set(m.ticker, { ticker: m.ticker, name: m.name, sector: "x", kline: { pct_5d: 1, pct_20d: 1, support: 1, resistance: 2 }, news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1 } });
    }
    const mockCaller: ShallowLlmCaller = async ({ role, data }) => {
      if (data.ticker === "FAIL") throw new Error("network");
      return role === "analyst"
        ? JSON.stringify({ thesis: "x", fitness_score: 7, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] })
        : JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports.map(r => r.ticker)).toEqual(["OK"]);  // FAIL 被跳过
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/shallow-analyzer.test.ts -t analyzeAll`
Expected: FAIL.

- [ ] **Step 3: Implement analyzeAll**

Append to `src/watchlist/shallow-analyzer.ts`:

```typescript
export type ShallowLlmCaller = (input: {
  role: "analyst" | "risk";
  data: StockData;
  analyst?: AnalystReport;  // risk-role 才传
}) => Promise<string>;

export interface AnalyzedReport extends StockReport {
  analyzed: boolean;  // false = shallow-analyzer 失败
}

/** 对所有候选/持仓股并行跑 analyst + risk 双 call。
 *  单股失败标 analyzed=false，rebalancer 看不到该股。 */
export async function analyzeAll(
  metas: CandidateMeta[],
  dataByTicker: Map<string, StockData>,
  caller: ShallowLlmCaller,
): Promise<StockReport[]> {
  const results = await Promise.all(metas.map(async meta => {
    const data = dataByTicker.get(meta.ticker);
    if (!data) return null;  // 数据缺失，跳过
    try {
      const analystContent = await caller({ role: "analyst", data });
      const analyst = parseAnalystReport(analystContent);
      if (!analyst) return null;
      const riskContent = await caller({ role: "risk", data, analyst });
      const risk = parseRiskReport(riskContent);
      if (!risk) return null;
      return buildStockReport(meta, data.sector, analyst, risk);
    } catch {
      return null;
    }
  }));
  return results.filter((r): r is StockReport => r !== null);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/shallow-analyzer.test.ts`
Expected: 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/shallow-analyzer.ts tests/ts/watchlist/shallow-analyzer.test.ts
git commit -m "feat(rebalance): add analyzeAll with parallel per-stock LLM calls + graceful skip"
```

---

### Task 11: rebalancer prompt 渲染 + parse

**Files:**
- Create: `src/watchlist/rebalancer.ts`
- Test: `tests/ts/watchlist/rebalancer.test.ts`

- [ ] **Step 1: Write the failing test for prompt + parse**

```typescript
// tests/ts/watchlist/rebalancer.test.ts
import { describe, it, expect } from "vitest";
import { formatRebalancerPrompt, parseRebalancePlan } from "../../../src/watchlist/rebalancer";
import type { StockReport, Holdings, LastRebalance, RebalanceConstraints } from "../../../src/watchlist/rebalance-types";

const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10 };

function makeReport(over: Partial<StockReport> = {}): StockReport {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    thesis: "x", fitness_score: 8, key_signals: [], data_gaps: [],
    risk_flags: [], overall_risk: "low", deal_breaker: false,
    is_held: false, current_weight: 0, days_held: 0, locked: false,
    ...over,
  };
}

describe("formatRebalancerPrompt", () => {
  it("包含约束 + 持仓 + reports", () => {
    const reports = [makeReport({ ticker: "SZ300319" })];
    const holdings: Holdings = { updated_at: "x", cash_pct: 0.15, positions: [] };
    const prompt = formatRebalancerPrompt(reports, holdings, null, C, 7);
    expect(prompt).toContain("0.15");  // single_name
    expect(prompt).toContain("0.30");  // single_sector
    expect(prompt).toContain("SZ300319 麦捷科技");
    expect(prompt).toContain("cash_pct: 0.15");
  });

  it("包含 last_rebalance（防反向）", () => {
    const last: LastRebalance = {
      date: "2026-06-14",
      actions: [{ action: "SELL", ticker: "SH600519", weight: 0.10 }],
    };
    const prompt = formatRebalancerPrompt([], { updated_at: "x", cash_pct: 1, positions: [] }, last, C, 7);
    expect(prompt).toContain("SH600519");
    expect(prompt).toContain("SELL");
  });
});

describe("parseRebalancePlan", () => {
  it("解析完整 JSON（含 evaluations + actions + portfolio_after）", () => {
    const validTickers = new Set(["SZ300319", "SH600519"]);
    const content = JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "好" }],
      actions: [
        { action: "BUY", ticker: "SZ300319", name: "麦捷科技", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "x", priority: 3 },
      ],
      portfolio_after: { positions: [{ ticker: "SZ300319", weight: 0.10 }], cash_pct: 0.90 },
      summary: "x",
    });
    const plan = parseRebalancePlan(content, validTickers);
    expect(plan).not.toBeNull();
    expect(plan!.actions).toHaveLength(1);
    expect(plan!.actions[0]).toMatchObject({ action: "BUY", ticker: "SZ300319", priority: 3 });
    expect(plan!.portfolio_after.cash_pct).toBe(0.90);
  });

  it("过滤幻觉 ticker", () => {
    const valid = new Set(["A"]);
    const content = JSON.stringify({
      evaluations: [],
      actions: [
        { action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 },
        { action: "BUY", ticker: "FAKE", name: "fake", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 },
      ],
      portfolio_after: { positions: [], cash_pct: 0.80 },
      summary: "x",
    });
    const plan = parseRebalancePlan(content, valid)!;
    expect(plan.actions).toHaveLength(1);  // FAKE 过滤掉
    expect(plan.actions[0].ticker).toBe("A");
  });

  it("非 JSON 返回 null", () => {
    expect(parseRebalancePlan("not json", new Set())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement formatRebalancerPrompt + parseRebalancePlan**

```typescript
// src/watchlist/rebalancer.ts
import type {
  Action, ActionType, Evaluation, Holdings, LastRebalance,
  PortfolioAfter, RebalanceConstraints, RebalancePlan, StockReport,
} from "./rebalance-types";

const REBALANCER_PROMPT_TEMPLATE = `# 角色
你是 A 股投资组合管理者，管理一个 5-10 只持仓的中等换手组合。
基于今日候选 + 当前持仓，输出最优调仓方案。

# 任务流程（必须按此顺序思考）
1. 对每只候选/持仓股独立评估：值得入组 / 继续持有 / 应该退出
2. 在硬约束下选择最优组合配置
3. 排序 actions（SELL 优先释放资金，BUY/ADD 用释放的资金）
4. 自检约束 + 自检 anti-churn 锁定

# 评估框架（每股独立判断）

## 候选股（未持仓）
- fitness ≥8 且 risk=low：BUY（target_weight 5-10%）
- fitness ≥8 且 risk=medium：BUY（target_weight ≤5%）或跳过
- fitness 6-7：跳过
- fitness ≤5 或 deal_breaker=true：跳过

## 持仓股
- fitness ≥8 且 risk=low：HOLD 或 ADD（小幅加 2-3%）
- fitness 6-7 且 risk 可控：HOLD（默认）
- fitness ≤5 或 risk=high 或 deal_breaker=true：REDUCE（减半）或 SELL（清仓）
- locked=true（持仓<{anti_churn_days}天）：只能 HOLD 或 ADD，禁止 SELL/REDUCE

# 硬约束（违反则方案作废，validator 会强制 revise）
- 单仓 ≤ {single_name}
- 单行业 ≤ {single_sector}（按 sector 字段聚合）
- 日换手 = sum(|delta|) ≤ {daily_turnover}
- 现金保留 = 1 - sum(target_weight) ≥ {cash_reserve}
- {anti_churn_days} 天内买入的 locked 股禁止 SELL/REDUCE
- {anti_churn_days} 天内卖出过的 ticker 禁止 BUY

# 软偏好
- 优先 fitness ≥7 的标的
- 单日 actions 数量 ≤ 5
- 同行业新增要谨慎

# 反"老好人"硬规则
- fitness ≤5 的持仓必须 REDUCE 或 SELL
- actions 不能全是 HOLD，除非：所有持仓 fitness ≥7 + 所有候选 fitness <6 + 无 deal_breaker
  （"今日低 activity"是合法状态，summary 必须明示）
- fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限

# reason 写作规则（严格）
- 必须含至少 1 个具体词（产品/客户/数据/业务节点）
- 禁止模糊词（共振/资金追捧/活跃/爆发力强...）

# 输出格式（严格 JSON）
{
  "evaluations": [
    { "ticker": "...", "judgment": "BUY|HOLD|REDUCE|SELL|SKIP", "brief": "1 句评估" }
  ],
  "actions": [
    {
      "action": "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD",
      "ticker": "...", "name": "...",
      "current_weight": 0.0, "target_weight": 0.0, "delta": -0.10,
      "reason": "...", "priority": 1
    }
  ],
  "portfolio_after": {
    "positions": [{"ticker": "...", "weight": 0.0}],
    "cash_pct": 0.0
  },
  "summary": "一句话总结"
}

# 当前持仓
{holdings_json}

# 上次调仓（防反向）
{last_rebalance_json}

# 候选股报告（N 只）
{per_stock_reports}`;

export function formatRebalancerPrompt(
  reports: StockReport[],
  holdings: Holdings,
  lastRebalance: LastRebalance | null,
  c: RebalanceConstraints,
  antiChurnDays: number,
): string {
  const holdingsStr = JSON.stringify({
    cash_pct: holdings.cash_pct,
    positions: holdings.positions.map(p => ({
      ticker: p.ticker, name: p.name, sector: p.sector,
      weight: p.weight, days_held: "<from report>",
    })),
  }, null, 2);
  const lastStr = lastRebalance ? JSON.stringify(lastRebalance, null, 2) : "(首次运行，无 last_rebalance)";
  const reportsStr = reports.map(r => formatReportLine(r)).join("\n\n");

  return REBALANCER_PROMPT_TEMPLATE
    .replace(/\{single_name\}/g, String(c.single_name))
    .replace(/\{single_sector\}/g, String(c.single_sector))
    .replace(/\{daily_turnover\}/g, String(c.daily_turnover))
    .replace(/\{cash_reserve\}/g, String(c.cash_reserve))
    .replace(/\{anti_churn_days\}/g, String(antiChurnDays))
    .replace("{holdings_json}", holdingsStr)
    .replace("{last_rebalance_json}", lastStr)
    .replace("{per_stock_reports}", reportsStr);
}

function formatReportLine(r: StockReport): string {
  const flagStr = r.risk_flags.length > 0
    ? r.risk_flags.map(f => `${f.flag}(${f.severity})`).join("; ")
    : "无";
  return [
    `## ${r.ticker} ${r.name} (${r.sector})`,
    `thesis: ${r.thesis}`,
    `fitness: ${r.fitness_score} / risk: ${r.overall_risk}${r.deal_breaker ? " [DEAL_BREAKER]" : ""}`,
    `持仓: ${r.is_held ? `${(r.current_weight * 100).toFixed(1)}%, ${r.days_held}d${r.locked ? " [LOCKED]" : ""}` : "无"}`,
    `风险: ${flagStr}`,
    `关键信号: ${r.key_signals.join("; ") || "无"}`,
    r.ranker_score !== undefined ? `ranker_score: ${r.ranker_score}` : "",
  ].filter(Boolean).join("\n");
}

/** 解析 rebalancer 输出。过滤幻觉 ticker。失败返回 null。 */
export function parseRebalancePlan(content: string, validTickers: Set<string>): RebalancePlan | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.actions) || !Array.isArray(o.evaluations)) return null;

  const actions: Action[] = (o.actions as unknown[])
    .filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object" &&
      typeof (x as any).ticker === "string" && validTickers.has((x as any).ticker))
    .map(x => {
      const a = x as any;
      return {
        action: (["BUY", "SELL", "ADD", "REDUCE", "HOLD"].includes(a.action) ? a.action : "HOLD") as ActionType,
        ticker: a.ticker as string,
        name: typeof a.name === "string" ? a.name : "",
        current_weight: typeof a.current_weight === "number" ? a.current_weight : 0,
        target_weight: typeof a.target_weight === "number" ? a.target_weight : 0,
        delta: typeof a.delta === "number" ? a.delta : 0,
        reason: typeof a.reason === "string" ? a.reason : "",
        priority: typeof a.priority === "number" ? a.priority : 5,
      };
    });

  const evaluations: Evaluation[] = (o.evaluations as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(x => {
      const e = x as any;
      return {
        ticker: typeof e.ticker === "string" ? e.ticker : "",
        judgment: (["BUY", "HOLD", "REDUCE", "SELL", "SKIP"].includes(e.judgment) ? e.judgment : "SKIP") as Evaluation["judgment"],
        brief: typeof e.brief === "string" ? e.brief : "",
      };
    });

  const pa = (o.portfolio_after ?? {}) as any;
  const portfolio_after: PortfolioAfter = {
    positions: Array.isArray(pa.positions) ? pa.positions : [],
    cash_pct: typeof pa.cash_pct === "number" ? pa.cash_pct : 0,
  };

  return {
    evaluations,
    actions,
    portfolio_after,
    summary: typeof o.summary === "string" ? o.summary : "",
  };
}

function extractJson(content: string): unknown | null {
  if (!content) return null;
  const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }
  const start = content.indexOf("{");
  if (start === -1) return null;
  let depth = 0, endIdx = -1, inStr = false, escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  try { return JSON.parse(content.slice(start, endIdx + 1)); } catch { return null; }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/rebalancer.ts tests/ts/watchlist/rebalancer.test.ts
git commit -m "feat(rebalance): add rebalancer prompt + parse with hallucination filter"
```

---

### Task 12: rebalancer revise loop + 主入口

**Files:**
- Modify: `src/watchlist/rebalancer.ts`
- Modify: `tests/ts/watchlist/rebalancer.test.ts`

- [ ] **Step 1: Write tests for revise loop + rebalancePortfolio**

Append to test file:

```typescript
import { runRebalanceWithRevise, type RebalanceLlmCaller, rebalancePortfolio } from "../../../src/watchlist/rebalancer";
import type { RebalanceConfig, RebalancePlan } from "../../../src/watchlist/rebalance-types";
import { DEFAULT_REBALANCE_CONFIG } from "../../../src/watchlist/rebalance-types";

function makePlan(actions: Array<{ action: string; ticker: string; target_weight: number; current_weight: number; delta: number; priority: number }>): RebalancePlan {
  return {
    evaluations: [],
    actions: actions.map(a => ({ action: a.action as any, ticker: a.ticker, name: a.ticker, current_weight: a.current_weight, target_weight: a.target_weight, delta: a.delta, reason: "r", priority: a.priority })),
    portfolio_after: { positions: [], cash_pct: 0 },
    summary: "",
  };
}

describe("runRebalanceWithRevise", () => {
  it("首次输出通过校验 → revise_count=0", async () => {
    const validTickers = new Set(["A", "B"]);
    const ctx = { sectors: new Map([["A", "x"], ["B", "y"]]), held: new Map(), tickersInPool: validTickers, recentSoldTickers: new Set<string>() };
    const caller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [],
      actions: [
        { action: "HOLD", ticker: "A", name: "a", current_weight: 0.45, target_weight: 0.45, delta: 0, reason: "r", priority: 5 },
        { action: "HOLD", ticker: "B", name: "b", current_weight: 0.45, target_weight: 0.45, delta: 0, reason: "r", priority: 5 },
      ],
      portfolio_after: { positions: [{ ticker: "A", weight: 0.45 }, { ticker: "B", weight: 0.45 }], cash_pct: 0.10 },
      summary: "low activity",
    });
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.reviseCount).toBe(0);
    expect(r.plan).not.toBeNull();
  });

  it("首次违反单仓 → revise 1 次后通过", async () => {
    const validTickers = new Set(["A"]);
    const ctx = { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: validTickers, recentSoldTickers: new Set<string>() };
    let callIdx = 0;
    const caller: RebalanceLlmCaller = async () => {
      callIdx++;
      if (callIdx === 1) {
        return JSON.stringify({
          evaluations: [],
          actions: [{ action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.20, delta: 0.20, reason: "r", priority: 3 }],  // 超 15%
          portfolio_after: { positions: [{ ticker: "A", weight: 0.20 }], cash_pct: 0.80 },
          summary: "x",
        });
      }
      return JSON.stringify({
        evaluations: [],
        actions: [{ action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.15, delta: 0.15, reason: "r", priority: 3 }],  // 改成 15%
        portfolio_after: { positions: [{ ticker: "A", weight: 0.15 }], cash_pct: 0.85 },
        summary: "x",
      });
    };
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.reviseCount).toBe(1);
    expect(r.plan!.actions[0].target_weight).toBe(0.15);
  });

  it("revise 用尽 → status=constraint_violation + last_attempt 保留", async () => {
    const validTickers = new Set(["A"]);
    const ctx = { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: validTickers, recentSoldTickers: new Set<string>() };
    const caller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [],
      actions: [{ action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.20, delta: 0.20, reason: "r", priority: 3 }],  // 永远超
      portfolio_after: { positions: [{ ticker: "A", weight: 0.20 }], cash_pct: 0.80 },
      summary: "x",
    });
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.reviseCount).toBe(DEFAULT_REBALANCE_CONFIG.max_revise_retries);
    expect(r.status).toBe("constraint_violation");
    expect(r.plan).not.toBeNull();  // last_attempt 保留
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts -t runRebalanceWithRevise`
Expected: FAIL.

- [ ] **Step 3: Implement runRebalanceWithRevise**

Append to `src/watchlist/rebalancer.ts`:

```typescript
import { validateRebalance, composeReviseFeedback, type ValidationContext } from "./constraint-validator";
import type { RebalanceConfig } from "./rebalance-types";

export type RebalanceLlmCaller = (input: {
  systemPrompt: string;
  userMessage: string;  // 第一次为原 prompt，revise 时为 prompt + feedback
}) => Promise<string>;

export interface RebalanceResult {
  plan: RebalancePlan | null;
  reviseCount: number;
  status: "ok" | "constraint_violation" | "llm_failed";
  finalViolations: ReturnType<typeof validateRebalance>["violations"];
}

/** 跑 rebalancer + revise loop。最多 max_revise_retries 次。 */
export async function runRebalanceWithRevise(
  caller: RebalanceLlmCaller,
  basePrompt: string,
  ctx: ValidationContext,
  config: RebalanceConfig,
): Promise<RebalanceResult> {
  let userMessage = basePrompt;
  let lastPlan: RebalancePlan | null = null;
  let lastViolations: ReturnType<typeof validateRebalance>["violations"] = [];
  let reviseCount = 0;

  for (let attempt = 0; attempt <= config.max_revise_retries; attempt++) {
    let content: string;
    try {
      content = await caller({ systemPrompt: "", userMessage });
    } catch {
      return { plan: lastPlan, reviseCount, status: "llm_failed", finalViolations: lastViolations };
    }

    lastPlan = parseRebalancePlan(content, ctx.tickersInPool);
    if (!lastPlan) {
      // JSON 解析失败，再试一次（算 revise）
      userMessage = basePrompt + "\n\n上一次输出不是合法 JSON，请严格按格式输出。";
      reviseCount++;
      continue;
    }

    const validTickersInPlan = new Set(lastPlan.actions.map(a => a.ticker));
    const result = validateRebalance(lastPlan, ctx, config.constraints);
    if (result.passed) {
      return { plan: lastPlan, reviseCount, status: "ok", finalViolations: [] };
    }
    lastViolations = result.violations;
    if (attempt >= config.max_revise_retries) break;

    const feedback = composeReviseFeedback(result.violations);
    userMessage = basePrompt + "\n\n" + feedback;
    reviseCount++;
  }

  return {
    plan: lastPlan,
    reviseCount,
    status: "constraint_violation",
    finalViolations: lastViolations,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/rebalancer.ts tests/ts/watchlist/rebalancer.test.ts
git commit -m "feat(rebalance): add revise loop with max retries + status tracking"
```

---

### Task 13: rebalancePipeline 主入口 + execution-planner 集成

**Files:**
- Modify: `src/watchlist/rebalancer.ts`
- Modify: `tests/ts/watchlist/rebalancer.test.ts`

- [ ] **Step 1: Write integration test for rebalancePipeline**

Append to test file:

```typescript
import { rebalancePipeline } from "../../../src/watchlist/rebalancer";
import type { Holdings, LastRebalance, RebalanceConfig, StockReport } from "../../../src/watchlist/rebalance-types";
import type { ScanSummary } from "../../../src/watchlist/types";

describe("rebalancePipeline (integration)", () => {
  it("完整 pipeline：候选 + 持仓 → rebalance → validate → execution_plan", async () => {
    // 1 候选 + 1 持仓
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 178,
      groups: { LONG: { total: 35, ranked: 7, excluded: 5, fallback: false }, SHORT: { total: 44, pre_filter: 138, post_common_filter: 110, ranked: 8, excluded: 5, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
      ],
    };
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [{ ticker: "SH600519", name: "贵州茅台", weight: 0.20, entry_price: 1700, entry_date: "2026-05-20", shares: 100, sector: "白酒" }],
    };
    const lastRebalance: LastRebalance = { date: "2026-06-14", actions: [] };

    // mock shallow-analyzer + rebalancer LLM
    const shallowCaller: any = async ({ role, data }) => {
      if (role === "analyst") return JSON.stringify({ thesis: `${data.ticker} thesis`, fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [
        { ticker: "SZ300319", judgment: "BUY", brief: "ok" },
        { ticker: "SH600519", judgment: "HOLD", brief: "hold" },
      ],
      actions: [
        { action: "BUY", ticker: "SZ300319", name: "麦捷科技", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "TLVR 电感放量", priority: 3 },
        { action: "HOLD", ticker: "SH600519", name: "贵州茅台", current_weight: 0.20, target_weight: 0.20, delta: 0, reason: "hold", priority: 5 },
      ],
      portfolio_after: { positions: [{ ticker: "SZ300319", weight: 0.10 }, { ticker: "SH600519", weight: 0.20 }], cash_pct: 0.70 },
      summary: "buy 麦捷科技",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller,
    });

    expect(result.status).toBe("ok");
    expect(result.reports).toHaveLength(2);  // 候选 + 持仓
    expect(result.rebalancer_output.actions).toHaveLength(2);
    expect(result.execution_plan.execution_sequence).toHaveLength(1);  // HOLD 过滤
    expect(result.execution_plan.execution_sequence[0].action).toBe("BUY");
    expect(result.constraint_check.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts -t rebalancePipeline`
Expected: FAIL.

- [ ] **Step 3: Implement rebalancePipeline**

Append to `src/watchlist/rebalancer.ts`:

```typescript
import { selectCandidates, type CandidateMeta } from "./candidate-selector";
import { analyzeAll, type ShallowLlmCaller, type StockData } from "./shallow-analyzer";
import { buildExecutionPlan } from "./execution-planner";
import type {
  Holdings, LastRebalance, RebalanceConfig, RebalancePlanFile, StockReport,
} from "./rebalance-types";
import { DEFAULT_REBALANCE_CONFIG } from "./rebalance-types";
import type { ScanSummary } from "./types";

export interface RebalancePipelineInput {
  scan: ScanSummary;
  holdings: Holdings;
  lastRebalance: LastRebalance | null;
  currentDate: string;
  shallowCaller: ShallowLlmCaller;
  rebalanceCaller: RebalanceLlmCaller;
  dataByTicker?: Map<string, StockData>;  // 测试可注入；CLI 实际从 data scripts 拉
  config?: Partial<RebalanceConfig>;
}

export interface RebalancePipelineResult {
  reports: StockReport[];
  rebalancer_output: RebalancePlan;
  constraint_check: { passed: boolean; violations: string[]; revise_count: number };
  execution_plan: ReturnType<typeof buildExecutionPlan>;
  status: "ok" | "constraint_violation" | "llm_failed";
}

/** 完整 pipeline：候选选择 → shallow-analyzer → rebalancer + revise → execution plan。 */
export async function rebalancePipeline(input: RebalancePipelineInput): Promise<RebalancePipelineResult> {
  const config: RebalanceConfig = { ...DEFAULT_REBALANCE_CONFIG, ...input.config };

  // 1. 候选选择
  const metas = selectCandidates(input.scan, input.holdings, {
    topN: config.top_n,
    currentDate: input.currentDate,
    antiChurnDays: config.anti_churn_days,
  });

  // 2. shallow-analyzer（dataByTicker 由 CLI 注入；测试可直接传）
  const dataByTicker = input.dataByTicker ?? new Map<string, StockData>();
  const reports = await analyzeAll(metas, dataByTicker, input.shallowCaller);

  // 3. 构造 validation context
  const sectors = new Map<string, string>();
  for (const r of reports) sectors.set(r.ticker, r.sector);
  for (const p of input.holdings.positions) {
    if (!sectors.has(p.ticker)) sectors.set(p.ticker, p.sector);
  }
  const held = new Map<string, { days_held: number; locked: boolean }>();
  for (const m of metas) {
    if (m.is_held) held.set(m.ticker, { days_held: m.days_held, locked: m.locked });
  }
  const recentSold = new Set<string>();
  if (input.lastRebalance) {
    const daysSince = Math.floor((new Date(input.currentDate + "T00:00:00+08:00").getTime() -
      new Date(input.lastRebalance.date + "T00:00:00+08:00").getTime()) / (24 * 60 * 60 * 1000));
    if (daysSince < config.anti_churn_days) {
      for (const a of input.lastRebalance.actions) {
        if (a.action === "SELL") recentSold.add(a.ticker);
      }
    }
  }
  const ctx: ValidationContext = {
    sectors, held,
    tickersInPool: new Set(reports.map(r => r.ticker)),
    recentSoldTickers: recentSold,
  };

  // 4. rebalancer + revise
  const prompt = formatRebalancerPrompt(reports, input.holdings, input.lastRebalance, config.constraints, config.anti_churn_days);
  const rebalanceResult = await runRebalanceWithRevise(input.rebalanceCaller, prompt, ctx, config);

  if (!rebalanceResult.plan) {
    return {
      reports,
      rebalancer_output: { evaluations: [], actions: [], portfolio_after: { positions: [], cash_pct: 0 }, summary: "(LLM failed)" },
      constraint_check: { passed: false, violations: [], revise_count: rebalanceResult.reviseCount },
      execution_plan: { execution_sequence: [], final_state: { positions: [], cash_pct: 0 }, warnings: ["LLM failed"] },
      status: rebalanceResult.status,
    };
  }

  // 5. execution plan
  const execution_plan = buildExecutionPlan(rebalanceResult.plan, input.holdings.cash_pct);

  return {
    reports,
    rebalancer_output: rebalanceResult.plan,
    constraint_check: {
      passed: rebalanceResult.status === "ok",
      violations: rebalanceResult.finalViolations.map(v => `[${v.rule}] ${v.detail}`),
      revise_count: rebalanceResult.reviseCount,
    },
    execution_plan,
    status: rebalanceResult.status,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/rebalancer.ts tests/ts/watchlist/rebalancer.test.ts
git commit -m "feat(rebalance): integrate pipeline (select+analyze+rebalance+execute)"
```

---

### Task 14: rebalance-cli.ts + package.json script

**Files:**
- Create: `src/rebalance-cli.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement rebalance-cli.ts**

```typescript
// src/rebalance-cli.ts
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import OpenAI from "openai";
import { callLLM } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { loadHoldings } from "./watchlist/holdings-loader";
import { rebalancePipeline } from "./watchlist/rebalancer";
import { writeAtomicJson } from "./watchlist/atomic-json";
import { formatAnalystPrompt, formatRiskPrompt } from "./watchlist/shallow-analyzer";
import type { ShallowLlmCaller, StockData } from "./watchlist/shallow-analyzer";
import type { RebalanceLlmCaller } from "./watchlist/rebalancer";
import type { LastRebalance, RebalancePlanFile } from "./watchlist/rebalance-types";
import type { ScanSummary } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function findLatestScan(watchlistDir: string): string | null {
  const scanRoot = path.join(watchlistDir, "scan");
  if (!fs.existsSync(scanRoot)) return null;
  const dates = fs.readdirSync(scanRoot)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(scanRoot, d, "scan.json")))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

async function fetchDataForStocks(tickers: string[]): Promise<Map<string, StockData>> {
  // TODO: 真实数据 fetch — 调用 kline.py / news.py / hot_money.py / fundamentals.py
  // 当前 stub 返回空 map（让 shallow-analyzer 全部跳过，pipeline 仍能跑通）
  console.warn(`[warn] 数据 fetch 未实现，${tickers.length} 只股将跳过 shallow-analyzer`);
  return new Map();
}

async function main() {
  const args = process.argv.slice(2);
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
  const date = argValue(args, "--date") ?? findLatestScan(watchlistDir);
  if (!date) {
    console.error(`error: 没找到 scan.json，请先跑 npm run rank`);
    process.exit(1);
  }

  // 读输入
  const holdings = loadHoldings(path.join(watchlistDir, "holdings.json"));
  const scan = JSON.parse(fs.readFileSync(path.join(watchlistDir, "scan", date, "scan.json"), "utf-8")) as ScanSummary;
  const lastRebalancePath = path.join(watchlistDir, "last_rebalance.json");
  const lastRebalance: LastRebalance | null = fs.existsSync(lastRebalancePath)
    ? JSON.parse(fs.readFileSync(lastRebalancePath, "utf-8"))
    : null;

  // LLM 配置
  const apiKey = argValue(args, "--api-key") ?? process.env.OPENAI_API_KEY;
  const baseUrl = argValue(args, "--base-url") ?? process.env.OPENAI_BASE_URL;
  const model = argValue(args, "--model") ?? "glm-4.7";
  if (!apiKey) {
    console.error(`error: 缺 API key`);
    process.exit(2);
  }
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseUrl) clientOpts.baseURL = baseUrl;
  const client = new OpenAI(clientOpts);

  // Trace
  const rebalanceDir = path.join(watchlistDir, "rebalance", date);
  const traceDir = path.join(rebalanceDir, "traces");
  if (fs.existsSync(traceDir)) {
    for (const f of fs.readdirSync(traceDir)) {
      if (f.endsWith(".json")) fs.unlinkSync(path.join(traceDir, f));
    }
  }
  const traceLogger = new TraceLogger(traceDir, `rebalance-${date}`);

  // callers
  const shallowCaller: ShallowLlmCaller = async ({ role, data, analyst }) => {
    const systemPrompt = role === "analyst" ? "A 股综合分析师" : "A 股风险分析师";
    // 用 shallow-analyzer.ts 里的 formatter 渲染完整 prompt
    const userMessage = role === "analyst"
      ? formatAnalystPrompt(data)
      : formatRiskPrompt(data, analyst!);
    const result = await callLLM(client, {
      model, systemPrompt, userMessage,
      phase: "rebalance", role: `${role}-shallow`, traceLogger, temperature: 0.3,
    });
    return result.content;
  };
  const rebalanceCaller: RebalanceLlmCaller = async ({ userMessage }) => {
    const result = await callLLM(client, {
      model, systemPrompt: "A 股投资组合管理者", userMessage,
      phase: "rebalance", role: "portfolio-rebalancer", traceLogger, temperature: 0,
    });
    return result.content;
  };

  console.log(`\nrebalancer 开始: ${date}`);
  console.log(`  模型: ${model}`);
  console.log(`  持仓: ${holdings.positions.length} 支 / cash ${(holdings.cash_pct * 100).toFixed(1)}%`);

  // 拉 data（TODO: 真实实现，目前 stub）
  const allTickers = new Set<string>([
    ...scan.top_picks.slice(0, 10).map(p => p.ticker),
    ...holdings.positions.map(p => p.ticker),
  ]);
  const dataByTicker = await fetchDataForStocks(Array.from(allTickers));

  // 跑 pipeline
  const result = await rebalancePipeline({
    scan, holdings, lastRebalance, currentDate: date,
    shallowCaller, rebalanceCaller, dataByTicker,
  });

  // 写 plan.json
  const planFile: RebalancePlanFile = {
    scan_date: date,
    written_at: new Date().toISOString(),
    status: result.status,
    model,
    tokens: traceLogger.totalTokens,
    holdings_before: holdings,
    candidates: scan.top_picks.slice(0, 10).map(p => ({ ticker: p.ticker, ranker_score: p.score })),
    last_rebalance: lastRebalance,
    reports: result.reports,
    rebalancer_output: result.rebalancer_output,
    constraint_check: result.constraint_check,
    execution_plan: result.execution_plan,
  };
  writeAtomicJson(path.join(rebalanceDir, "plan.json"), planFile);
  writeAtomicJson(path.join(rebalanceDir, "holdings_snapshot.json"), holdings);

  // 更新 last_rebalance.json（即使约束没过也记录，便于复盘）
  if (result.rebalancer_output.actions.length > 0) {
    const newLast: LastRebalance = {
      date,
      actions: result.rebalancer_output.actions
        .filter(a => a.action !== "HOLD")
        .map(a => ({ action: a.action as "BUY" | "SELL" | "ADD" | "REDUCE", ticker: a.ticker, weight: a.target_weight })),
    };
    writeAtomicJson(path.join(watchlistDir, "last_rebalance.json"), newLast);
  }

  // 摘要
  console.log(`\n=== 调仓结果 ===`);
  console.log(`  status: ${result.status}`);
  console.log(`  reports: ${result.reports.length} / 约束: ${result.constraint_check.passed ? "通过" : "违反"} (revise ${result.constraint_check.revise_count})`);
  console.log(`  actions:`);
  for (const a of result.rebalancer_output.actions) {
    const sign = a.delta > 0 ? "+" : "";
    console.log(`    [${a.priority}] ${a.action} ${a.ticker} ${(a.current_weight * 100).toFixed(1)}%→${(a.target_weight * 100).toFixed(1)}% (${sign}${(a.delta * 100).toFixed(1)}%)`);
    console.log(`        ${a.reason}`);
  }
  console.log(`\n  execution_sequence:`);
  for (const s of result.execution_plan.execution_sequence) {
    console.log(`    ${s.step}. ${s.action} ${s.ticker} (${s.weight_delta > 0 ? "+" : ""}${(s.weight_delta * 100).toFixed(1)}%) → cash ${(s.est_cash_after * 100).toFixed(1)}%`);
  }
  if (result.execution_plan.warnings.length > 0) {
    console.log(`\n  warnings:`);
    for (const w of result.execution_plan.warnings) console.log(`    - ${w}`);
  }
  console.log(`\n  tokens: ${traceLogger.totalTokens}`);
  console.log(`  输出: ${path.join(rebalanceDir, "plan.json")}`);
}

if (require.main === module) main().catch(e => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In `package.json`, add to `scripts`:

```json
"rebalance": "node dist/rebalance-cli.js",
```

- [ ] **Step 3: Build and verify it compiles**

Run: `npm run build`
Expected: tsc passes.

- [ ] **Step 4: Smoke test --help equivalent (no args)**

Run: `node dist/rebalance-cli.js 2>&1 | head -5`
Expected: prints "error: 没找到 scan.json" or similar (without crashing on import errors).

- [ ] **Step 5: Commit**

```bash
git add src/rebalance-cli.ts package.json
git commit -m "feat(rebalance): add CLI entry + npm script"
```

---

### Task 15: 端到端 smoke test（真实 scan.json + 假 holdings.json）

**Files:**
- Create: `scripts/smoke-rebalance.js` (临时，验证完删)
- Create: `~/.openclaw/watchlist/holdings.json` (用户首次手动填)

- [ ] **Step 1: 创建假 holdings.json**

```bash
cat > ~/.openclaw/watchlist/holdings.json <<'EOF'
{
  "updated_at": "2026-06-21T20:00:00+08:00",
  "cash_pct": 0.80,
  "positions": [
    {
      "ticker": "SZ300319",
      "name": "麦捷科技",
      "weight": 0.10,
      "entry_price": 25,
      "entry_date": "2026-06-15",
      "shares": 200,
      "sector": "电子"
    },
    {
      "ticker": "SH600183",
      "name": "生益科技",
      "weight": 0.10,
      "entry_price": 30,
      "entry_date": "2026-06-10",
      "shares": 100,
      "sector": "PCB"
    }
  ]
}
EOF
```

- [ ] **Step 2: 跑 rebalance**

```bash
npm run rebalance -- \
  --api-key "04449db5f1814765af8c57e083a41171.xEyPrpeMZ4OZGiTm" \
  --base-url "https://open.bigmodel.cn/api/coding/paas/v4" \
  --model glm-5.1
```

Expected:
- 加载 holdings + scan.json + last_rebalance
- shallow-analyzer 跑（注意 fetchDataForStocks 是 stub，全部跳过）
- rebalancer 跑出 REBALANCE_PLAN
- 写 plan.json + last_rebalance.json
- 控制台摘要显示 actions

- [ ] **Step 3: 验证 plan.json 结构**

Run: `cat ~/.openclaw/watchlist/rebalance/2026-06-21/plan.json | python3 -c "import json, sys; d=json.load(sys.stdin); print('status:', d['status']); print('actions:', len(d['rebalancer_output']['actions'])); print('reports:', len(d['reports']))"`

Expected: 输出非空，结构完整。

- [ ] **Step 4: 清理 smoke 脚本（如有）**

```bash
rm -f scripts/smoke-rebalance.js
```

- [ ] **Step 5: 最终 commit + 总结**

```bash
git add -A
git commit -m "feat(rebalance): smoke test validated end-to-end"
```

---

### Task 16: 真实数据 fetch（fetchDataForStocks 实现）

**Files:**
- Modify: `src/rebalance-cli.ts` (替换 fetchDataForStocks stub)
- Create: `src/watchlist/data-fetcher.ts`
- Test: `tests/ts/watchlist/data-fetcher.test.ts`

stub 让 shallow-analyzer 全部跳过，pipeline 产出没价值。这一步把 4 个 Python script（kline/news/hot_money/fundamentals）真正接入。

- [ ] **Step 1: Write the failing test for parseScriptOutput**

```typescript
// tests/ts/watchlist/data-fetcher.test.ts
import { describe, it, expect } from "vitest";
import { parseKline, parseNews, parseHotMoney, parseFundamentals } from "../../../src/watchlist/data-fetcher";

describe("parseKline", () => {
  it("解析 kline.py 输出 → {pct_5d, pct_20d, support, resistance}", () => {
    // 假设 kline.py 输出 JSON: { closes: [10,11,12,13,14,15], highs: [...], lows: [...] }
    const raw = { closes: [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5, 20, 20.5, 21, 21.5, 22] };
    const k = parseKline(raw);
    expect(k.pct_5d).toBeCloseTo(2.5 / 20 * 100, 1);  // (22-20)/20 * 100 ≈ 10%
    expect(k.pct_20d).toBeCloseTo((22 - 10) / 10 * 100, 1);  // (22-10)/10 * 100 = 120%
    expect(k.support).toBeLessThan(k.resistance);
  });

  it("空 closes → 全 0", () => {
    expect(parseKline({ closes: [] })).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 });
  });
});

describe("parseNews", () => {
  it("提取 news 列表的 title 字段（最多 5 条）", () => {
    const raw = { news: [
      { title: "新闻 1", content: "..." },
      { title: "新闻 2", content: "..." },
    ] };
    expect(parseNews(raw)).toEqual(["新闻 1", "新闻 2"]);
  });

  it("无 news 字段 → 空数组", () => {
    expect(parseNews({})).toEqual([]);
  });
});

describe("parseHotMoney", () => {
  it("提取 net_5d 净流入", () => {
    expect(parseHotMoney({ net_5d: 1.23e8 })).toEqual({ net_5d: 1.23e8 });
  });
  it("缺字段 → 0", () => {
    expect(parseHotMoney({})).toEqual({ net_5d: 0 });
  });
});

describe("parseFundamentals", () => {
  it("提取 pe/pb/rev_q1/np_q1", () => {
    const raw = { pe_ttm: 35.2, pb: 4.5, revenue_q1: 1.2e9, net_profit_q1: 1.3e8 };
    expect(parseFundamentals(raw)).toEqual({ pe: 35.2, pb: 4.5, rev_q1: 1.2e9, np_q1: 1.3e8 });
  });
  it("缺字段 → 0", () => {
    expect(parseFundamentals({})).toEqual({ pe: 0, pb: 0, rev_q1: 0, np_q1: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ts/watchlist/data-fetcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement data-fetcher.ts**

```typescript
// src/watchlist/data-fetcher.ts
import * as path from "path";
import { execPython } from "../exec-python";
import type { StockData } from "./shallow-analyzer";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");

/** 从 kline.py 输出解析 K 线摘要。容忍字段缺失。 */
export function parseKline(raw: any): { pct_5d: number; pct_20d: number; support: number; resistance: number } {
  const closes: number[] = Array.isArray(raw?.closes) ? raw.closes : [];
  if (closes.length < 2) return { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 };
  const last = closes[closes.length - 1];
  const ago5 = closes.length > 5 ? closes[closes.length - 6] : closes[0];
  const ago20 = closes.length > 20 ? closes[closes.length - 21] : closes[0];
  // 简化：support = min(最近 5 日), resistance = max(最近 5 日)
  const recent = closes.slice(-5);
  return {
    pct_5d: ago5 > 0 ? (last - ago5) / ago5 * 100 : 0,
    pct_20d: ago20 > 0 ? (last - ago20) / ago20 * 100 : 0,
    support: Math.min(...recent),
    resistance: Math.max(...recent),
  };
}

export function parseNews(raw: any): string[] {
  if (!Array.isArray(raw?.news)) return [];
  return raw.news.slice(0, 5).map((n: any) => typeof n?.title === "string" ? n.title : "").filter(Boolean);
}

export function parseHotMoney(raw: any): { net_5d: number } {
  return { net_5d: typeof raw?.net_5d === "number" ? raw.net_5d : 0 };
}

export function parseFundamentals(raw: any): { pe: number; pb: number; rev_q1: number; np_q1: number } {
  return {
    pe: typeof raw?.pe_ttm === "number" ? raw.pe_ttm : (typeof raw?.pe === "number" ? raw.pe : 0),
    pb: typeof raw?.pb === "number" ? raw.pb : 0,
    rev_q1: typeof raw?.revenue_q1 === "number" ? raw.revenue_q1 : (typeof raw?.rev_q1 === "number" ? raw.rev_q1 : 0),
    np_q1: typeof raw?.net_profit_q1 === "number" ? raw.net_profit_q1 : (typeof raw?.np_q1 === "number" ? raw.np_q1 : 0),
  };
}

/** 单股并行跑 4 个 script。失败的 script 返回 null 字段（容忍）。 */
export async function fetchStockData(
  ticker: string,
  name: string,
  sector: string,
  rankerThesis?: string,
): Promise<StockData | null> {
  const symbol = ticker;  // kline.py 等用 symbol
  const tasks = [
    execPython(path.join(SKILLS_DIR, "trading-kline", "kline.py"), [symbol]),
    execPython(path.join(SKILLS_DIR, "trading-news", "news.py"), [symbol]),
    execPython(path.join(SKILLS_DIR, "trading-hot-money", "hot_money.py"), [symbol]),
    execPython(path.join(SKILLS_DIR, "trading-fundamentals", "fundamentals.py"), [symbol]),
  ];
  const [klineR, newsR, hotR, fundR] = await Promise.allSettled(tasks);

  const kline = klineR.status === "fulfilled" ? parseKline(klineR.value.data) : { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 };
  const news = newsR.status === "fulfilled" ? parseNews(newsR.value.data) : [];
  const hot = hotR.status === "fulfilled" ? parseHotMoney(hotR.value.data) : { net_5d: 0 };
  const fund = fundR.status === "fulfilled" ? parseFundamentals(fundR.value.data) : { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 };

  return {
    ticker, name, sector,
    kline, news,
    hot_money: hot,
    fundamentals: fund,
    ranker_thesis: rankerThesis,
  };
}

/** 跨股并行 fetch（concurrency=5）。失败的股跳过。 */
export async function fetchAllStockData(
  metas: Array<{ ticker: string; name: string; sector: string; ranker_thesis?: string }>,
  concurrency: number = 5,
): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  const queue = [...metas];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const meta = queue.shift()!;
        try {
          const data = await fetchStockData(meta.ticker, meta.name, meta.sector, meta.ranker_thesis);
          if (data) result.set(meta.ticker, data);
        } catch {
          // 跳过失败的股
        }
      }
    })());
  }
  await Promise.all(workers);
  return result;
}
```

Note: `execPython` is the existing helper in `src/exec-python.ts`. Check its signature and adapt the call above if it differs.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/ts/watchlist/data-fetcher.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Wire into rebalance-cli.ts**

Replace the stub `fetchDataForStocks` in `src/rebalance-cli.ts`:

```typescript
// 旧 stub 删除，改用 fetchAllStockData
import { fetchAllStockData } from "./watchlist/data-fetcher";

// 在 main() 里：
const metasForFetch = [
  ...scan.top_picks.slice(0, 10).map(p => ({
    ticker: p.ticker, name: p.name,
    sector: holdings.positions.find(pos => pos.ticker === p.ticker)?.sector ?? "未分类",
    ranker_thesis: p.reason,
  })),
  ...holdings.positions.map(p => ({ ticker: p.ticker, name: p.name, sector: p.sector })),
];
// 去重
const seen = new Set<string>();
const dedupMetas = metasForFetch.filter(m => seen.has(m.ticker) ? false : (seen.add(m.ticker), true));
console.log(`  拉数据: ${dedupMetas.length} 只股 × 4 scripts（并行 5）`);
const dataByTicker = await fetchAllStockData(dedupMetas, 5);
console.log(`  数据就绪: ${dataByTicker.size}/${dedupMetas.length} 只`);
```

- [ ] **Step 6: Run full pipeline smoke test**

```bash
npm run build
npm run rebalance -- \
  --api-key "04449db5f1814765af8c57e083a41171.xEyPrpeMZ4OZGiTm" \
  --base-url "https://open.bigmodel.cn/api/coding/paas/v4" \
  --model glm-5.1
```

Expected:
- 看到数据 fetch 进度
- shallow-analyzer 跑出非空 reports
- rebalancer 出 REBALANCE_PLAN
- plan.json reports 字段非空

- [ ] **Step 7: Commit**

```bash
git add src/watchlist/data-fetcher.ts tests/ts/watchlist/data-fetcher.test.ts src/rebalance-cli.ts
git commit -m "feat(rebalance): implement real data fetch via 4 python scripts in parallel"
```

---

## Self-Review Notes

**Spec coverage:**
- §3 (holdings/last_rebalance schema) → Task 1 (types) + Task 2 (loader)
- §4 (shallow-analyzer) → Task 3 (selector) + Tasks 8-10 (analyzer) + Task 16 (data fetch)
- §5 (rebalancer) → Tasks 11-13
- §6 (constraint-validator 10 rules) → Tasks 4-6
- §7 (execution-planner) → Task 7
- §8 (outputs) → Task 14
- §9 (errors) → 各任务内的失败处理
- §10 (config) → Task 1 DEFAULT_REBALANCE_CONFIG + Task 14 CLI
- §11 (file list + tests) → 全覆盖
- §12 (后续扩展) → 不在 plan，spec 已记

**Placeholder scan:** 已修正 Task 14 stub caller（改用 formatAnalystPrompt/formatRiskPrompt）。Task 16 实现真实数据 fetch。

**Type consistency:**
- `ActionType` 在 Task 1 定义，Task 5 rule 8 使用字符串字面量比较 — 一致
- `ValidationContext` 在 Task 4 定义、Task 12 使用 — 一致
- `ShallowLlmCaller`/`RebalanceLlmCaller` 类型在 shallow-analyzer.ts/rebalancer.ts 定义，CLI 使用 — 一致
- `StockData` 在 Task 8 定义、Task 16 扩展使用 — 一致
