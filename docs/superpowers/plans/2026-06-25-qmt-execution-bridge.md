# QMT 执行桥 — 开发机端（TS）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 rebalancer 产出带 `order_id` + `execution:pending` + `execution_sequence` 的 `last_rebalance.json`，供下游 QMT 执行器消费；并实现 `holdings-merge` 字段级合并契约 + `syncPush` 把文件推到 trading-state repo。

**Architecture:** 纯增量包装——rebalancer 决策逻辑零改动，只在落盘 `last_rebalance.json` 时多包一层 execution 信封。新增 4 个 TS 文件 + 改 1 个，全部可 mock 测试，Mac 端零依赖 xtquant。

**Tech Stack:** TypeScript (strict, ES2020, CommonJs), Vitest (globals, node env), Node fs/path/crypto。遵循现有 `src/watchlist/` 模式：纯函数 + 类型在 `rebalance-types.ts`。

**对应 Spec:** `docs/superpowers/specs/2026-06-25-qmt-execution-bridge-design.md`（§5 数据契约 / §7.1 开发机端组件）

**Scope:** 仅 TS 开发机端。Python 云服务器端 executor、private repo 初始化是后续独立 plan（依赖本 plan 产出的 json 格式）。

---

## 文件结构

| 文件 | 责任 | 状态 |
|---|---|---|
| `src/watchlist/rebalance-types.ts` | 加 `Execution`/`Fill`/`OrderId` 类型 + 扩展 `LastRebalance`；加 `ExecutionStep` 已有 | 改（加类型） |
| `src/watchlist/order-id.ts` | `computeOrderId()` 纯函数（sha256 前 6 位） | 新增 |
| `src/watchlist/execution-schema.ts` | `isTerminal()`/`isPending()` 状态机校验纯函数 | 新增 |
| `src/watchlist/holdings-merge.ts` | `mergeHoldings()` 字段级合并纯函数（合并契约的 TS 权威实现） | 新增 |
| `src/rebalance-cli.ts:316-323` | 落盘时包 execution 信封 | 改（最小） |
| `src/watchlist/execution-bridge.ts` | `syncPush()` 复制+git push + 冲突仲裁 | 新增 |
| `tests/ts/watchlist/order-id.test.ts` | order_id 幂等/规范化测试 | 新增 |
| `tests/ts/watchlist/execution-schema.test.ts` | 状态流转测试 | 新增 |
| `tests/ts/watchlist/holdings-merge.test.ts` | 合并规则测试（mock QMT 数据） | 新增 |
| `tests/ts/watchlist/execution-bridge.test.ts` | syncPush + 冲突仲裁测试（mock git/fs） | 新增 |

**依赖顺序**：类型(T1) → order-id(T2) → execution-schema(T3) → holdings-merge(T4) → rebalance-cli 集成(T5) → syncPush(T6)。每个任务自包含、可独立验证。

---

## Task 1: 扩展 rebalance-types.ts 加 Execution 类型

**Files:**
- Modify: `src/watchlist/rebalance-types.ts:21-33`（`LastRebalanceAction` + `LastRebalance` 区域）

- [ ] **Step 1: 写类型定义（先于实现，类型即契约）**

在 `src/watchlist/rebalance-types.ts` 的 `LastRebalanceAction` interface 之后、`LastRebalance` 之前，加入 Fill + Execution 类型；并扩展 `LastRebalance` 加 3 个可选字段（向后兼容旧文件）：

```ts
export interface Fill {
  ticker: string;
  action: "BUY" | "SELL" | "ADD" | "REDUCE";
  /** QMT 委托号，溯源/撤单用。pending 时为空串。 */
  order_sys_id: string;
  filled_price: number;
  filled_volume: number;             // 实际成交股数
  intended_volume: number;           // 计划股数，部分成交时对比
  status: "filled" | "partial" | "rejected" | "cancelled";
}

export type ExecStatus = "pending" | "executing" | "filled" | "partial" | "failed";

export interface Execution {
  status: ExecStatus;
  /** ISO timestamp，云服务器回填。pending/executing 时为 null。 */
  executed_at: string | null;
  /** 执行时总资产（元），对账溯源用（下单换算用实时查的值）。pending 时为 null。 */
  account_total_asset: number | null;
  fills: Fill[];
  errors: string[];
}
```

然后把 `LastRebalance` 从：

```ts
export interface LastRebalance {
  date: string;
  actions: LastRebalanceAction[];
  /** ticker → 最近卖出日期（YYYY-MM-DD）。跨多次 rebalance 累积，用于 anti-churn 买锁。
   *  旧版 last_rebalance.json 无此字段（向后兼容：undefined 视为空）。 */
  recent_sells?: Record<string, string>;
}
```

