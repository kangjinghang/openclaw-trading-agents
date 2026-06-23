import { describe, it, expect } from "vitest";
import { applyQualityGate } from "../../../src/watchlist/quality-gate";
import type { AnalystReport, RiskReport } from "../../../src/watchlist/rebalance-types";
import type { StockData } from "../../../src/watchlist/shallow-analyzer";

// ── 测试夹具 ──────────────────────────────────────────────
// 数据完备的基准 StockData（PE/净利 非零，无传闻词）→ gate 不应触发任何钳制。
function makeStockData(overrides: Partial<StockData["fundamentals"]> = {}): StockData {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
    news: [],
    hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
    fundamentals: { pe: 30, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子", ...overrides },
  };
}

function makeAnalyst(overrides: Partial<AnalystReport> = {}): AnalystReport {
  return {
    thesis: "TLVR 电感已批量供货英伟达，订单排至 2027 年",
    fitness_score: 8,
    data_freshness: "2026-06-21",
    key_signals: ["订单放量"],
    data_gaps: [],
    ...overrides,
  };
}

function makeRisk(overrides: Partial<RiskReport> = {}): RiskReport {
  return {
    risk_flags: [{ flag: "估值偏高", severity: "中", detail: "PE 50x" }],
    overall_risk: "medium",
    deal_breaker: false,
    ...overrides,
  };
}

describe("applyQualityGate — 基准（不误伤）", () => {
  it("数据完备 + 正常 thesis + 正常 risk → 不触发任何规则", () => {
    const result = applyQualityGate(makeAnalyst(), makeRisk(), makeStockData());
    expect(result.issues).toEqual([]);
    expect(result.analyst.fitness_score).toBe(8);
    expect(result.risk.overall_risk).toBe("medium");
  });

  it("不改入参对象（返回副本，避免污染 LLM 原始输出审计）", () => {
    const analyst = makeAnalyst({ fitness_score: 12 });
    const analystSnapshot = { ...analyst };
    applyQualityGate(analyst, makeRisk(), makeStockData());
    expect(analyst).toEqual(analystSnapshot);  // 入参未被修改
  });
});

// ── 规则 1：数据缺失封顶（核心断点）──────────────────────
describe("规则 1：数据缺失封顶（PE=0 或 净利=0 且 fitness>6）", () => {
  it("PE=0 + LLM 给 fitness=8 → clamp 到 6 + 记 issue", () => {
    const data = makeStockData({ pe: 0, np_q1: 1e8 });
    const result = applyQualityGate(makeAnalyst({ fitness_score: 8 }), makeRisk(), data);
    expect(result.analyst.fitness_score).toBe(6);  // 幻觉链断点
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("PE");
    expect(result.issues[0]).toContain("数据缺失");
    expect(result.issues[0]).toContain("8→6");
  });

  it("净利=0 + fitness=7 → clamp 到 6", () => {
    const data = makeStockData({ pe: 30, np_q1: 0 });
    const result = applyQualityGate(makeAnalyst({ fitness_score: 7 }), makeRisk(), data);
    expect(result.analyst.fitness_score).toBe(6);
    expect(result.issues[0]).toContain("净利");
  });

  it("数据缺失但 fitness≤6 → 不触发（已在封顶线内）", () => {
    const data = makeStockData({ pe: 0, np_q1: 0 });
    const result = applyQualityGate(makeAnalyst({ fitness_score: 5 }), makeRisk(), data);
    expect(result.analyst.fitness_score).toBe(5);  // 不动
    expect(result.issues).toEqual([]);
  });

  it("数据完备 + fitness=9 → 不触发（不奖励，不压低正常高分）", () => {
    const data = makeStockData({ pe: 30, np_q1: 1e8 });
    const result = applyQualityGate(makeAnalyst({ fitness_score: 9 }), makeRisk(), data);
    expect(result.analyst.fitness_score).toBe(9);
    expect(result.issues).toEqual([]);
  });
});

// ── 规则 2：传闻词封顶 ──────────────────────────────────
describe("规则 2：传闻/未证实词封顶", () => {
  it("thesis 含「传闻」+ fitness=7 → clamp 6", () => {
    const result = applyQualityGate(
      makeAnalyst({ thesis: "英伟达 PTFE 供货为市场传闻，尚未官宣", fitness_score: 7 }),
      makeRisk(),
      makeStockData(),
    );
    expect(result.analyst.fitness_score).toBe(6);
    expect(result.issues[0]).toContain("传闻");
  });

  it("thesis 含「尚未证实」+ fitness=9 → clamp 6", () => {
    const result = applyQualityGate(
      makeAnalyst({ thesis: "光刻胶突破，但订单尚未证实", fitness_score: 9 }),
      makeRisk(),
      makeStockData(),
    );
    expect(result.analyst.fitness_score).toBe(6);
  });

  it("正常前瞻表述（预计订单交付）→ 不误伤", () => {
    const result = applyQualityGate(
      // 「预计」单独不触发传闻规则；thesis ≥20 字避开规则 6
      makeAnalyst({ thesis: "预计 Q3 订单开始批量交付，新增产能已就绪投产", fitness_score: 8 }),
      makeRisk(),
      makeStockData(),
    );
    expect(result.analyst.fitness_score).toBe(8);
    expect(result.issues).toEqual([]);
  });
});

