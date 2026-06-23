import { describe, it, expect } from "vitest";
import { formatAnalystPrompt, parseAnalystReport, formatRiskPrompt, parseRiskReport, buildStockReport, buildFallbackReport, analyzeAll, renderQuarterlyTrends, renderConsensus, type ShallowLlmCaller, type StockData, type ConsensusEps } from "../../../src/watchlist/shallow-analyzer";
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
      hot_money: { main_net_today: 1.2e8, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
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
    expect(prompt).toContain("1.20亿");  // main_net_today 1.2e8 元 → formatYi 渲染为 1.20 亿
    expect(prompt).toContain("英伟达认证");
  });

  it("包含评分锚点（5 档标准，对齐下游阈值）", () => {
    const prompt = formatAnalystPrompt({
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 },
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
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
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
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
      news: [{ title: "n1" }], hot_money: { main_net_today: 1, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 50, pb: 5, rev_q1: 1, np_q1: 0.1 },
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
      news: [{ title: "n1" }], hot_money: { main_net_today: 1.2e8, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8 },
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
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 },
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
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 },
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
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 85, pb: 5, rev_q1: 1e9, np_q1: 1e8 },
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

  it("qualityNotes 参数 → 落 StockReport.quality_notes", () => {
    const report = buildStockReport(
      { ticker: "X", name: "x", is_held: false, current_weight: 0, days_held: 0, locked: false },
      "x",
      { thesis: "x", fitness_score: 6, data_freshness: "", key_signals: [], data_gaps: [] },
      { risk_flags: [], overall_risk: "low", deal_breaker: false },
      ["fitness 8→6（PE=0 数据缺失封顶）"],
    );
    expect(report.quality_notes).toEqual(["fitness 8→6（PE=0 数据缺失封顶）"]);
  });

  it("不传 qualityNotes 或空数组 → 不写 quality_notes（向后兼容）", () => {
    const base = {
      ticker: "X", name: "x", is_held: false, current_weight: 0, days_held: 0, locked: false,
    };
    const analyst = { thesis: "x", fitness_score: 8, data_freshness: "", key_signals: [], data_gaps: [] };
    const risk = { risk_flags: [], overall_risk: "low", deal_breaker: false };
    expect(buildStockReport(base, "x", analyst, risk).quality_notes).toBeUndefined();
    expect(buildStockReport(base, "x", analyst, risk, []).quality_notes).toBeUndefined();
  });
});

// ── 确定性质量门控集成（analyzeAll 端到端）──────────────────
// 核心价值点：LLM 编造数据给高 fitness，gate 基于真实 StockData 钳制，
// 切断「幻觉数据 → 错误 fitness → 错误仓位」链路。
describe("analyzeAll 确定性质量门控集成", () => {
  it("LLM 给 fitness=8 但 StockData PE=0 → 产出 fitness=6 + quality_notes 非空", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "HALL", name: "幻觉股", is_held: false, current_weight: 0, days_held: 0, locked: false },
    ];
    const dataByTicker = new Map<string, StockData>([
      // PE=0（数据缺失），但 LLM 仍给 fitness=8
      ["HALL", {
        ticker: "HALL", name: "幻觉股", sector: "电子",
        kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
        news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
        fundamentals: { pe: 0, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子" },
      }],
    ]);
    const mockCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") {
        return JSON.stringify({ thesis: "业绩大增订单饱满", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      }
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports).toHaveLength(1);
    // 幻觉链断点：fitness 被代码从 8 钳到 6（position-calculator 查表 ≤6→0%，不会建仓）
    expect(reports[0].fitness_score).toBe(6);
    expect(reports[0].quality_notes).toBeDefined();
    expect(reports[0].quality_notes!.length).toBeGreaterThan(0);
    expect(reports[0].quality_notes![0]).toContain("数据缺失");
  });

  it("数据完备 + fitness=8 → gate 不介入，quality_notes 不写", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "OK", name: "正常股", is_held: false, current_weight: 0, days_held: 0, locked: false },
    ];
    const dataByTicker = new Map<string, StockData>([
      ["OK", {
        ticker: "OK", name: "正常股", sector: "电子",
        kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
        news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
        fundamentals: { pe: 30, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子" },
      }],
    ]);
    const mockCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") {
        // thesis ≥20 字，避免触发规则 6（过短）；不含传闻词，避免触发规则 2
        return JSON.stringify({ thesis: "TLVR 电感已批量供货英伟达，订单排至 2027 年", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      }
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const reports = await analyzeAll(metas, dataByTicker, mockCaller);
    expect(reports[0].fitness_score).toBe(8);  // 不动
    expect(reports[0].quality_notes).toBeUndefined();
  });
});