扩展为（3 个新字段都 optional，旧文件无 execution/order_id 仍能加载）：

```ts
export interface LastRebalance {
  date: string;
  /** 幂等键：date + "-" + sha256(canonicalize(actions)).slice(0,6)。
   *  旧版无此字段（视为 pending 旧订单）。 */
  order_id?: string;
  actions: LastRebalanceAction[];
  /** Mac 算好的下单顺序（SELL→REDUCE→BUY→ADD，按 |delta| 降序）。
   *  供云服务器 Python 直接读、不重算。旧版无此字段。 */
  execution_sequence?: ExecutionStep[];
  /** ticker → 最近卖出日期（YYYY-MM-DD）。跨多次 rebalance 累积，用于 anti-churn 买锁。
   *  旧版 last_rebalance.json 无此字段（向后兼容：undefined 视为空）。 */
  recent_sells?: Record<string, string>;
  /** 订单执行状态机。云服务器执行后回填。开发机产出时写 pending 占位。
   *  旧版无此字段（视为从未执行）。 */
  execution?: Execution;
}
```

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit`
Expected: 无输出（pass）。若报错，说明 `ExecutionStep` 引用需确认——它已在 `rebalance-types.ts:126` 定义，无需新增。

- [ ] **Step 3: 确认现有测试不受影响**

Run: `npm run build && npx vitest run tests/ts/watchlist/holdings-loader.test.ts`
Expected: PASS（类型扩展是 optional 字段，旧 fixture 仍合法）。

- [ ] **Step 4: Commit**

```bash
git add src/watchlist/rebalance-types.ts
git commit -m "feat(execution-bridge): 加 Execution/Fill 类型 + 扩展 LastRebalance

execution 信封的字段类型（status 状态机 + fills + errors），
order_id 幂等键，execution_sequence 下单顺序。全部 optional，向后兼容。"
```

---

## Task 2: order-id.ts — 幂等键计算（纯函数）

**Files:**
- Create: `src/watchlist/order-id.ts`
- Test: `tests/ts/watchlist/order-id.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/ts/watchlist/order-id.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { computeOrderId, canonicalizeActions } from "../../../src/watchlist/order-id";
import type { LastRebalanceAction } from "../../../src/watchlist/rebalance-types";

const acts: LastRebalanceAction[] = [
  { action: "SELL", ticker: "SZ300319", weight: 0 },
  { action: "REDUCE", ticker: "SH600183", weight: 0.05 },
];

describe("canonicalizeActions", () => {
  it("按 ticker 排序 + weight 四舍五入到 4 位", () => {
    const unsorted: LastRebalanceAction[] = [
      { action: "REDUCE", ticker: "SH600183", weight: 0.0500001 },
      { action: "SELL", ticker: "SZ300319", weight: 0 },
    ];
    expect(canonicalizeActions(unsorted)).toBe(
      canonicalizeActions([acts[1], acts[0]]),  // 手动排好序的应等价
    );
  });

  it("浮点尾差不影响规范化（0.05 vs 0.0500001 同 id）", () => {
    const a: LastRebalanceAction[] = [{ action: "BUY", ticker: "X", weight: 0.1 }];
    const b: LastRebalanceAction[] = [{ action: "BUY", ticker: "X", weight: 0.10000003 }];
    expect(canonicalizeActions(a)).toBe(canonicalizeActions(b));
  });
});

