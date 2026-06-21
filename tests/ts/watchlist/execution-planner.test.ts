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
    const ep = buildExecutionPlan(p, 0.15);
    expect(ep.execution_sequence[0]).toMatchObject({ ticker: "S", weight_delta: -0.10, est_cash_after: 0.25 });
    expect(ep.execution_sequence[1]).toMatchObject({ ticker: "B", weight_delta: 0.05, est_cash_after: 0.20 });
  });

  it("BUY cash 不足 → 标 warning，仍保留步骤", () => {
    const p = plan([
      a({ action: "BUY", ticker: "B", priority: 3, delta: 0.20 }),
    ], 0.05);
    const ep = buildExecutionPlan(p, 0.05);
    expect(ep.warnings.length).toBeGreaterThan(0);
    expect(ep.warnings[0]).toMatch(/cash.*不足/);
  });
});
