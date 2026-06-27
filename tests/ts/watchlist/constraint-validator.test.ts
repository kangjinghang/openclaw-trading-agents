import { describe, it, expect } from "vitest";
import { validateRebalance, composeReviseFeedback } from "../../../src/watchlist/constraint-validator";
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

  it("止损豁免：locked + stopLossSignal → SELL 放行（趋势策略下行保护）", () => {
    // 生益科技场景：建仓 2 天 locked，但 risk=high（缩量下跌）→ 必须能止损
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 2, locked: true, stopLossSignal: true }]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held, tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 卖锁"))).toBe(false);
  });

  it("止损豁免：locked + stopLossSignal → REDUCE 放行", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0.05, delta: -0.05, action: "REDUCE" }),
    ]);
    plan.portfolio_after.cash_pct = 0.85;
    const held = new Map([["A", { days_held: 1, locked: true, stopLossSignal: true }]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held, tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 卖锁"))).toBe(false);
  });

  it("止损豁免不滥用：locked + stopLossSignal=false → 仍禁止 SELL", () => {
    // 无止损信号时，locked 仍生效（防无谓 churn）
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true, stopLossSignal: false }]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held, tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 卖锁"))).toBe(true);
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

describe("validateRebalance 规则 11: fitness 门槛（趋势模式：<4 禁止 BUY）", () => {
  it("失败：BUY fitness=3 的股（驱动逻辑极弱）", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0, target_weight: 0.024, delta: 0.024, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.976;
    const fitness = new Map([["A", 3]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]), fitnessByTicker: fitness }, C);
    expect(r.violations.some(v => v.rule.includes("fitness 门槛") && v.detail.includes("BUY"))).toBe(true);
  });

  it("失败：ADD fitness=2 的股", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0.02, target_weight: 0.05, delta: 0.03, action: "ADD" })]);
    plan.portfolio_after.cash_pct = 0.93;
    const fitness = new Map([["A", 2]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]), fitnessByTicker: fitness }, C);
    expect(r.violations.some(v => v.rule.includes("fitness 门槛") && v.detail.includes("ADD"))).toBe(true);
  });

  it("通过：BUY fitness=5 的股（趋势模式允许低分小仓）", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0, target_weight: 0.04, delta: 0.04, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.96;
    const fitness = new Map([["A", 5]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]), fitnessByTicker: fitness }, C);
    expect(r.violations.some(v => v.rule.includes("fitness 门槛"))).toBe(false);
  });

  it("通过：SELL/REDUCE 不受 fitness 门槛限制", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" })]);
    plan.portfolio_after.cash_pct = 1.0;
    const fitness = new Map([["A", 3]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]), fitnessByTicker: fitness }, C);
    expect(r.violations.some(v => v.rule.includes("fitness 门槛"))).toBe(false);
  });

  it("通过：无 fitnessByTicker 时跳过检查（向后兼容）", () => {
    const plan = makePlan([makeAction({ ticker: "A", current_weight: 0, target_weight: 0.05, delta: 0.05, action: "BUY" })]);
    plan.portfolio_after.cash_pct = 0.95;
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held: new Map(), tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("fitness 门槛"))).toBe(false);
  });
});

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