describe("computeOrderId", () => {
  it("格式 = date-<6位hex>", () => {
    const id = computeOrderId("2026-06-23", acts);
    expect(id).toMatch(/^2026-06-23-[a-f0-9]{6}$/);
  });

  it("相同 actions（任意顺序）→ 相同 id", () => {
    expect(computeOrderId("2026-06-23", [acts[1], acts[0]]))
      .toBe(computeOrderId("2026-06-23", acts));
  });

  it("改任一 weight → id 变（超出 4 位精度）", () => {
    const changed = [{ ...acts[0], weight: 0.01 }];
    expect(computeOrderId("2026-06-23", [...changed, acts[1]]))
      .not.toBe(computeOrderId("2026-06-23", acts));
  });

  it("不同 date → id 不同（即使 actions 相同）", () => {
    expect(computeOrderId("2026-06-24", acts))
      .not.toBe(computeOrderId("2026-06-23", acts));
  });

  it("确定性：同输入两次调用结果相同", () => {
    expect(computeOrderId("2026-06-23", acts))
      .toBe(computeOrderId("2026-06-23", acts));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/watchlist/order-id.test.ts`
Expected: FAIL — "Cannot find module '../../../src/watchlist/order-id'"

- [ ] **Step 3: 实现**

`src/watchlist/order-id.ts`：

```ts
// src/watchlist/order-id.ts
//
// order_id 幂等键：让云服务器能识别"这份订单执行过了，跳过"。
// 算法：date + "-" + sha256(canonicalize(actions)).slice(0,6)
// 规范化（按 ticker 排序 + weight 四舍五入到 4 位）保证：
//   - Mac 重跑 rebalancer 若 actions 内容不变 → id 不变 → 跳过
//   - actions 顺序乱 → id 不变（规范化生效）
//   - 改任一 weight（超 4 位精度）→ id 变 → 视为新订单

import * as crypto from "crypto";
import type { LastRebalanceAction } from "./rebalance-types";

/** 规范化 actions 到稳定字符串：按 ticker 排序，weight 四舍五入到 4 位。 */
export function canonicalizeActions(actions: LastRebalanceAction[]): string {
  const sorted = [...actions].sort((a, b) => a.ticker.localeCompare(b.ticker));
  return JSON.stringify(sorted.map(a => ({
    action: a.action,
    ticker: a.ticker,
    weight: Number(a.weight.toFixed(4)),
  })));
}

/** 计算幂等 order_id："YYYY-MM-DD-<6位hex>"。 */
export function computeOrderId(date: string, actions: LastRebalanceAction[]): string {
  const hash = crypto.createHash("sha256").update(canonicalizeActions(actions)).digest("hex");
  return `${date}-${hash.slice(0, 6)}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/watchlist/order-id.test.ts`
Expected: PASS（全部 6 个 case）。

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/order-id.ts tests/ts/watchlist/order-id.test.ts
git commit -m "feat(execution-bridge): order-id 幂等键计算

canonicalizeActions（按 ticker 排序 + weight 4 位）+ computeOrderId
（sha256 前 6 位）。让云服务器能识别已执行的订单。"
```

---

## Task 3: execution-schema.ts — 状态机校验（纯函数）

**Files:**
- Create: `src/watchlist/execution-schema.ts`
- Test: `tests/ts/watchlist/execution-schema.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/ts/watchlist/execution-schema.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { isTerminal, isPending, makePendingExecution } from "../../../src/watchlist/execution-schema";
import type { ExecStatus } from "../../../src/watchlist/rebalance-types";

describe("isTerminal", () => {
  it("filled/partial/failed 是终态", () => {
    for (const s of ["filled", "partial", "failed"] as ExecStatus[]) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it("pending/executing 非终态", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("executing")).toBe(false);
  });
});

describe("isPending", () => {
  it("只有 pending 为 true", () => {
    expect(isPending("pending")).toBe(true);
    expect(isPending("executing")).toBe(false);
    expect(isPending("filled")).toBe(false);
  });
});

describe("makePendingExecution", () => {
  it("产出标准 pending 占位", () => {
    const e = makePendingExecution();
    expect(e).toEqual({
      status: "pending",
      executed_at: null,
      account_total_asset: null,
      fills: [],
      errors: [],
    });
  });

  it("每次调用返回新对象（无共享引用）", () => {
    const a = makePendingExecution();
    const b = makePendingExecution();
    a.fills.push({ ticker: "X", action: "BUY", order_sys_id: "", filled_price: 0, filled_volume: 0, intended_volume: 0, status: "filled" });
    expect(b.fills).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/watchlist/execution-schema.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 实现**

`src/watchlist/execution-schema.ts`：

```ts
// src/watchlist/execution-schema.ts
//
// Execution 状态机校验纯函数。状态流转：
//   pending ──(云服务器开始执行)──▶ executing ──┬─ filled   全部成交
//                                              ├─ partial  部分成交
//                                              └─ failed   全部失败/拒单
// 终态（filled/partial/failed）不可回退。
// 这些函数同时被开发机（syncPush 仲裁）和测试使用，云服务器 Python 端
// 有等价实现（见 merge.py / git_sync.py）。

import type { ExecStatus, Execution } from "./rebalance-types";

/** 终态：filled/partial/failed。终态订单不可被 pending 覆盖。 */
export function isTerminal(status: ExecStatus): boolean {
  return status === "filled" || status === "partial" || status === "failed";
}

/** 待执行：仅 pending。 */
export function isPending(status: ExecStatus): boolean {
  return status === "pending";
}

/** 开发机产出订单时的标准 pending 占位。每次返回新对象避免共享引用。 */
export function makePendingExecution(): Execution {
  return {
    status: "pending",
    executed_at: null,
    account_total_asset: null,
    fills: [],
    errors: [],
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/watchlist/execution-schema.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/execution-schema.ts tests/ts/watchlist/execution-schema.test.ts
git commit -m "feat(execution-bridge): execution 状态机校验纯函数

isTerminal/isPending/makePendingExecution。供 syncPush 冲突仲裁 +
测试。云服务器端有等价 Python 实现。"
```

---

## Task 4: holdings-merge.ts — 字段级合并契约（纯函数）

**Files:**
- Create: `src/watchlist/holdings-merge.ts`
- Test: `tests/ts/watchlist/holdings-merge.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/ts/watchlist/holdings-merge.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mergeHoldings } from "../../../src/watchlist/holdings-merge";
import type { Holdings } from "../../../src/watchlist/rebalance-types";
import type { QmtPosition, QmtAsset } from "../../../src/watchlist/holdings-merge";

const remote: Holdings = {
  updated_at: "2026-06-21T20:00:00+08:00",
  cash_pct: 0.80,
  positions: [
    { ticker: "SZ300319", name: "麦捷科技", weight: 0.10, entry_price: 25, entry_date: "2026-06-15", shares: 200, sector: "电子" },
    { ticker: "SH600183", name: "生益科技", weight: 0.10, entry_price: 30, entry_date: "2026-06-10", shares: 100, sector: "PCB" },
  ],
};

const asset: QmtAsset = { total: 100000, cash: 95000 };  // 5% 仓位

describe("mergeHoldings — 市场字段以 QMT 为准", () => {
  it("QMT 持仓覆盖 shares/entry_price/entry_date", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 150, open_price: 26.5, open_date: "2026-06-15", market_value: 3975, can_use_volume: 150 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    const p = merged.positions.find(x => x.ticker === "SZ300319")!;
    expect(p.shares).toBe(150);
    expect(p.entry_price).toBe(26.5);
    expect(p.entry_date).toBe("2026-06-15");
  });

  it("weight 重算 = market_value / total_asset", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 150, open_price: 26.5, open_date: "2026-06-15", market_value: 3975, can_use_volume: 150 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SZ300319")!.weight)
      .toBeCloseTo(3975 / 100000, 4);
  });

  it("cash_pct 重算 = cash / total", () => {
    const merged = mergeHoldings(remote, [], asset);
    expect(merged.cash_pct).toBeCloseTo(95000 / 100000, 4);
  });
});

describe("mergeHoldings — 本地字段保留", () => {
  it("sector 保留（QMT 无此字段）", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 200, open_price: 25, open_date: "2026-06-15", market_value: 5000, can_use_volume: 200 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SZ300319")!.sector).toBe("电子");
  });

  it("name 保留（QMT 不提供）", () => {
    const positions: QmtPosition[] = [
      { ticker: "SH600183", volume: 100, open_price: 30, open_date: "2026-06-10", market_value: 3000, can_use_volume: 100 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SH600183")!.name).toBe("生益科技");
  });
});

describe("mergeHoldings — 增删", () => {
  it("QMT 有但 remote 无 → 新增（sector 标"未分类"）", () => {
    const positions: QmtPosition[] = [
      { ticker: "SH600519", volume: 10, open_price: 1700, open_date: "2026-06-20", market_value: 17000, can_use_volume: 10 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    const p = merged.positions.find(x => x.ticker === "SH600519");
    expect(p).toBeDefined();
    expect(p!.sector).toBe("未分类");
    expect(p!.shares).toBe(10);
  });

  it("remote 有但 QMT volume=0 → 清仓删除", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 0, open_price: 25, open_date: "2026-06-15", market_value: 0, can_use_volume: 0 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SZ300319")).toBeUndefined();
  });
});

describe("mergeHoldings — 更新时间", () => {
  it("updated_at 更新为现在", () => {
    const merged = mergeHoldings(remote, [], asset);
    expect(merged.updated_at).not.toBe("2026-06-21T20:00:00+08:00");
    expect(new Date(merged.updated_at).getTime()).toBeLessThan(Date.now() + 1000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/watchlist/holdings-merge.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 实现**

`src/watchlist/holdings-merge.ts`：

```ts
// src/watchlist/holdings-merge.ts
//
// 持仓字段级合并契约（TS 权威实现）。云服务器执行订单后调此函数把 QMT
// 真实持仓合并进 holdings.json：
//   - 市场字段（shares/entry_price/entry_date/weight/cash_pct）以 QMT 为准
//   - 本地字段（sector/name）保留（QMT 查不到）
//   - QMT volume=0 的清仓股删除
//   - QMT 新出现的持仓新增（sector 标"未分类"）
// Python 端 merge.py 有等价实现（跨语言一致性测试固定 fixture）。
// 此函数也在 TS 端用于文档化契约 + 测试验证合并规则。

import type { Holdings, Position } from "./rebalance-types";

/** QMT 持仓查询结果的 TS 侧表示（Python query_stock_positions 映射而来）。 */
export interface QmtPosition {
  ticker: string;             // "SZ300319" 格式（Python 端先转好）
  volume: number;             // 总持仓
  open_price: number;         // 成本价
  open_date: string;          // "YYYY-MM-DD"
  market_value: number;
  can_use_volume: number;     // T+1 可卖
}

/** QMT 资产查询结果。 */
export interface QmtAsset {
  total: number;              // 总资产（元）
  cash: number;               // 现金（元）
}

/** 字段级合并：QMT 市场字段覆盖，本地字段保留，清仓删除，新仓新增。 */
export function mergeHoldings(
  remote: Holdings,
  qmtPositions: QmtPosition[],
  qmtAsset: QmtAsset,
): Holdings {
  const remoteByTicker = new Map<string, Position>();
  for (const p of remote.positions) remoteByTicker.set(p.ticker, p);

  const mergedPositions: Position[] = [];
  for (const qp of qmtPositions) {
    if (qp.volume === 0) continue;  // 清仓删除
    const existing = remoteByTicker.get(qp.ticker);
    mergedPositions.push({
      ticker: qp.ticker,
      // name/sector 保留本地（QMT 不提供）；新仓 name 留空待补
      name: existing?.name ?? "",
      sector: existing?.sector ?? "未分类",
      shares: qp.volume,
      entry_price: qp.open_price,
      entry_date: qp.open_date,
      weight: qmtAsset.total > 0 ? qp.market_value / qmtAsset.total : 0,
    });
  }

  return {
    updated_at: new Date().toISOString(),
    cash_pct: qmtAsset.total > 0 ? qmtAsset.cash / qmtAsset.total : 0,
    positions: mergedPositions,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/watchlist/holdings-merge.test.ts`
Expected: PASS（全部 case）。

- [ ] **Step 5: Commit**

```bash
git add src/watchlist/holdings-merge.ts tests/ts/watchlist/holdings-merge.test.ts
git commit -m "feat(execution-bridge): holdings 字段级合并契约

mergeHoldings：QMT 市场字段覆盖、本地 sector/name 保留、清仓删除、
新仓新增。TS 权威实现，Python merge.py 有等价版本。"
```

---

## Task 5: 集成到 rebalance-cli.ts — 落盘 execution 信封

**Files:**
- Modify: `src/rebalance-cli.ts:316-323`（写 last_rebalance.json 处）
- Modify: `src/rebalance-cli.ts:1-23`（import）

- [ ] **Step 1: 加 import**

在 `src/rebalance-cli.ts` 顶部 import 区（`import type { LastRebalance, ... } from "./watchlist/rebalance-types";` 那行附近），加：

```ts
import { computeOrderId } from "./watchlist/order-id";
import { makePendingExecution } from "./watchlist/execution-schema";
```

- [ ] **Step 2: 改写 last_rebalance.json 落盘逻辑**

把 `src/rebalance-cli.ts:316-323` 这段：

```ts
    const newLast: LastRebalance = {
      date,
      actions: result.rebalancer_output.actions
        .filter(a => a.action !== "HOLD")
        .map(a => ({ action: a.action as "BUY" | "SELL" | "ADD" | "REDUCE", ticker: a.ticker, weight: a.target_weight })),
      recent_sells: mergedSells,
    };
    writeAtomicJson(path.join(watchlistDir, "last_rebalance.json"), newLast);
```

替换为：

```ts
    const newActions = result.rebalancer_output.actions
      .filter(a => a.action !== "HOLD")
      .map(a => ({ action: a.action as "BUY" | "SELL" | "ADD" | "REDUCE", ticker: a.ticker, weight: a.target_weight }));

    const newLast: LastRebalance = {
      date,
      order_id: computeOrderId(date, newActions),
      actions: newActions,
      // execution_sequence 由现有 buildExecutionPlan 算好（SELL→REDUCE→BUY→ADD），
      // 云服务器 Python 直接读、不重算，避免排序逻辑双端漂移。
      execution_sequence: result.execution_plan.execution_sequence,
      recent_sells: mergedSells,
      // execution 信封：开发机产 pending 占位，云服务器执行后回填。
      execution: makePendingExecution(),
    };
    writeAtomicJson(path.join(watchlistDir, "last_rebalance.json"), newLast);
```

- [ ] **Step 3: typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 无输出（pass）。

- [ ] **Step 4: 验证现有 rebalancer 测试不破**

Run: `npx vitest run tests/ts/watchlist/rebalancer.test.ts`
Expected: PASS。rebalancer.ts 本身没改，但确认 cli 集成点类型对齐。

- [ ] **Step 5: 手动验证产出的 json 结构（dry-run 思路）**

无需真实 LLM/API key——直接验证 computeOrderId + execution 信封拼装正确。在 `tests/ts/watchlist/` 下临时加一个集成测试 `rebalance-cli-integration.test.ts`（可选，但推荐确保信封正确）：

```ts
import { describe, it, expect } from "vitest";
import { computeOrderId } from "../../../src/watchlist/order-id";
import { makePendingExecution } from "../../../src/watchlist/execution-schema";
import type { LastRebalance } from "../../../src/watchlist/rebalance-types";

describe("last_rebalance.json 信封结构", () => {
  it("完整字段：order_id + actions + execution_sequence + execution", () => {
    const actions = [{ action: "SELL" as const, ticker: "SZ300319", weight: 0 }];
    const last: LastRebalance = {
      date: "2026-06-23",
      order_id: computeOrderId("2026-06-23", actions),
      actions,
      execution_sequence: [{ step: 1, action: "SELL", ticker: "SZ300319", name: "麦捷科技", weight_delta: -0.10, est_cash_after: 0.90 }],
      recent_sells: { SZ300319: "2026-06-23" },
      execution: makePendingExecution(),
    };
    expect(last.order_id).toMatch(/^2026-06-23-[a-f0-9]{6}$/);
    expect(last.execution!.status).toBe("pending");
    expect(last.execution_sequence).toHaveLength(1);
  });
});
```

Run: `npx vitest run tests/ts/watchlist/rebalance-cli-integration.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/rebalance-cli.ts tests/ts/watchlist/rebalance-cli-integration.test.ts
git commit -m "feat(execution-bridge): rebalance-cli 落盘 execution 信封

跑完 plan 后 last_rebalance.json 带 order_id（幂等）+
execution_sequence（下单顺序）+ execution:pending（状态机占位）。
rebalancer 决策逻辑零改动，纯增量包装。"
```

---

## Task 6: execution-bridge.ts — syncPush 推到 trading-state repo

**Files:**
- Create: `src/watchlist/execution-bridge.ts`
- Test: `tests/ts/watchlist/execution-bridge.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/ts/watchlist/execution-bridge.test.ts`（mock fs + child_process，避免真实 git 操作）：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { syncPush, ConflictAbortedError } from "../../../src/watchlist/execution-bridge";
import type { LastRebalance } from "../../../src/watchlist/rebalance-types";

// mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
// mock child_process（git 操作）
const execMock = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => execMock(...args),
}));

const fsMock = fs as unknown as { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn>; copyFileSync: ReturnType<typeof vi.fn> };

const pendingLast = (): LastRebalance => ({
  date: "2026-06-23",
  order_id: "2026-06-23-abc123",
  actions: [{ action: "SELL", ticker: "SZ300319", weight: 0 }],
  execution: { status: "pending", executed_at: null, account_total_asset: null, fills: [], errors: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.existsSync.mockReturnValue(true);
  execMock.mockImplementation((cmd: string) => {
    // 默认 git 命令都成功，返回空字符串
    if (cmd.includes("fetch") || cmd.includes("rev-parse")) return "";
    if (cmd.includes("status") && cmd.includes("behind")) return "";  // 无分叉
    return "";
  });
});

describe("syncPush — 正常流程", () => {
  it("复制两文件 + git add/commit/push", async () => {
    await syncPush("/watchlist", "/state-repo");
    expect(fsMock.copyFileSync).toHaveBeenCalledWith("/watchlist/holdings.json", "/state-repo/holdings.json");
    expect(fsMock.copyFileSync).toHaveBeenCalledWith("/watchlist/last_rebalance.json", "/state-repo/last_rebalance.json");
    const gitCalls = execMock.mock.calls.map(c => c[0] as string).join(" ");
    expect(gitCalls).toContain("git add");
    expect(gitCalls).toContain("git commit");
    expect(gitCalls).toContain("git push");
  });
});

describe("syncPush — 冲突仲裁", () => {
  it("本地 pending 撞远端 filled → 抛 ConflictAbortedError", async () => {
    // mock fetch 后读远端 last_rebalance.json 为 filled
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      ...pendingLast(),
      execution: { status: "filled", executed_at: "2026-06-23T15:00:00Z", account_total_asset: 100000, fills: [], errors: [] },
    }));
    // mock：远端和本地有分叉
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list") && cmd.includes("count")) return "1";  // 有分叉
      if (cmd.includes("show origin/main:last_rebalance.json")) return fsMock.readFileSync();
      return "";
    });
    await expect(syncPush("/watchlist", "/state-repo")).rejects.toThrow(ConflictAbortedError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/watchlist/execution-bridge.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 实现**

`src/watchlist/execution-bridge.ts`：

```ts
// src/watchlist/execution-bridge.ts
//
// syncPush：开发机跑完 rebalancer 后，把 holdings.json + last_rebalance.json
// 推到 trading-state private repo。
//
// 开发机端 push 语义：永远只推 pending 订单。冲突时只处理一种情况——
// 本地 pending 撞远端非 pending（已执行）。撞了就 abort + 提示 pull，
// 不尝试后写覆盖（开发机不产执行结果，没有"更新"一说）。
// 云服务器的 safe_push 规则 2（都 pending 后写胜出）只对它自己有意义。

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { LastRebalance } from "./rebalance-types";
import { isPending } from "./execution-schema";

/** 本地 pending 撞远端已执行（非 pending）→ 拒绝 push。 */
export class ConflictAbortedError extends Error {
  constructor(remoteOrderId: string, remoteStatus: string) {
    super(`远端订单 ${remoteOrderId} 已执行（status=${remoteStatus}），本地 pending 不能覆盖，请 git pull`);
    this.name = "ConflictAbortedError";
  }
}

function git(repoDir: string, cmd: string): string {
  try {
    return execSync(`git -C ${repoDir} ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(`git 命令失败: git ${cmd} — ${e instanceof Error ? e.message : e}`);
  }
}

/** 检查远端 main 是否和本地有分叉（本地领先 or 远端领先都算）。 */
function remoteHasDiverged(repoDir: string): boolean {
  git(repoDir, "fetch origin main");
  const count = git(repoDir, "rev-list --count main..origin/main");
  return parseInt(count, 10) > 0;
}

/** 读远端 main 的 last_rebalance.json。 */
function readRemoteLastRebalance(repoDir: string): LastRebalance {
  const raw = git(repoDir, "show origin/main:last_rebalance.json");
  return JSON.parse(raw) as LastRebalance;
}

/**
 * 把 watchlist 目录的两文件推到 trading-state repo。
 * @param watchlistDir ~/.openclaw/watchlist 路径
 * @param stateRepoDir trading-state repo 本地路径
 * @throws ConflictAbortedError 本地 pending 撞远端已执行
 */
export async function syncPush(watchlistDir: string, stateRepoDir: string): Promise<void> {
  if (!fs.existsSync(stateRepoDir)) {
    throw new Error(`trading-state repo 不存在: ${stateRepoDir}，请先 clone`);
  }

  // 复制两文件到 repo
  for (const f of ["holdings.json", "last_rebalance.json"]) {
    const src = path.join(watchlistDir, f);
    const dst = path.join(stateRepoDir, f);
    if (!fs.existsSync(src)) {
      throw new Error(`源文件不存在: ${src}`);
    }
    fs.copyFileSync(src, dst);
  }

  // 冲突仲裁：远端有新提交时检查
  if (remoteHasDiverged(stateRepoDir)) {
    const remoteLast = readRemoteLastRebalance(stateRepoDir);
    const localLast = JSON.parse(
      fs.readFileSync(path.join(stateRepoDir, "last_rebalance.json"), "utf-8"),
    ) as LastRebalance;
    // 本地 pending 撞远端非 pending → 拒绝（已执行不可覆盖）
    if (localLast.execution && isPending(localLast.execution.status) &&
        remoteLast.execution && !isPending(remoteLast.execution.status)) {
      throw new ConflictAbortedError(
        remoteLast.order_id ?? "(无)",
        remoteLast.execution.status,
      );
    }
  }

  // push
  git(stateRepoDir, "add holdings.json last_rebalance.json");
  git(stateRepoDir, 'commit -m "chore(state): sync from rebalancer" --allow-empty');
  git(stateRepoDir, "push origin main");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/watchlist/execution-bridge.test.ts`
Expected: PASS。若 mock 的 git 命令断言不匹配，调整测试 mock 返回值以匹配实现的真实 git 调用。

- [ ] **Step 5: typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 无输出（pass）。

- [ ] **Step 6: Commit**

```bash
git add src/watchlist/execution-bridge.ts tests/ts/watchlist/execution-bridge.test.ts
git commit -m "feat(execution-bridge): syncPush 推状态到 trading-state repo

复制 holdings+last_rebalance 到 repo + git push。冲突仲裁：
本地 pending 撞远端已执行 → ConflictAbortedError。开发机端专用。"
```

---

## Task 7: 全量回归 + 更新 AGENTS.md

**Files:**
- Modify: `AGENTS.md`（Key files 表加新文件；Commands 加 sync 说明）

- [ ] **Step 1: 全量测试**

Run: `npm run build && npm test`
Expected: 全部 PASS（含新增 4 个测试文件 + 现有所有测试）。

Run: `npm run lint && npx tsc --noEmit`
Expected: 无 error（no-unused-vars/no-explicit-any 是 warn，不阻塞）。

- [ ] **Step 2: 更新 AGENTS.md Key files 表**

在 `AGENTS.md` 的 `## Key files` 表里，`src/pipeline-health.ts` 行之后，加新文件说明（保持表格风格）：

```markdown
| `src/watchlist/order-id.ts` | `computeOrderId()` 幂等键（date+sha256(actions)），让云服务器识别已执行订单 |
| `src/watchlist/execution-schema.ts` | Execution 状态机：`isTerminal`/`isPending`/`makePendingExecution` |
| `src/watchlist/holdings-merge.ts` | `mergeHoldings()` 持仓字段级合并契约（QMT 市场字段覆盖，本地 sector 保留） |
| `src/watchlist/execution-bridge.ts` | `syncPush()` 推状态到 trading-state repo + 冲突仲裁 |
```

- [ ] **Step 3: 更新 AGENTS.md 数据流说明（可选但推荐）**

在 `## Architecture` 数据流的步骤 5 后，加一条执行桥说明：

```markdown
6. **执行桥（可选）**：rebalancer 产出带 execution 信封的 last_rebalance.json，syncPush 推到 trading-state repo；Win 云服务器的 QMT 执行器消费下单并回写。见 `docs/superpowers/specs/2026-06-25-qmt-execution-bridge-design.md`。
```

- [ ] **Step 4: 提交 dist 产物（按 AGENTS.md 约定 dist 要提交）**

Run: `npm run build`
检查 `git status`——若有 dist/ 变动：

```bash
git add dist/ AGENTS.md
git commit -m "build: 重新编译 dist + 更新 AGENTS.md execution-bridge 文档"
```

- [ ] **Step 5: 最终验收**

确认：
- [ ] `npm run rebalance`（需 API key）跑完后，`last_rebalance.json` 含合法 `order_id` + `execution.status: "pending"` + `execution_sequence`
- [ ] `npm test` 全绿
- [ ] `npx tsc --noEmit` 无输出

---

## Self-Review 自检结果

**Spec 覆盖**：
- §5.1 数据契约（order_id/execution/execution_sequence）→ Task 1(类型) + 2(order-id) + 3(schema) + 5(集成) ✓
- §5.2 holdings 字段所有权合并 → Task 4(mergeHoldings) ✓
- §5.3 ticker 映射 → Python 端范围（本 plan 不含，留待 Plan 2）✓（spec §7.2）
- §7.1 开发机端 4 文件 + 改 cli → Task 1-6 ✓
- §6 冲突仲裁（开发机端规则）→ Task 6 ✓（云服务器 safe_push 规则 2 留待 Plan 2）
- §9 测试策略（TS 部分）→ 各 Task 的测试 ✓

**Placeholder 扫描**：无 TODO/TBD/模糊措辞，所有代码块完整。

**类型一致性**：
- `computeOrderId(date, actions)` 签名 Task 2 定义 → Task 5 调用一致 ✓
- `makePendingExecution()` Task 3 定义 → Task 5 调用一致 ✓
- `Execution`/`Fill`/`ExecStatus` Task 1 定义 → 全局复用 ✓
- `QmtPosition`/`QmtAsset` Task 4 定义 ✓
- `ConflictAbortedError` Task 6 定义 ✓

**范围**：本 plan 聚焦 TS 开发机端，产出可独立验证（json 信封 + 合并契约 + syncPush）。Python 执行器、private repo 初始化是后续 plan。
