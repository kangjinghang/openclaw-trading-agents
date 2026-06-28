import { describe, it, expect } from "vitest";
import { validateRebalance, composeReviseFeedback } from "../../../src/watchlist/constraint-validator";
import type { RebalancePlan, RebalanceConstraints } from "../../../src/watchlist/rebalance-types";

const C: RebalanceConstraints = {
  single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10,
  initial_stop_drawdown: 0.07, initial_stop_days: 3, max_positions: 5, take_profit_threshold: 0.15,
};

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

describe("validateRebalance 规则 4: 日换手 ≤30%（单向 max(买,卖)）", () => {
  it("失败：净买入 0.35 超 0.30（买=0.35 卖=0 → max=0.35）", () => {
    const plan = makePlan([
      makeAction({ ticker: "B", current_weight: 0, target_weight: 0.35, delta: 0.35, action: "BUY" }),
    ]);
    plan.portfolio_after.cash_pct = 0.10;
    const r = validateRebalance(plan, makeCtx({ B: "y" }), C);
    expect(r.violations.some(v => v.rule.includes("日换手") && v.detail.includes("0.35"))).toBe(true);
  });

  it("通过：换仓 卖0.20+买0.20 → max=0.20 ≤0.30（单向算法不双向累加，换仓不被卡死）", () => {
    // 这正是修复的核心场景：满仓换仓。双向 sum|delta|=0.40 会超 0.30，单向只算 0.20 通过。
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.20, target_weight: 0, delta: -0.20, action: "SELL" }),
      makeAction({ ticker: "B", current_weight: 0, target_weight: 0.20, delta: 0.20, action: "BUY" }),
    ]);
    plan.portfolio_after.cash_pct = 0.10;
    const r = validateRebalance(plan, makeCtx({ A: "x", B: "y" }), C);
    expect(r.violations.some(v => v.rule.includes("日换手"))).toBe(false);
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

  it("止盈豁免：locked + takeProfitSignal → SELL 放行（落袋为安不是 churn）", () => {
    // 豫光金铅 +7.6% 想止盈被锁挡死的 case：浮盈够多时应允许突破锁卖出
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true, stopLossSignal: false, takeProfitSignal: true }]]);
    const r = validateRebalance(plan, { sectors: new Map([["A", "x"]]), held, tickersInPool: new Set(["A"]) }, C);
    expect(r.violations.some(v => v.rule.includes("anti-churn 卖锁"))).toBe(false);
  });

  it("止盈豁免不滥用：locked + 浮盈不够 → 仍禁止 SELL", () => {
    // 浮盈低于阈值（takeProfitSignal=false）时，locked 仍生效——低于阈值视为"还没到止盈点，可能是 churn"
    const plan = makePlan([
      makeAction({ ticker: "A", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.90;
    const held = new Map([["A", { days_held: 3, locked: true, stopLossSignal: false, takeProfitSignal: false }]]);
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

  it("持仓数超限 → 反馈含可执行指引（砍 fitness 最低的）", () => {
    const violations = [
      { rule: "12. 持仓数上限", detail: "持仓 7 只 超 5 上限（需砍掉 2 只）" },
    ];
    const feedback = composeReviseFeedback(violations);
    expect(feedback).toContain("持仓超限");
    expect(feedback).toContain("SELL");
  });

  it("换手超限 → 反馈含可执行指引（减少同时买卖对数）", () => {
    const violations = [
      { rule: "4. 日换手上限", detail: "max(买0.35, 卖0.20) = 0.35 超 0.30" },
    ];
    const feedback = composeReviseFeedback(violations);
    expect(feedback).toContain("换手超限");
    expect(feedback).toContain("HOLD");
  });

  it("撞卖锁 → 反馈含变通指引（改 HOLD / 卖别的 / 只买不卖）", () => {
    // 06-23 case：豫光金铅 locked，LLM 死磕卖它 revise 3 次都失败——反馈要教会它变通
    const violations = [
      { rule: "6. anti-churn 卖锁", detail: "SZ002635 豫光金铅 持仓 1 天 < anti_churn_days，locked，禁止 SELL" },
    ];
    const feedback = composeReviseFeedback(violations);
    expect(feedback).toContain("撞卖锁");
    expect(feedback).toContain("HOLD");        // 变通方式 ①：改 HOLD 等解锁
    expect(feedback).toContain("只做买入");     // 变通方式 ③：只买不卖
  });
});

describe("validateRebalance 规则 12: 持仓数 ≤ max_positions", () => {
  it("失败：6 只持仓超 5 上限", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.10 }),
      makeAction({ ticker: "B", target_weight: 0.10 }),
      makeAction({ ticker: "C", target_weight: 0.10 }),
      makeAction({ ticker: "D", target_weight: 0.10 }),
      makeAction({ ticker: "E", target_weight: 0.10 }),
      makeAction({ ticker: "F", target_weight: 0.10 }),
    ]);
    plan.portfolio_after.cash_pct = 0.40;
    const r = validateRebalance(plan, makeCtx({ A: "x", B: "x", C: "x", D: "x", E: "x", F: "x" }), C);
    expect(r.violations.some(v => v.rule.includes("持仓数上限") && v.detail.includes("6 只"))).toBe(true);
  });

  it("通过：5 只持仓正好达上限不违规", () => {
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.10 }),
      makeAction({ ticker: "B", target_weight: 0.10 }),
      makeAction({ ticker: "C", target_weight: 0.10 }),
      makeAction({ ticker: "D", target_weight: 0.10 }),
      makeAction({ ticker: "E", target_weight: 0.10 }),
    ]);
    plan.portfolio_after.cash_pct = 0.50;
    const r = validateRebalance(plan, makeCtx({ A: "x", B: "x", C: "x", D: "x", E: "x" }), C);
    expect(r.violations.some(v => v.rule.includes("持仓数上限"))).toBe(false);
  });

  it("target_weight=0 的 SELL 不计入持仓数", () => {
    // 5 只持仓 + 1 只清仓（target=0）= 5 只，不超限
    const plan = makePlan([
      makeAction({ ticker: "A", target_weight: 0.10 }),
      makeAction({ ticker: "B", target_weight: 0.10 }),
      makeAction({ ticker: "C", target_weight: 0.10 }),
      makeAction({ ticker: "D", target_weight: 0.10 }),
      makeAction({ ticker: "E", target_weight: 0.10 }),
      makeAction({ ticker: "F", current_weight: 0.10, target_weight: 0, delta: -0.10, action: "SELL" }),
    ]);
    plan.portfolio_after.cash_pct = 0.50;
    const r = validateRebalance(plan, makeCtx({ A: "x", B: "x", C: "x", D: "x", E: "x", F: "x" }), C);
    expect(r.violations.some(v => v.rule.includes("持仓数上限"))).toBe(false);
  });
});
