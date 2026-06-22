import { describe, it, expect } from "vitest";
import { formatAnalystPrompt, parseAnalystReport, formatRiskPrompt, parseRiskReport, buildStockReport, buildFallbackReport, analyzeAll, type ShallowLlmCaller, type StockData } from "../../../src/watchlist/shallow-analyzer";
import type { AnalystReport } from "../../../src/watchlist/rebalance-types";
import type { CandidateMeta } from "../../../src/watchlist/candidate-selector";
import type { StockData } from "../../../src/watchlist/shallow-analyzer";

describe("formatAnalystPrompt", () => {
  it("渲染包含 ticker/sector + 数据摘要", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319",
      name: "麦捷科技",
      sector: "电子",
      kline: { pct_5d: 12.3, pct_20d: 45.6, support: 25.0, resistance: 30.0, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
      news: [
        { title: "新闻 1", content: "正文 1", time: "2026-06-22 10:00", source: "财联社" },
        { title: "新闻 2" },
      ],
      hot_money: { net_5d: 1.2e8 },
      fundamentals: { pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子" },
      ranker_thesis: "TLVR 电感获英伟达认证",
      news_layer_stats: { realtime_6h_count: 1, extended_24h_count: 2, history_7d_count: 3, total_categorized: 6 },
    });
    expect(prompt).toContain("SZ300319 麦捷科技");
    expect(prompt).toContain("电子");
    expect(prompt).toContain("12.3");
    expect(prompt).toContain("新闻 1");
    expect(prompt).toContain("正文 1");            // content 注入
    expect(prompt).toContain("2026-06-22 10:00");  // time 注入
    expect(prompt).toContain("新闻密度");            // layer_stats 注入
    expect(prompt).toContain("6h 内 1 条突发");      // realtime 突发
    expect(prompt).toContain("7 天共 6 条");          // total 密度
    expect(prompt).toContain("120000000");
    expect(prompt).toContain("英伟达认证");
  });

  it("包含评分锚点（5 档标准，对齐下游阈值）", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 },
      news: [], hot_money: { net_5d: 0 },
      fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" },
    });
    // 锚点关键词（对齐下游 ≥8 BUY / ≤5 减仓 / ≤6 不买 阈值）
    expect(prompt).toContain("业绩已兑现");
    expect(prompt).toContain("传闻未证实");
    expect(prompt).toContain("零营收");
    expect(prompt).toContain("严格对齐");
  });

  it("news_layer_stats 缺失 → 不渲染密度行（无残留占位符）", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 },
      news: [], hot_money: { net_5d: 0 },
      fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" },
      // 无 news_layer_stats
    });
    expect(prompt).not.toContain("新闻密度");
    expect(prompt).not.toContain("{news_density}");  // 占位符不残留
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
      kline: { pct_5d: 12, pct_20d: 45, support: 25, resistance: 30, volume_ratio_5_20: 0.6 },
      news: [{ title: "n1" }], hot_money: { net_5d: 1 }, fundamentals: { pe: 50, pb: 5, rev_q1: 1, np_q1: 0.1 },
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

  it("注入 K 线数据（pct/支撑压力/量比）—— 修复占位符 bug", () => {
    const data: any = {
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 15.2, pct_20d: 45.6, support: 25, resistance: 30, volume_ratio_5_20: 0.6 },
      news: [{ title: "n1" }], hot_money: { net_5d: 1.2e8 }, fundamentals: { pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8 },
    };
    const analyst: AnalystReport = {
      thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [],
    };
    const p = formatRiskPrompt(data, analyst);
    // 修复前 risk prompt 的 K 线段写"（同 analyst-role 输入）"占位符，看不到任何数字
    expect(p).toContain("15.2");          // pct_5d
    expect(p).toContain("45.6");          // pct_20d
    expect(p).toContain("0.6");           // volume_ratio_5_20（量比）
    expect(p).not.toContain("同 analyst"); // 占位符已移除
  });

  it("注入 VPA 量价预计算结论（含顶部背离信号）", () => {
    const data: any = {
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 12, pct_20d: 45, support: 25, resistance: 30, volume_ratio_5_20: 0.6 },
      news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 },
      vpa_text: "## VPA\n- **顶部背离信号**: 近5日价格上涨但成交量递减，上涨动能可能衰竭",
    };
    const analyst: AnalystReport = {
      thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [],
    };
    const p = formatRiskPrompt(data, analyst);
    expect(p).toContain("顶部背离信号");
    expect(p).toContain("VPA");
  });

  it("无 vpa_text → 标注（无 VPA 数据），不报错", () => {
    const data: any = {
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 12, pct_20d: 45, support: 25, resistance: 30, volume_ratio_5_20: 0.6 },
      news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 },
      // 无 vpa_text
    };
    const analyst: AnalystReport = {
      thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [],
    };
    const p = formatRiskPrompt(data, analyst);
    expect(p).toContain("无 VPA 数据");
  });

  it("注入基本面数据（PE/净利）—— risk-role 独立看数据做风险判断", () => {
    const data: any = {
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 12, pct_20d: 45, support: 25, resistance: 30, volume_ratio_5_20: 0.6 },
      news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 85, pb: 5, rev_q1: 1e9, np_q1: 1e8 },
    };
    const analyst: AnalystReport = {
      thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [],
    };
    const p = formatRiskPrompt(data, analyst);
    expect(p).toContain("85");  // PE（偏高，risk-role 应能看到）
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
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "电子", kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 }, news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "电子" } }],
      ["SH600183", { ticker: "SH600183", name: "生益科技", sector: "PCB", kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 }, news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "PCB" } }],
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
      dataByTicker.set(m.ticker, { ticker: m.ticker, name: m.name, sector: "x", kline: { pct_5d: 1, pct_20d: 1, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 }, news: [], hot_money: { net_5d: 0 }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "x" } });
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