describe("analyzeAll", () => {
  it("对每只股跑 2 calls（analyst + risk），返回 StockReport 数组", async () => {
    const metas: CandidateMeta[] = [
      { ticker: "SZ300319", name: "麦捷科技", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 9.2 },
      { ticker: "SH600183", name: "生益科技", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 9.0 },
    ];
    const dataByTicker = new Map<string, StockData>([
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "电子", kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 }, news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "电子" } }],
      ["SH600183", { ticker: "SH600183", name: "生益科技", sector: "PCB", kline: { pct_5d: 1, pct_20d: 2, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 }, news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "PCB" } }],
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
      dataByTicker.set(m.ticker, { ticker: m.ticker, name: m.name, sector: "x", kline: { pct_5d: 1, pct_20d: 1, support: 1, resistance: 2, volatility_20d: 0.02, volume_ratio_5_20: 1.0 }, news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 1, pb: 1, rev_q1: 1, np_q1: 1, industry: "x" } });
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
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
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

// ── renderQuarterlyTrends：4 季度趋势预压缩（对齐 renderHotMoneySummary 范式）──
describe("renderQuarterlyTrends", () => {
  it("完整 4 季度 → 营收/净利/ROE 三段管道分隔（含同比）", () => {
    const trends = [
      { report_date: "2025-03-31", revenue_yi: 285, net_profit_yi: 32, revenue_yoy: 10.5, net_profit_yoy: 12.3, roe: 4.2 },
      { report_date: "2024-12-31", revenue_yi: 1200, net_profit_yi: 130, revenue_yoy: 8.2, net_profit_yoy: 9.1, roe: 15.6 },
      { report_date: "2024-09-30", revenue_yi: 880, net_profit_yi: 95, revenue_yoy: 7.1, net_profit_yoy: 8.0, roe: 11.5 },
      { report_date: "2024-06-30", revenue_yi: 560, net_profit_yi: 60, revenue_yoy: 6.0, net_profit_yoy: 7.0, roe: 7.8 },
    ];
    const out = renderQuarterlyTrends(trends);
    // 含营收趋势 + 净利趋势（LLM 判断业绩连续性的核心）
    expect(out).toContain("营收");
    expect(out).toContain("285");  // 最近季度营收
    expect(out).toContain("+10.5%");  // 同比带正号
    expect(out).toContain("净利");
    expect(out).toContain("32");
    expect(out).toContain("ROE");
    // 管道分隔（一行文本，对齐 renderHotMoneySummary）
    expect(out).toContain("|");
  });

  it("只有 1-2 个季度 → 仍渲染（数据稀疏不阻塞）", () => {
    const out = renderQuarterlyTrends([
      { report_date: "2025-03-31", revenue_yi: 285, net_profit_yi: 32 },
    ]);
    expect(out).toContain("285");
    expect(out).toContain("32");
  });

  it("部分字段缺失（无同比）→ 省略同比，只渲染有值的字段", () => {
    const out = renderQuarterlyTrends([
      { report_date: "2025-03-31", revenue_yi: 285, net_profit_yi: 32 },  // 无 yoy/roe
    ]);
    expect(out).toContain("285");
    expect(out).not.toContain("%");  // 无同比则不出 % 号
  });

  it("负同比（业绩下滑）→ 带负号，让 LLM 识别风险", () => {
    const out = renderQuarterlyTrends([
      { report_date: "2025-03-31", revenue_yi: 200, revenue_yoy: -15.3 },
    ]);
    expect(out).toContain("-15.3%");
  });

  it("空数组 / undefined → 空串（prompt 该行省略，不污染）", () => {
    expect(renderQuarterlyTrends([])).toBe("");
    expect(renderQuarterlyTrends(undefined)).toBe("");
  });
});

