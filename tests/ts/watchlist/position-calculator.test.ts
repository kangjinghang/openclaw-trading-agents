import { describe, it, expect } from "vitest";
import {
  baseWeight,
  volatilityFactor,
  riskFactor,
  computePosition,
  applyPositions,
  buildApplyContext,
} from "../../../src/watchlist/position-calculator";
import type {
  StockReport,
  RebalanceConstraints,
  Action,
  RebalancePlan,
} from "../../../src/watchlist/rebalance-types";

const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10 };

function makeReport(over: Partial<StockReport> = {}): StockReport {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    thesis: "x", fitness_score: 9, key_signals: [], data_gaps: [],
    risk_flags: [], overall_risk: "low", deal_breaker: false,
    is_held: false, current_weight: 0, days_held: 0, locked: false,
    ...over,
  };
}

function makeAction(over: Partial<Action> = {}): Action {
  const action = over.action ?? "BUY";
  const current = over.current_weight ?? 0;
  const target = over.target_weight ?? 0;
  // HOLD 要求 target == current
  const syncedTarget = action === "HOLD" ? current : target;
  return {
    action,
    ticker: "SZ300319", name: "麦捷科技",
    current_weight: current,
    target_weight: syncedTarget,
    delta: syncedTarget - current,
    reason: "x",
    priority: over.priority ?? 3,
    ...over,
  };
}

function makePlan(actions: Action[], cashPct = 0.85): RebalancePlan {
  return {
    evaluations: [],
    actions,
    portfolio_after: {
      positions: actions.filter(a => a.target_weight > 0).map(a => ({ ticker: a.ticker, weight: a.target_weight })),
      cash_pct: cashPct,
    },
    summary: "",
  };
}

// ── 基础仓位查表 ────────────────────────────────────────────────────────────

describe("baseWeight 基础仓位查表（平衡档）", () => {
  it("9分 → 7%", () => expect(baseWeight(9)).toBeCloseTo(0.07, 5));
  it("8分 → 5%", () => expect(baseWeight(8)).toBeCloseTo(0.05, 5));
  it("8.5分 → 6%（线性插值）", () => expect(baseWeight(8.5)).toBeCloseTo(0.06, 5));
  it("7分 → 3%", () => expect(baseWeight(7)).toBeCloseTo(0.03, 5));
  it("6分 → 0%（不买）", () => expect(baseWeight(6)).toBe(0));
  it("≤6 → 0%", () => expect(baseWeight(3)).toBe(0));
});

// ── 波动率折扣 ──────────────────────────────────────────────────────────────

describe("volatilityFactor 波动率折扣", () => {
  it("<2%/日 → ×1.0（大盘股）", () => expect(volatilityFactor(1.5)).toBe(1.0));
  it("2-4% → ×0.8（成长股）", () => expect(volatilityFactor(2.5)).toBe(0.8));
  it(">4% → ×0.6（题材/次新）", () => expect(volatilityFactor(5)).toBe(0.6));
  it("边界 2% → ×0.8", () => expect(volatilityFactor(2)).toBe(0.8));
  it("边界 4% → ×0.6", () => expect(volatilityFactor(4)).toBe(0.6));
  it("0（未知波动率）→ ×0.6（最保守折扣，kline 失败兜底）", () => expect(volatilityFactor(0)).toBe(0.6));
});

// ── 风险因子 ────────────────────────────────────────────────────────────────

describe("riskFactor 风险因子", () => {
  it("low → ×1.0", () => expect(riskFactor("low")).toBe(1.0));
  it("medium → ×0.6", () => expect(riskFactor("medium")).toBe(0.6));
  it("high → ×0.3", () => expect(riskFactor("high")).toBe(0.3));
});

// ── computePosition 单股仓位计算 ────────────────────────────────────────────

