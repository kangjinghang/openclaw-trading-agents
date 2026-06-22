import { describe, it, expect } from "vitest";
import { formatAnalystPrompt, parseAnalystReport, formatRiskPrompt, parseRiskReport, buildStockReport, analyzeAll, type ShallowLlmCaller } from "../../../src/watchlist/shallow-analyzer";
import type { AnalystReport } from "../../../src/watchlist/rebalance-types";
import type { CandidateMeta } from "../../../src/watchlist/candidate-selector";
import type { StockData } from "../../../src/watchlist/shallow-analyzer";

describe("formatAnalystPrompt", () => {
  it("渲染包含 ticker/sector + 数据摘要", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319",
      name: "麦捷科技",
      sector: "电子",
      kline: { pct_5d: 12.3, pct_20d: 45.6, support: 25.0, resistance: 30.0, volatility_20d: 0.02 },
      news: ["新闻 1", "新闻 2"],
      hot_money: { net_5d: 1.2e8 },
      fundamentals: { pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子" },
      ranker_thesis: "TLVR 电感获英伟达认证",
    });
    expect(prompt).toContain("SZ300319 麦捷科技");
    expect(prompt).toContain("电子");
    expect(prompt).toContain("12.3");
    expect(prompt).toContain("新闻 1");
    expect(prompt).toContain("120000000");
    expect(prompt).toContain("英伟达认证");
  });

  it("包含评分锚点（5 档标准，对齐下游阈值）", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0 },
      news: [], hot_money: { net_5d: 0 },
      fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" },
    });
    // 锚点关键词（对齐下游 ≥8 BUY / ≤5 减仓 / ≤6 不买 阈值）
    expect(prompt).toContain("业绩已兑现");
    expect(prompt).toContain("传闻未证实");
    expect(prompt).toContain("零营收");
    expect(prompt).toContain("严格对齐");
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
    expect(r!.overall_risk).toBe("low");
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

  it("单股 LLM 失败 → 该股跳过", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "OK", name: "ok", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 8.0 },
      { ticker: "FAIL", name: "fail", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 7.0 },
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
    expect(reports.map(r => r.ticker)).toEqual(["OK"]);
  });

  it("dataByTicker 里缺该股 → 跳过", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "NODATA", name: "nodata", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 6.0 },
    ];
    const dataByTicker = new Map<string, StockData>();  // 空
    const mockCaller: ShallowLlmCaller = async () => "x";
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(0);
  });
});
