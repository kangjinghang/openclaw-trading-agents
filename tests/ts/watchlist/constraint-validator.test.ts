import { describe, it, expect } from "vitest";
import { validateRebalance } from "../../../src/watchlist/constraint-validator";
import type { RebalancePlan, RebalanceConstraints } from "../../../src/watchlist/rebalance-types";

const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10 };

function makeAction(over: Partial<RebalancePlan["actions"][0]> = {}): RebalancePlan["actions"][0] {
  const defaults: any = { action: "HOLD", ticker: "X", name: "x", current_weight: 0.10, target_weight: 0.10, delta: 0, reason: "r", priority: 5 };
  // If action is HOLD and only target_weight is provided, sync current_weight to match
  if (over.action === "HOLD" && over.target_weight !== undefined && over.current_weight === undefined) {
    defaults.current_weight = over.target_weight;
  }
  return { ...defaults, ...over };
}

function makePlan(actions: RebalancePlan["actions"]): RebalancePlan {
  return { evaluations: [], actions, portfolio_after: { positions: [], cash_pct: 0 }, summary: "" };
}

function makeCtx(sectorsRec: Record<string, string>): any {
  return {
    sectors: new Map(Object.entries(sectorsRec)),
    held: new Map(),
    tickersInPool: new Set(Object.keys(sectorsRec)),
  };
}

describe("validateRebalance 规则 1: 权重和=1", () => {
  it("通过：sum(target) + cash = 1.0", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.15, current_weight: 0.10, delta: 0.05, action: "ADD" }),
      makeAction({ ticker: "B", target_weight: 0.15, action: "HOLD" }),
      makeAction({ ticker: "C", target_weight: 0.15, action: "HOLD" }),
      makeAction({ ticker: "D", target_weight: 0.15, action: "HOLD" }),
      makeAction({ ticker: "E", target_weight: 0.15, action: "HOLD" }),
    ]);
    plan.portfolio_after.cash_pct = 0.25;
    const r = validateRebalance(plan, makeCtx({ A: "电子", B: "电子", C: "白酒", D: "白酒", E: "医药" }), C);
    expect(r.passed).toBe(true);
  });

  it("失败：sum=0.60", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.50 })]);
    plan.portfolio_after.cash_pct = 0.10;
    const r = validateRebalance(plan, makeCtx({ A: "电子" }), C);
    expect(r.passed).toBe(false);
    expect(r.violations.some(v => v.rule.includes("权重和"))).toBe(true);
  });
});

describe("validateRebalance 规则 2: 单仓 ≤15%", () => {
  it("通过：max weight=0.15", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.15, current_weight: 0.10, delta: 0.05, action: "ADD" }),
      makeAction({ ticker: "B", target_weight: 0.15, action: "HOLD" }),
    ]);
    plan.portfolio_after.cash_pct = 0.70;
    const r = validateRebalance(plan, makeCtx({ A: "x", B: "y" }), C);
    expect(r.passed).toBe(true);
  });

  it("失败：weight=0.18 超 15%", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.18 })]);
    plan.portfolio_after.cash_pct = 0.82;
    const r = validateRebalance(plan, makeCtx({ A: "x" }), C);
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
    const r = validateRebalance(plan, makeCtx({ A: "PCB", B: "PCB" }), C);
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
    const r = validateRebalance(plan, makeCtx({ A: "x", B: "y" }), C);
    expect(r.violations.some(v => v.rule.includes("日换手") && v.detail.includes("0.35"))).toBe(true);
  });
});

describe("validateRebalance 规则 5: 现金 ≥10%", () => {
  it("失败：cash=0.08", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.92 })]);
    plan.portfolio_after.cash_pct = 0.08;
    const r = validateRebalance(plan, makeCtx({ A: "x" }), C);
    expect(r.violations.some(v => v.rule.includes("现金") && v.detail.includes("0.08"))).toBe(true);
  });
});

describe("validateRebalance 规则 6: anti-churn 卖锁", () => {
  it("失败：locked 持仓被 SELL", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true }]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held, tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 卖锁"))).toBe(true);
  });

  it("通过：locked 持仓被 HOLD", () => {
    const plan = makePlan([makeAction({ ticker: "A", action: "HOLD", current_weight: 0.10, target_weight: 0.10, delta: 0 })]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true }]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held, tickersInPool: new Set(["A"]) }, C);
    expect(r.passed).toBe(true);
  });
});

describe("validateRebalance 规则 7: anti-churn 买锁", () => {
  it("失败：BUY 最近 SELL 过的 ticker", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0, target_weight: 0.10, delta: 0.10, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const recentSold = new Set(["A"]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]), recentSoldTickers: recentSold }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 买锁"))).toBe(true);
  });
});

describe("validateRebalance 规则 8: action 一致性", () => {
  it("失败：action=BUY 但 current>0", () => {
    const plan = makePlan([makeAction({ action: "BUY", current_weight: 0.05, target_weight: 0.10, delta: 0.05, ticker: "A" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("action 一致性") && v.detail.includes("BUY"))).toBe(true);
  });

  it("失败：action=HOLD 但 target≠current", () => {
    const plan = makePlan([makeAction({ action: "HOLD", current_weight: 0.10, target_weight: 0.15, delta: 0.05, ticker: "A" })]);
    plan.portfolio_after.cash_pct = 0.85;
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("action 一致性") && v.detail.includes("HOLD"))).toBe(true);
  });
});

describe("validateRebalance 规则 9: ticker 在候选池", () => {
  it("失败：幻觉 ticker 不在 pool", () => {
    const plan = makePlan([makeAction({ ticker: "FAKE", target_weight: 0.10, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const r = validateRebalance(plan, { sectors: new Map([["FAKE", "x"]]), held: new Map(), tickersInPool: new Set(["REAL"]) }, C);
    expect(r.violations.some(v => v.rule.includes("ticker 在候选池") && v.detail.includes("FAKE"))).toBe(true);
  });
});

describe("validateRebalance 规则 10: sector 非空", () => {
  it("失败：target>0 但 sector 缺失", () => {
    const plan = makePlan([makeAction({ ticker: "A", target_weight: 0.10, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.90;
    const r = validateRebalance(plan, { sectors: new Map(), held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("sector 非空") && v.detail.includes("A"))).toBe(true);
  });
});