describe("computePosition BUY 完整公式", () => {
  it("9分/低波动/低风险 → 7% × 1.0 × 1.0 = 7%", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 9, overall_risk: "low" }),
      currentWeight: 0, volatility: 1.5, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.07, 5);
    expect(r.trace).toContain("7.0%");
  });

  it("9分/中波动/中风险 → 7% × 0.8 × 0.6 = 3.36%", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 9, overall_risk: "medium" }),
      currentWeight: 0, volatility: 2.5, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.07 * 0.8 * 0.6, 5);
  });

  it("8分/高波动/高风险 → 5% × 0.6 × 0.3 = 0.9%（观察仓）", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 8, overall_risk: "high" }),
      currentWeight: 0, volatility: 5, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.05 * 0.6 * 0.3, 5);
  });

  it("fitness≤6 的 BUY → 0（防御性，应为 SKIP）", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 5 }),
      currentWeight: 0, volatility: 1, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
    expect(r.trace).toContain("≤6");
  });

  it("单仓上限钳制：公式值 7% 但上限 5% → 5%", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 9, overall_risk: "low" }),
      currentWeight: 0, volatility: 1, singleNameCap: 0.05,
    });
    expect(r.targetWeight).toBeCloseTo(0.05, 5);
  });
});

describe("computePosition HOLD/SELL/REDUCE/ADD", () => {
  it("HOLD → 保持当前仓位", () => {
    const r = computePosition({
      action: "HOLD", report: makeReport(),
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.10, 5);
  });

  it("SELL → 0", () => {
    const r = computePosition({
      action: "SELL", report: makeReport(),
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
  });

  it("REDUCE → 当前减半（10% → 5%）", () => {
    const r = computePosition({
      action: "REDUCE", report: makeReport(),
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.05, 5);
  });

  it("REDUCE 小仓位 → 直接清仓（3% → 0%，不浪费换手槽位）", () => {
    const r = computePosition({
      action: "REDUCE", report: makeReport(),
      currentWeight: 0.03, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
    expect(r.trace).toContain("≤3%");
  });

  it("ADD：当前 3% < 基础 7%（9分）→ 加到 7%", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ fitness_score: 9 }),
      currentWeight: 0.03, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.07, 5);
  });

  it("ADD：当前 10% > 基础 7% → 不动（保持 10%）", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ fitness_score: 9 }),
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.10, 5);
  });

  it("ADD：fitness≤6 → 维持当前（不加）", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ fitness_score: 5 }),
      currentWeight: 0.08, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.08, 5);
  });
});

describe("computePosition deal_breaker 强制清仓", () => {
  it("deal_breaker + BUY → 强制 SELL（0）", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ deal_breaker: true, fitness_score: 9 }),
      currentWeight: 0, volatility: 1, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
    expect(r.trace).toContain("deal_breaker");
  });

  it("deal_breaker + HOLD → 强制 SELL（0）", () => {
    const r = computePosition({
      action: "HOLD", report: makeReport({ deal_breaker: true }),
      currentWeight: 0.10, volatility: 1, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
  });

  it("deal_breaker + ADD → 强制 SELL（0）", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ deal_breaker: true }),
      currentWeight: 0.05, volatility: 1, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
  });
});

// ── applyPositions 批量改写 ─────────────────────────────────────────────────