describe("buildFallbackReport（持仓股失败兜底）", () => {
  it("默认值：fitness=5, risk=high, deal_breaker=false", () => {
    const meta: CandidateMeta = {
      ticker: "SH600183", name: "生益科技", is_held: true,
      current_weight: 0.10, days_held: 8, locked: false, ranker_score: 9.0,
    };
    const r = buildFallbackReport(meta, "PCB", "LLM 调用异常：timeout");
    expect(r.ticker).toBe("SH600183");
    expect(r.fitness_score).toBe(5);
    expect(r.overall_risk).toBe("high");
    expect(r.deal_breaker).toBe(false);
    expect(r.is_held).toBe(true);
    expect(r.current_weight).toBe(0.10);
    expect(r.days_held).toBe(8);
    expect(r.locked).toBe(false);
    expect(r.ranker_score).toBe(9.0);
    expect(r.thesis).toContain("shallow-analyzer 失败");
    expect(r.thesis).toContain("timeout");
    expect(r.data_gaps[0]).toContain("timeout");
    expect(r.risk_flags[0].severity).toBe("高");
  });

  it("保留 locked 状态（不会被乱减锁定股）", () => {
    const meta: CandidateMeta = {
      ticker: "SZ300319", name: "麦捷科技", is_held: true,
      current_weight: 0.10, days_held: 3, locked: true, ranker_score: 9.2,
    };
    const r = buildFallbackReport(meta, "电子", "analyst 返回非 JSON");
    expect(r.locked).toBe(true);
    expect(r.days_held).toBe(3);
  });
});

describe("analyzeAll 持仓股失败兜底", () => {
  // 复用的假数据构造器
  function makeData(ticker: string, name: string): StockData {
    return {
      ticker, name, sector: "电子",
      kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
      news: [], hot_money: { net_5d: 0 },
      fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "电子" },
    };
  }

  it("持仓股 analyst 失败 → 返回 fallback report（不是消失）", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "HELD", name: "持仓股", is_held: true, current_weight: 0.10, days_held: 8, locked: false },
    ];
    const dataByTicker = new Map([["HELD", makeData("HELD", "持仓股")]]);
    // analyst 返回非 JSON
    const mockCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return "not json";
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(1);  // 不消失
    expect(reports[0].fitness_score).toBe(5);  // 默认值
    expect(reports[0].overall_risk).toBe("high");
    expect(reports[0].thesis).toContain("shallow-analyzer 失败");
    expect(reports[0].data_gaps[0]).toContain("analyst-role");
  });

  it("候选股 analyst 失败 → 仍跳过（行为不变）", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "CAND", name: "候选股", is_held: false, current_weight: 0, days_held: 0, locked: false },
    ];
    const dataByTicker = new Map([["CAND", makeData("CAND", "候选股")]]);
    const mockCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return "not json";
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(0);  // 候选股跳过
  });

  it("持仓股 LLM 抛异常 → fallback report", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "HELD", name: "持仓股", is_held: true, current_weight: 0.10, days_held: 8, locked: false },
    ];
    const dataByTicker = new Map([["HELD", makeData("HELD", "持仓股")]]);
    const mockCaller: ShallowLlmCaller = async () => { throw new Error("429 rate limit"); };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(1);
    expect(reports[0].fitness_score).toBe(5);
    expect(reports[0].data_gaps[0]).toContain("429");
  });

  it("持仓股 dataByTicker 缺失 → fallback report（sector=未分类）", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "HELD", name: "持仓股", is_held: true, current_weight: 0.10, days_held: 8, locked: false },
    ];
    const dataByTicker = new Map<string, StockData>();  // 空
    const mockCaller: ShallowLlmCaller = async () => "x";
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(1);
    expect(reports[0].sector).toBe("未分类");
    expect(reports[0].data_gaps[0]).toContain("数据拉取失败");
  });

  it("持仓股 risk-role 失败 → fallback report", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "HELD", name: "持仓股", is_held: true, current_weight: 0.10, days_held: 8, locked: false },
    ];
    const dataByTicker = new Map([["HELD", makeData("HELD", "持仓股")]]);
    const mockCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return "not json";  // risk 失败
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(1);
    expect(reports[0].fitness_score).toBe(5);  // fallback，不是 analyst 给的 8
    expect(reports[0].data_gaps[0]).toContain("risk-role");
  });
});