// ── renderConsensus：机构一致预期预压缩（对齐 renderHotMoneySummary 范式）──
describe("renderConsensus", () => {
  it("完整字段 → 机构数/EPS趋势/目标价/评级/远期PE/PEG 一行管道分隔", () => {
    const c: ConsensusEps = {
      analyst_count: 26,
      consensus_eps_current: 45, consensus_eps_next: 52, eps_growth_pct: 15.6,
      target_price_min: 1800, target_price_max: 2000,
      ratings: { buy: 18, overweight: 5, neutral: 3 },
      forward_pe: 34.6, peg: 2.2,
    };
    const out = renderConsensus(c);
    expect(out).toContain("26家");
    expect(out).toContain("EPS");
    expect(out).toContain("45");
    expect(out).toContain("52");
    expect(out).toContain("+15.6%");  // 增速带正号
    expect(out).toContain("目标价");
    expect(out).toContain("1800");
    expect(out).toContain("2000");
    expect(out).toContain("买18");   // 评级分布
    expect(out).toContain("远期PE");
    expect(out).toContain("34.6");
    expect(out).toContain("PEG");
    expect(out).toContain("2.2");
    expect(out).toContain("|");
  });

  it("无机构覆盖（analyst_count 缺失）→ 仍渲染 EPS/目标价等有的字段", () => {
    const out = renderConsensus({ consensus_eps_current: 45, consensus_eps_next: 52 });
    expect(out).toContain("45");
    expect(out).toContain("52");
    expect(out).not.toContain("家");  // 无机构数
  });

  it("负增速（业绩预期下滑）→ 带负号，让 LLM 识别风险", () => {
    const out = renderConsensus({ consensus_eps_current: 52, consensus_eps_next: 45, eps_growth_pct: -13.5 });
    expect(out).toContain("-13.5%");
  });

  it("只有目标价无 EPS → 渲染目标价段", () => {
    const out = renderConsensus({ target_price_min: 1800, target_price_max: 2000, analyst_count: 5 });
    expect(out).toContain("目标价");
    expect(out).toContain("1800-2000");
    expect(out).toContain("5家");
  });

  it("undefined / 空对象 → 空串（很多小盘股无机构覆盖，prompt 该行省略）", () => {
    expect(renderConsensus(undefined)).toBe("");
    expect(renderConsensus({})).toBe("");
  });

  it("PEG 缺失（非正增长场景）→ 不输出 PEG 段（fundamentals.py 仅正增长时算 PEG）", () => {
    const out = renderConsensus({ consensus_eps_current: 45, consensus_eps_next: 52, eps_growth_pct: 15.6, forward_pe: 34.6 });
    expect(out).toContain("远期PE");
    expect(out).not.toContain("PEG");
  });
});

// ── formatAnalystPrompt / formatRiskPrompt：新基本面数据接入 ──
// 验证 renderQuarterlyTrends / renderConsensus 真的注入 prompt，
// 且无数据时整段省略（不污染、不留空占位符）。
describe("formatAnalystPrompt 基本面深度数据注入", () => {
  const baseData = (): StockData => ({
    ticker: "SH600519", name: "贵州茅台", sector: "白酒",
    kline: { pct_5d: 1, pct_20d: 2, support: 100, resistance: 200, volatility_20d: 0.02, volume_ratio_5_20: 1.0 },
    news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
    fundamentals: { pe: 30, pb: 10, rev_q1: 4e9, np_q1: 2e9, industry: "白酒" },
  });

  it("有季度趋势 + 机构预期 → prompt 含两段渲染文本", () => {
    const d = baseData();
    d.fundamentals.quarterly_trends = [
      { report_date: "2025-03-31", revenue_yi: 285, net_profit_yi: 32, revenue_yoy: 10.5 },
    ];
    d.fundamentals.consensus_eps = {
      analyst_count: 26, consensus_eps_current: 45, consensus_eps_next: 52, eps_growth_pct: 15.6,
      target_price_min: 1800, target_price_max: 2000, ratings: { buy: 18 }, forward_pe: 34.6,
    };
    const prompt = formatAnalystPrompt(d);
    expect(prompt).toContain("285亿");          // 季度营收
    expect(prompt).toContain("26家覆盖");        // 机构数
    expect(prompt).toContain("1800-2000");       // 目标价
  });

  it("无季度趋势 + 无机构预期 → prompt 不含对应段（不留空占位符）", () => {
    const prompt = formatAnalystPrompt(baseData());
    // 渲染函数返回空串时，模板里占位符被替换为空，整段标题行可能保留但内容为空。
    // 关键：不能出现孤立的占位符字面量 {quarterly_trends}，也不能出现误导性的空括号。
    expect(prompt).not.toContain("{quarterly_trends}");
    expect(prompt).not.toContain("{consensus_eps}");
  });

  it("评分原则含「季度业绩连续增长」硬证据条款（让新数据影响 fitness）", () => {
    const prompt = formatAnalystPrompt(baseData());
    expect(prompt).toMatch(/季度.*连续.*增长|连续.*增长.*季度|quarterly.*trend/i);
  });
});

describe("formatRiskPrompt 基本面深度数据注入", () => {
  it("有季度趋势 → risk prompt 也含（风险分析需要业绩拐点）", () => {
    const d: StockData = {
      ticker: "SZ300319", name: "麦捷科技", sector: "电子",
      kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 },
      news: [], hot_money: { main_net_today: 0, super_net_today: 0, large_net_today: 0, northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
      fundamentals: {
        pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8, industry: "电子",
        quarterly_trends: [{ report_date: "2025-03-31", revenue_yi: 200, revenue_yoy: -15.3 }],
      },
    };
    const prompt = formatRiskPrompt(d, { thesis: "x", fitness_score: 7, data_freshness: "", key_signals: [], data_gaps: [] });
    expect(prompt).toContain("200亿");
    expect(prompt).toContain("-15.3%");  // 负同比让 risk LLM 识别业绩下滑
  });
});