describe("applyPositions 批量改写 plan", () => {
  it("改写所有 BUY 的 target_weight + delta", () => {
    const reports = [makeReport({ ticker: "A", fitness_score: 9, overall_risk: "low" })];
    const volMap = new Map([["A", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0, target_weight: 0.99 }), // LLM 乱给 99%
    ]);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.80));
    expect(newPlan.actions[0].target_weight).toBeCloseTo(0.07, 5);
    expect(newPlan.actions[0].delta).toBeCloseTo(0.07, 5);
    expect(traces.get("A")).toContain("7.0%");
  });

  it("重算 portfolio_after：cash_pct = 1 - Σweight", () => {
    const reports = [
      makeReport({ ticker: "A", fitness_score: 9, overall_risk: "low" }),
      makeReport({ ticker: "B", fitness_score: 8, overall_risk: "low" }),
    ];
    const volMap = new Map([["A", 0.015], ["B", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0, target_weight: 0.10 }),
      makeAction({ ticker: "B", action: "BUY", current_weight: 0, target_weight: 0.10 }),
    ]);
    const { plan: newPlan } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.80));
    const totalWeight = newPlan.actions.reduce((s, a) => s + a.target_weight, 0);
    expect(newPlan.portfolio_after.cash_pct).toBeCloseTo(1 - totalWeight, 5);
    expect(totalWeight + newPlan.portfolio_after.cash_pct).toBeCloseTo(1.0, 5);
  });

  it("现金排队：高分的优先买，低分的现金不够降级 HOLD", () => {
    // 初始现金 0.10，下限 0.10 → spendable=0，BUY 全买不起
    const reports = [
      makeReport({ ticker: "A", fitness_score: 9 }),
      makeReport({ ticker: "B", fitness_score: 7 }),
    ];
    const volMap = new Map([["A", 0.015], ["B", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0 }),
      makeAction({ ticker: "B", action: "BUY", current_weight: 0 }),
    ], 0.10);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.10));
    // 现金下限 0.10 = 初始 0.10 → spendable = 0，两个 BUY 都买不起
    expect(newPlan.actions.find(a => a.ticker === "A")!.action).toBe("HOLD");
    expect(newPlan.actions.find(a => a.ticker === "B")!.action).toBe("HOLD");
    expect(traces.get("A")).toContain("现金不足");
  });

  it("现金排队：SELL 释放资金后，高分 BUY 能买", () => {
    // 持仓 C 10%，SELL 释放 10% → 现金池 20% - 下限 10% = spendable 10%
    // 高分 A（9分/低波动/低风险）需要 7% < 10% → 能买
    const reports = [
      makeReport({ ticker: "A", fitness_score: 9, overall_risk: "low" }),
      makeReport({ ticker: "C", fitness_score: 3, overall_risk: "medium" }),
    ];
    const volMap = new Map([["A", 0.015], ["C", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0 }),
      makeAction({ ticker: "C", action: "SELL", current_weight: 0.10, target_weight: 0 }),
    ], 0.10);
    const { plan: newPlan } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.10));
    expect(newPlan.actions.find(a => a.ticker === "A")!.action).toBe("BUY");
    expect(newPlan.actions.find(a => a.ticker === "A")!.target_weight).toBeCloseTo(0.07, 5);
  });

  it("deal_breaker 在批量层面强制改 SELL", () => {
    const reports = [makeReport({ ticker: "X", deal_breaker: true })];
    const volMap = new Map([["X", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "X", action: "HOLD", current_weight: 0.10, target_weight: 0.10 }),
    ]);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.80));
    expect(newPlan.actions[0].target_weight).toBe(0);
    expect(traces.get("X")).toContain("deal_breaker");
  });

  it("不改原 plan（返回新对象）", () => {
    const reports = [makeReport({ ticker: "A", fitness_score: 9 })];
    const volMap = new Map([["A", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0, target_weight: 0.99 }),
    ]);
    const original = JSON.stringify(plan);
    applyPositions(plan, buildApplyContext(reports, volMap, C, 0.80));
    expect(JSON.stringify(plan)).toBe(original);
  });

  it("无 report 的 action：HOLD 保持当前，其他清零（防御性）", () => {
    const volMap = new Map<string, number>();
    const plan = makePlan([
      makeAction({ ticker: "GHOST", action: "BUY", current_weight: 0, target_weight: 0.10 }),
    ]);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext([], volMap, C, 0.80));
    expect(newPlan.actions[0].target_weight).toBe(0);
    expect(traces.get("GHOST")).toContain("防御性");
  });
});