// ── 规则 3：deal_breaker 一致性 ─────────────────────────
describe("规则 3：deal_breaker 一致性", () => {
  it("deal_breaker=true 但 overall_risk=medium → 改 high", () => {
    const result = applyQualityGate(
      makeAnalyst(),
      makeRisk({ deal_breaker: true, overall_risk: "medium" }),
      makeStockData(),
    );
    expect(result.risk.overall_risk).toBe("high");
    expect(result.risk.deal_breaker).toBe(true);
    expect(result.issues.some(i => i.includes("deal_breaker"))).toBe(true);
  });

  it("deal_breaker=true 且已是 high → 不重复记 issue", () => {
    const result = applyQualityGate(
      makeAnalyst(),
      makeRisk({ deal_breaker: true, overall_risk: "high" }),
      makeStockData(),
    );
    expect(result.risk.overall_risk).toBe("high");
    expect(result.issues.some(i => i.includes("deal_breaker"))).toBe(false);
  });
});

// ── 规则 4：fitness 越界 clamp ──────────────────────────
describe("规则 4：fitness 越界", () => {
  it("fitness=12 → clamp 10", () => {
    const result = applyQualityGate(makeAnalyst({ fitness_score: 12 }), makeRisk(), makeStockData());
    expect(result.analyst.fitness_score).toBe(10);
    expect(result.issues.some(i => i.includes("越界"))).toBe(true);
  });

  it("fitness=-2 → clamp 0", () => {
    const result = applyQualityGate(makeAnalyst({ fitness_score: -2 }), makeRisk(), makeStockData());
    expect(result.analyst.fitness_score).toBe(0);
  });
});

// ── 规则 5：高风险无依据（标注型）────────────────────────
describe("规则 5：高风险无依据（只标注，不改值）", () => {
  it("overall_risk=high 且 risk_flags 为空 → 记 issue", () => {
    const result = applyQualityGate(
      makeAnalyst(),
      makeRisk({ overall_risk: "high", risk_flags: [] }),
      makeStockData(),
    );
    expect(result.issues.some(i => i.includes("缺支撑"))).toBe(true);
    expect(result.risk.overall_risk).toBe("high");  // 不改值
  });

  it("overall_risk=high 且有 risk_flags → 不触发", () => {
    const result = applyQualityGate(
      makeAnalyst(),
      makeRisk({ overall_risk: "high", risk_flags: [{ flag: "财务造假", severity: "高", detail: "x" }] }),
      makeStockData(),
    );
    expect(result.issues.some(i => i.includes("缺支撑"))).toBe(false);
  });
});

// ── 规则 6：thesis 过短（标注型）────────────────────────
describe("规则 6：thesis 过短（只标注）", () => {
  it("thesis 只 5 字 → 记 issue", () => {
    const result = applyQualityGate(makeAnalyst({ thesis: "还不错" }), makeRisk(), makeStockData());
    expect(result.issues.some(i => i.includes("过短"))).toBe(true);
  });

  it("thesis 恰好 20 字 → 不触发（边界）", () => {
    const thesis = "订单交付在即产能就绪估值合理看好";  // 18 字... 调整
    // 20 个汉字字符
    const t20 = "订单交付在即产能就绪估值合理看好后势继续向上";
    expect(t20.trim().length).toBeGreaterThanOrEqual(20);
    const result = applyQualityGate(makeAnalyst({ thesis: t20 }), makeRisk(), makeStockData());
    expect(result.issues.some(i => i.includes("过短"))).toBe(false);
  });
});

// ── 多规则同时触发 ──────────────────────────────────────
describe("多规则同时触发", () => {
  it("PE=0 + 传闻词 + deal_breaker + high无flags → 各维度独立钳制，issue 累积", () => {
    const result = applyQualityGate(
      makeAnalyst({ thesis: "传闻订单突破，业绩大增", fitness_score: 9 }),
      makeRisk({ deal_breaker: true, overall_risk: "medium", risk_flags: [] }),
      makeStockData({ pe: 0, np_q1: 0 }),
    );
    // fitness 被 clamp：9→6（规则 1 数据缺失先命中，把 fitness 压到 6；
    // 规则 2 传闻此时 fitness=6 不再 >6，不再重复 clamp —— fitness 单值取最严不叠加）
    expect(result.analyst.fitness_score).toBe(6);
    // risk 被 clamp：medium→high（规则 3 deal_breaker 一致性）
    expect(result.risk.overall_risk).toBe("high");
    // issue 累积：规则 1（数据缺失 clamp）+ 规则 3（deal_breaker 改 high）+ 规则 5（high 无 flags）
    expect(result.issues.some(i => i.includes("数据缺失"))).toBe(true);
    expect(result.issues.some(i => i.includes("deal_breaker"))).toBe(true);
    expect(result.issues.some(i => i.includes("缺支撑"))).toBe(true);
  });
});
