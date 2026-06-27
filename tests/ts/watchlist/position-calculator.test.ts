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

// 趋势模式约束：单仓 10%，行业 25%，换手 40%，现金下限 5%
const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.25, daily_turnover: 0.40, cash_reserve: 0.05 };

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

// ── 基础仓位查表（趋势模式线性映射） ────────────────────────────────────────

describe("baseWeight 基础仓位（趋势模式线性映射）", () => {
  // 趋势模式：fitness × 0.015（20万小账户适度集中定位），全程有仓位，无"≤6 不买"断崖
  it("10分 → 15%（顶到 single_name 上限）", () => expect(baseWeight(10)).toBeCloseTo(0.15, 5));
  it("9分 → 13.5%", () => expect(baseWeight(9)).toBeCloseTo(0.135, 5));
  it("7分 → 10.5%", () => expect(baseWeight(7)).toBeCloseTo(0.105, 5));
  it("5分 → 7.5%（中分给中仓）", () => expect(baseWeight(5)).toBeCloseTo(0.075, 5));
  it("3分 → 4.5%（低分给小仓，不否决）", () => expect(baseWeight(3)).toBeCloseTo(0.045, 5));
  it("0分 → 0%（fitness=0 不买）", () => expect(baseWeight(0)).toBe(0));
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

// ── 风险因子（趋势模式：固定 1.0，不打折仓位） ──────────────────────────────

describe("riskFactor 风险因子（趋势模式固定 1.0）", () => {
  it("low → ×1.0", () => expect(riskFactor("low")).toBe(1.0));
  it("medium → ×1.0（趋势模式不打折）", () => expect(riskFactor("medium")).toBe(1.0));
  it("high → ×1.0（靠止损退出，不靠仓位压缩）", () => expect(riskFactor("high")).toBe(1.0));
});

// ── computePosition 单股仓位计算 ────────────────────────────────────────────

describe("computePosition BUY 完整公式（趋势模式：base × vol，无 risk 打折）", () => {
  it("9分/低波动 → 13.5% × 1.0 = 13.5%", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 9, overall_risk: "low" }),
      currentWeight: 0, volatility: 1.5, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.135, 5);
    expect(r.trace).toContain("13.5%");
  });

  it("9分/中波动 → 13.5% × 0.8 = 10.8%", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 9, overall_risk: "medium" }),
      currentWeight: 0, volatility: 2.5, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.135 * 0.8, 5);
  });

  it("5分/高波动 → 7.5% × 0.6 = 4.5%（低分小仓，不否决）", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 5, overall_risk: "high" }),
      currentWeight: 0, volatility: 5, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.075 * 0.6, 5);
  });

  it("fitness=0 的 BUY → 0（防御性）", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ fitness_score: 0 }),
      currentWeight: 0, volatility: 1, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBe(0);
  });

  it("单仓上限钳制：公式值 13.5% 但上限 5% → 5%", () => {
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
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.10,
    });
    expect(r.targetWeight).toBeCloseTo(0.10, 5);
  });

  it("SELL → 0", () => {
    const r = computePosition({
      action: "SELL", report: makeReport(),
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.10,
    });
    expect(r.targetWeight).toBe(0);
  });

  it("REDUCE → 当前减半（10% → 5%）", () => {
    const r = computePosition({
      action: "REDUCE", report: makeReport(),
      currentWeight: 0.10, volatility: 2, singleNameCap: 0.10,
    });
    expect(r.targetWeight).toBeCloseTo(0.05, 5);
  });

  it("REDUCE 小仓位 → 直接清仓（3% → 0%，不浪费换手槽位）", () => {
    const r = computePosition({
      action: "REDUCE", report: makeReport(),
      currentWeight: 0.03, volatility: 2, singleNameCap: 0.10,
    });
    expect(r.targetWeight).toBe(0);
    expect(r.trace).toContain("≤3%");
  });

  it("ADD：当前 3% < 基础 13.5%（9分）→ 加到 13.5%", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ fitness_score: 9 }),
      currentWeight: 0.03, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.135, 5);
  });

  it("ADD：当前 14% > 基础 13.5% → 不动（保持 14%）", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ fitness_score: 9 }),
      currentWeight: 0.14, volatility: 2, singleNameCap: 0.15,
    });
    expect(r.targetWeight).toBeCloseTo(0.14, 5);
  });

  it("ADD：fitness=0 → 维持当前（不加）", () => {
    const r = computePosition({
      action: "ADD", report: makeReport({ fitness_score: 0 }),
      currentWeight: 0.08, volatility: 2, singleNameCap: 0.10,
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

// ── 建仓回撤止损（initial stop）─────────────────────────────────────────────

describe("computePosition 建仓回撤止损", () => {
  // 国瓷场景：entry=100，建仓 1 天后跌到 92（-8%）→ 触发止损（阈值 7%）
  const heldReport = (over: Partial<StockReport> = {}) => makeReport({
    ticker: "SZ300285", name: "国瓷材料", is_held: true, current_weight: 0.15,
    fitness_score: 5, overall_risk: "medium", deal_breaker: false, ...over,
  });

  it("建仓 1 天回撤 -8%（超 7% 阈值）→ 强制清仓", () => {
    const r = computePosition({
      action: "HOLD", report: heldReport(),
      currentWeight: 0.15, volatility: 1, singleNameCap: 0.15,
      entryPrice: 100, currentPrice: 92, daysHeld: 1,
      initialStopDrawdown: 0.07, initialStopDays: 3,
    });
    expect(r.targetWeight).toBe(0);
    expect(r.trace).toContain("建仓");
    expect(r.trace).toContain("止损");
  });

  it("建仓 2 天回撤 -7.5%（超 7%）→ 强制清仓", () => {
    const r = computePosition({
      action: "HOLD", report: heldReport(),
      currentWeight: 0.15, volatility: 1, singleNameCap: 0.15,
      entryPrice: 100, currentPrice: 92.5, daysHeld: 2,
      initialStopDrawdown: 0.07, initialStopDays: 3,
    });
    expect(r.targetWeight).toBe(0);
  });

  it("建仓 2 天回撤 -5%（未达 7% 阈值）→ 保持持仓", () => {
    const r = computePosition({
      action: "HOLD", report: heldReport(),
      currentWeight: 0.15, volatility: 1, singleNameCap: 0.15,
      entryPrice: 100, currentPrice: 95, daysHeld: 2,
      initialStopDrawdown: 0.07, initialStopDays: 3,
    });
    expect(r.targetWeight).toBeCloseTo(0.15, 5);  // 保持当前仓位
  });

  it("建仓 5 天回撤 -10%（超窗口 3 天）→ 不触发，靠技术信号", () => {
    // 超过 initial_stop_days 窗口，建仓回撤止损不生效，回到正常 HOLD 逻辑
    const r = computePosition({
      action: "HOLD", report: heldReport(),
      currentWeight: 0.15, volatility: 1, singleNameCap: 0.15,
      entryPrice: 100, currentPrice: 90, daysHeld: 5,
      initialStopDrawdown: 0.07, initialStopDays: 3,
    });
    expect(r.targetWeight).toBeCloseTo(0.15, 5);  // 窗口外不触发
  });

  it("建仓回撤但 currentPrice 缺失 → 不触发（防御性）", () => {
    const r = computePosition({
      action: "HOLD", report: heldReport(),
      currentWeight: 0.15, volatility: 1, singleNameCap: 0.15,
      entryPrice: 100, currentPrice: 0, daysHeld: 1,  // currentPrice=0（kline 失败）
      initialStopDrawdown: 0.07, initialStopDays: 3,
    });
    expect(r.targetWeight).toBeCloseTo(0.15, 5);  // 数据缺失不误判
  });

  it("候选股（非持仓）不触发建仓回撤止损", () => {
    const r = computePosition({
      action: "BUY", report: makeReport({ is_held: false }),
      currentWeight: 0, volatility: 1, singleNameCap: 0.15,
      entryPrice: 100, currentPrice: 92, daysHeld: 1,
      initialStopDrawdown: 0.07, initialStopDays: 3,
    });
    // 候选股 is_held=false，建仓回撤不生效，走正常 BUY 逻辑
    expect(r.targetWeight).toBeGreaterThan(0);
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
    // 趋势模式：9分 × 0.015 = 13.5% × vol 1.0 = 13.5%
    expect(newPlan.actions[0].target_weight).toBeCloseTo(0.135, 5);
    expect(newPlan.actions[0].delta).toBeCloseTo(0.135, 5);
    expect(traces.get("A")).toContain("13.5%");
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
    // 初始现金 0.05，下限 0.05 → spendable=0，BUY 全买不起
    const reports = [
      makeReport({ ticker: "A", fitness_score: 9 }),
      makeReport({ ticker: "B", fitness_score: 7 }),
    ];
    const volMap = new Map([["A", 0.015], ["B", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0 }),
      makeAction({ ticker: "B", action: "BUY", current_weight: 0 }),
    ], 0.05);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.05));
    // 现金下限 0.05 = 初始 0.05 → spendable = 0，两个 BUY 都买不起
    expect(newPlan.actions.find(a => a.ticker === "A")!.action).toBe("HOLD");
    expect(newPlan.actions.find(a => a.ticker === "B")!.action).toBe("HOLD");
    expect(traces.get("A")).toContain("现金不足");
  });

  it("现金排队：SELL 释放资金后，高分 BUY 能买", () => {
    // 持仓 C 15%，SELL 释放 15% → 现金池 25% - 下限 5% = spendable 20%
    // 高分 A（9分/低波动）需要 13.5% < 20% → 能买
    const reports = [
      makeReport({ ticker: "A", fitness_score: 9, overall_risk: "low" }),
      makeReport({ ticker: "C", fitness_score: 3, overall_risk: "medium" }),
    ];
    const volMap = new Map([["A", 0.015], ["C", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "A", action: "BUY", current_weight: 0 }),
      makeAction({ ticker: "C", action: "SELL", current_weight: 0.15, target_weight: 0 }),
    ], 0.10);
    const { plan: newPlan } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.10));
    expect(newPlan.actions.find(a => a.ticker === "A")!.action).toBe("BUY");
    expect(newPlan.actions.find(a => a.ticker === "A")!.target_weight).toBeCloseTo(0.135, 5);
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

  it("REDUCE 小仓位清仓（≤3%）→ action 升级为 SELL（一致性：target=0 即退出）", () => {
    // 持仓 X 仅 2%（≤3%），REDUCE → target=0（清仓）→ action 应升级为 SELL
    // 否则 rebalance-cli 的 recent_sells 追踪（只看 action==="SELL"）会漏记，
    // anti-churn 买锁失效；execution-planner 也按 SELL 优先级=1 先释放资金
    const reports = [makeReport({ ticker: "X", fitness_score: 8, overall_risk: "low" })];
    const volMap = new Map([["X", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "X", action: "REDUCE", current_weight: 0.02, target_weight: 0.99 }),
    ]);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.80));
    expect(newPlan.actions[0].target_weight).toBe(0);
    expect(newPlan.actions[0].action).toBe("SELL");
    expect(newPlan.actions[0].priority).toBe(1);  // SELL 优先级=1
    expect(traces.get("X")).toContain("≤3%");
  });

  it("REDUCE 正常减仓（>3%）→ action 保持 REDUCE（不误升级）", () => {
    // 持仓 X 10%（>3%），REDUCE 减半 → target=5%，action 保持 REDUCE
    const reports = [makeReport({ ticker: "X", fitness_score: 8, overall_risk: "low" })];
    const volMap = new Map([["X", 0.015]]);
    const plan = makePlan([
      makeAction({ ticker: "X", action: "REDUCE", current_weight: 0.10, target_weight: 0.99 }),
    ]);
    const { plan: newPlan, traces } = applyPositions(plan, buildApplyContext(reports, volMap, C, 0.80));
    expect(newPlan.actions[0].target_weight).toBeCloseTo(0.05, 5);
    expect(newPlan.actions[0].action).toBe("REDUCE");  // 非 0 不升级
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
