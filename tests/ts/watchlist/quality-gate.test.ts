import { describe, it, expect } from "vitest";
import { applyQualityGate } from "../../../src/watchlist/quality-gate";
import type { AnalystReport, RiskReport } from "../../../src/watchlist/rebalance-types";
import type { StockData } from "../../../src/watchlist/shallow-analyzer";

// ── 测试夹具 ──────────────────────────────────────────────
function makeStockData(overrides: { fund?: Partial<StockData["fundamentals"]>; lockup?: StockData["lockup"] } = {}): StockData {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
    news: [],
    hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
    fundamentals: { pe: 30, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子", ...(overrides.fund ?? {}) },
    lockup: overrides.lockup,
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
  it("数据完备 + 无解禁 + 正常 risk → 不触发", () => {
    const result = applyQualityGate(makeAnalyst(), makeRisk(), makeStockData());
    expect(result.issues).toEqual([]);
    expect(result.analyst.fitness_score).toBe(8);
    expect(result.risk.overall_risk).toBe("medium");
  });

  it("不改入参对象（返回副本）", () => {
    const analyst = makeAnalyst({ fitness_score: 12 });
    const snap = { ...analyst };
    applyQualityGate(analyst, makeRisk(), makeStockData());
    expect(analyst).toEqual(snap);
  });
});

// ── 规则 1：数据缺失（趋势模式已移除钳制）──────────────────
describe("规则 1：数据缺失（趋势模式不钳制）", () => {
  it("PE=0 + fitness=8 → 不再 clamp（趋势模式允许数据缺失的股）", () => {
    const r = applyQualityGate(makeAnalyst({ fitness_score: 8 }), makeRisk(), makeStockData({ fund: { pe: 0 } }));
    expect(r.analyst.fitness_score).toBe(8);  // 趋势模式：不因数据缺失否决
  });
});

// ── 规则 2：传闻词（趋势模式：标注不钳制）──────────────────
describe("规则 2：传闻/未证实词（趋势模式标注不钳制）", () => {
  it("thesis 含「传闻」+ fitness=9 → 标注但不 clamp", () => {
    const r = applyQualityGate(
      makeAnalyst({ thesis: "英伟达 PTFE 供货为市场传闻，尚未官宣", fitness_score: 9 }),
      makeRisk(), makeStockData());
    expect(r.analyst.fitness_score).toBe(9);  // 趋势模式：传闻可驱动动量，不否决
    expect(r.issues.some(i => i.includes("传闻"))).toBe(true);  // 但标注不确定性
  });

  it("正常前瞻表述（预计订单交付）→ 不标注", () => {
    const r = applyQualityGate(
      makeAnalyst({ thesis: "预计 Q3 订单开始批量交付，新增产能已就绪投产", fitness_score: 8 }),
      makeRisk(), makeStockData());
    expect(r.analyst.fitness_score).toBe(8);
    expect(r.issues.some(i => i.includes("传闻"))).toBe(false);
  });
});

// ── 规则 3：deal_breaker 一致性 ───────────────────────────
describe("规则 3：deal_breaker 一致性", () => {
  it("deal_breaker=true + risk=medium → 改 high", () => {
    const r = applyQualityGate(makeAnalyst(), makeRisk({ deal_breaker: true, overall_risk: "medium" }), makeStockData());
    expect(r.risk.overall_risk).toBe("high");
  });
});

// ── 规则 4：fitness 越界 ──────────────────────────────────
describe("规则 4：fitness 越界", () => {
  it("fitness=12 → clamp 10", () => {
    const r = applyQualityGate(makeAnalyst({ fitness_score: 12 }), makeRisk(), makeStockData());
    expect(r.analyst.fitness_score).toBe(10);
  });
});

// ── 规则 5/6：标注型 ──────────────────────────────────────
describe("规则 5/6：标注型", () => {
  it("overall_risk=high + 无 flags → 记 issue", () => {
    const r = applyQualityGate(makeAnalyst(), makeRisk({ overall_risk: "high", risk_flags: [] }), makeStockData());
    expect(r.issues.some(i => i.includes("缺支撑"))).toBe(true);
  });

  it("thesis 过短 → 记 issue", () => {
    const r = applyQualityGate(makeAnalyst({ thesis: "还不错" }), makeRisk(), makeStockData());
    expect(r.issues.some(i => i.includes("过短"))).toBe(true);
  });
});

// ── 规则 7：重大解禁兜底（核心新增）──────────────────────
describe("规则 7：重大解禁兜底", () => {
  it("pressure_rating=重大压力 + risk=medium → 强制 high", () => {
    const r = applyQualityGate(
      makeAnalyst(),
      makeRisk({ overall_risk: "medium" }),
      makeStockData({ lockup: { pressure_rating: "重大压力", upcoming: [{ date: "2026-08-15", ratio: "0.4%" }], reduce_holdings: [] } }),
    );
    expect(r.risk.overall_risk).toBe("high");
    expect(r.issues.some(i => i.includes("重大压力"))).toBe(true);
  });

  it("upcoming 单笔 ratio=8% → 强制 high（即使 pressure 非重大）", () => {
    const r = applyQualityGate(
      makeAnalyst(),
      makeRisk({ overall_risk: "low" }),
      makeStockData({ lockup: { pressure_rating: "中等压力", upcoming: [{ date: "2026-08-15", ratio: "8%" }], reduce_holdings: [] } }),
    );
    expect(r.risk.overall_risk).toBe("high");
    expect(r.issues.some(i => i.includes("≥5%"))).toBe(true);
  });

  it("upcoming ratio=3%（低于阈值）+ 中等压力 → 不强制 high", () => {
    const r = applyQualityGate(
      makeAnalyst(),
      makeRisk({ overall_risk: "medium" }),
      makeStockData({ lockup: { pressure_rating: "中等压力", upcoming: [{ date: "2026-08-15", ratio: "3%" }], reduce_holdings: [] } }),
    );
    expect(r.risk.overall_risk).toBe("medium");  // 不动
    expect(r.issues.some(i => i.includes("解禁"))).toBe(false);
  });

  it("无解禁数据（lockup undefined）→ 不臆测，不触发", () => {
    const r = applyQualityGate(makeAnalyst(), makeRisk({ overall_risk: "medium" }), makeStockData({ lockup: undefined }));
    expect(r.risk.overall_risk).toBe("medium");
    expect(r.issues.some(i => i.includes("解禁"))).toBe(false);
  });

  it("已是 high → 不重复记 issue（幂等）", () => {
    const r = applyQualityGate(
      makeAnalyst(),
      makeRisk({ overall_risk: "high" }),
      makeStockData({ lockup: { pressure_rating: "重大压力", upcoming: [], reduce_holdings: [] } }),
    );
    expect(r.risk.overall_risk).toBe("high");
    expect(r.issues.some(i => i.includes("解禁"))).toBe(false);  // 已 high，不重复记
  });
});
