import { describe, it, expect } from "vitest";
import { parseKline, parseNews, parseNewsLayerStats, parseHotMoney, parseFundamentals, computeVolumeRatio, parseLockup, parseMacroView, fetchMacroData } from "../../../src/watchlist/data-fetcher";

describe("parseKline", () => {
  it("解析 data 对象数组（kline.py 真实结构）→ pct_5d/pct_20d/support/resistance/volatility_20d/volume_ratio_5_20", () => {
    // 25 个收盘价，从 10 到 22（每个 +0.5）；恒定 volume 100 → ratio = 1.0
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const raw = { data: closes.map(c => ({ date: "2026-01-01", open: c, high: c, low: c, close: c, volume: 100 })) };
    const k = parseKline(raw);
    expect(k.pct_5d).toBeGreaterThan(0);
    expect(k.pct_20d).toBeGreaterThan(k.pct_5d);
    expect(k.support).toBeLessThan(k.resistance);
    expect(k.volatility_20d).toBeGreaterThan(0);
    expect(k.volume_ratio_5_20).toBeCloseTo(1.0, 1);  // 恒定量 → ratio=1
  });

  it("兼容老格式：扁平 closes 数组（无 volume → ratio=0）", () => {
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const k = parseKline({ closes });
    expect(k.pct_5d).toBeGreaterThan(0);
    expect(k.volatility_20d).toBeGreaterThan(0);
    expect(k.volume_ratio_5_20).toBe(0);  // 无 volume 数据 → 0
  });

  it("空 data → 全 0", () => {
    expect(parseKline({ data: [] })).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 });
  });

  it("无 data/closes 字段 → 全 0（防御性）", () => {
    expect(parseKline({})).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 });
  });

  it("波动率：高波动 > 低波动", () => {
    // 低波动：平稳上涨
    const lowVol = Array.from({ length: 25 }, (_, i) => 100 + i * 0.1);
    // 高波动：来回震荡
    const highVol = Array.from({ length: 25 }, (_, i) => 100 * (1 + (i % 2 === 0 ? 0.05 : -0.05)));
    const kLow = parseKline({ data: lowVol.map(c => ({ close: c })) });
    const kHigh = parseKline({ data: highVol.map(c => ({ close: c })) });
    expect(kHigh.volatility_20d).toBeGreaterThan(kLow.volatility_20d);
  });

  it("量比：缩量（近5日均量 < 20日均量）→ ratio < 1", () => {
    // 前 20 日 volume=200，后 5 日 volume=100 → 近5日均 / 20日均 = 100/200 = 0.5
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const vols = [...Array(20).fill(200), ...Array(5).fill(100)];
    const raw = { data: closes.map((c, i) => ({ date: "2026-01-01", close: c, volume: vols[i] })) };
    const k = parseKline(raw);
    expect(k.volume_ratio_5_20).toBeCloseTo(0.5, 2);
  });

  it("量比：放量（近5日均量 > 20日均量）→ ratio > 1", () => {
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const vols = [...Array(20).fill(100), ...Array(5).fill(200)];
    const raw = { data: closes.map((c, i) => ({ date: "2026-01-01", close: c, volume: vols[i] })) };
    const k = parseKline(raw);
    expect(k.volume_ratio_5_20).toBeCloseTo(2.0, 2);
  });
});

describe("computeVolumeRatio", () => {
  it("缩量：近5日均 < 20日均 → ratio < 1", () => {
    const vols = [...Array(20).fill(200), ...Array(5).fill(100)];
    expect(computeVolumeRatio(vols, 5)).toBeCloseTo(0.5, 2);
  });

  it("放量：近5日均 > 20日均 → ratio > 1", () => {
    const vols = [...Array(20).fill(100), ...Array(5).fill(200)];
    expect(computeVolumeRatio(vols, 5)).toBeCloseTo(2.0, 2);
  });

  it("恒定量 → ratio = 1.0", () => {
    const vols = Array(25).fill(100);
    expect(computeVolumeRatio(vols, 5)).toBeCloseTo(1.0, 2);
  });

  it("数据不足（< 25）→ 0（防御性）", () => {
    expect(computeVolumeRatio([100, 200, 150], 5)).toBe(0);
  });

  it("空数组 → 0", () => {
    expect(computeVolumeRatio([], 5)).toBe(0);
  });

  it("20 日均量为 0 → 0（防除零）", () => {
    const vols = [...Array(20).fill(0), ...Array(5).fill(100)];
    expect(computeVolumeRatio(vols, 5)).toBe(0);
  });
});

describe("parseNews", () => {
  it("提取 stock_news 的 title/content/time/source（最多 5 条）", () => {
    const raw = { stock_news: [
      { title: "新闻 1", content: "正文 1", time: "2026-06-22 10:00", source: "财联社" },
      { title: "新闻 2", content: "正文 2" },
    ] };
    expect(parseNews(raw)).toEqual([
      { title: "新闻 1", content: "正文 1", time: "2026-06-22 10:00", source: "财联社" },
      { title: "新闻 2", content: "正文 2" },
    ]);
  });

  it("content 截断到 120 字（控制 prompt 总量）", () => {
    const longContent = "字".repeat(300);
    const result = parseNews({ stock_news: [{ title: "t", content: longContent }] });
    expect(result[0].content!.length).toBe(120);
  });

  it("兼容老格式 raw.news（仅 title 时其余字段缺失）", () => {
    const raw = { news: [{ title: "老格式" }] };
    expect(parseNews(raw)).toEqual([{ title: "老格式" }]);
  });

  it("无 news 字段 → 空数组", () => {
    expect(parseNews({})).toEqual([]);
  });

  it("title 缺失的条目被过滤", () => {
    const raw = { stock_news: [{ title: "ok" }, { content: "无标题" }, { title: "" }] };
    expect(parseNews(raw)).toEqual([{ title: "ok" }]);
  });
});

describe("parseNewsLayerStats", () => {
  it("提取 layer_stats 四个计数", () => {
    const raw = { layer_stats: { realtime_6h_count: 2, extended_24h_count: 5, history_7d_count: 18, total_categorized: 25 } };
    expect(parseNewsLayerStats(raw)).toEqual({
      realtime_6h_count: 2, extended_24h_count: 5, history_7d_count: 18, total_categorized: 25,
    });
  });

  it("全 0 → null（拉取失败/空数据，不误导 LLM）", () => {
    expect(parseNewsLayerStats({ layer_stats: { realtime_6h_count: 0, extended_24h_count: 0, history_7d_count: 0, total_categorized: 0 } })).toBeNull();
  });

  it("无 layer_stats 字段 → null", () => {
    expect(parseNewsLayerStats({})).toBeNull();
    expect(parseNewsLayerStats({ layer_stats: null })).toBeNull();
  });

  it("非数字字段容错为 0", () => {
    const raw = { layer_stats: { realtime_6h_count: "x", extended_24h_count: 3, history_7d_count: NaN, total_categorized: 3 } };
    expect(parseNewsLayerStats(raw)).toEqual({
      realtime_6h_count: 0, extended_24h_count: 3, history_7d_count: 0, total_categorized: 3,
    });
  });
});

describe("parseHotMoney", () => {
  it("解析真实 hot_money.py 结构：fund_flow + northbound + 3 个数组子源", () => {
    // 结构对齐 hot_money.py 实际输出（exec-python.ts 已把 raw.data 提到顶层）
    const raw = {
      ticker: "600519",
      fund_flow: { main_net: 1.23e8, large_net: 5e7, super_net: 7.3e7 },
      northbound: { total: 2.3, signal: "inflow" },
      sector_fund_flow: {
        inflow_top: [
          { name: "白酒", main_net_yi: 5.1 },
          { name: "半导体", main_net_yi: 4.2 },
          { name: "军工", main_net_yi: 3.0 },
        ],
        outflow_top: [
          { name: "房地产" },
          { name: "银行" },
          { name: "建材" },
        ],
      },
      hot_stocks: [
        { code: "600519", name: "贵州茅台", reason: "提价" },
        { code: "000001", name: "平安银行", reason: "降准" },
      ],
      dragon_tiger: [
        { date: "2026-06-18", net_buy: 1.2, turnover: 8.3, reason: "日涨幅偏离值达7%" },
        { date: "2026-06-10", net_buy: -0.4, turnover: 5.1, reason: "日换手率达20%" },
      ],
    };
    const r = parseHotMoney(raw, "白酒");
    expect(r.main_net_today).toBe(1.23e8);
    expect(r.super_net_today).toBe(7.3e7);
    expect(r.large_net_today).toBe(5e7);
    expect(r.northbound_yi).toBe(2.3);
    expect(r.northbound_signal).toBe("inflow");
    expect(r.dragon_tiger_recent).toContain("2次");
    expect(r.dragon_tiger_recent).toContain("06-18");
    expect(r.dragon_tiger_recent).toContain("净买+1.2亿");
    expect(r.dragon_tiger_reason).toBe("日涨幅偏离值达7%");  // 最近一条 reason
    expect(r.sector_inflow_top).toBe("白酒/半导体/军工");
    expect(r.sector_outflow_top).toBe("房地产/银行/建材");
    expect(r.sector_in_industry_tag).toBe("主线");  // 白酒在 inflow_top
    expect(r.hot_stocks_top).toContain("贵州茅台");
  });

  it("标的行业在 outflow_top → 弱势", () => {
    const raw = {
      sector_fund_flow: {
        inflow_top: [{ name: "半导体" }],
        outflow_top: [{ name: "白酒" }],
      },
    };
    expect(parseHotMoney(raw, "白酒").sector_in_industry_tag).toBe("弱势");
  });

  it("标的行业不在榜 → 未上榜", () => {
    const raw = { sector_fund_flow: { inflow_top: [{ name: "半导体" }] } };
    expect(parseHotMoney(raw, "白酒").sector_in_industry_tag).toBe("未上榜");
  });

  it("industry 为空（拉取失败）→ sector_in_industry_tag 留空，不误判", () => {
    const raw = { sector_fund_flow: { inflow_top: [{ name: "白酒" }] } };
    expect(parseHotMoney(raw, "").sector_in_industry_tag).toBe("");
  });

  it("缺字段 → 全 0/空（容忍，不抛）", () => {
    expect(parseHotMoney({})).toEqual({
      main_net_today: 0, super_net_today: 0, large_net_today: 0,
      inflow_today: 0, outflow_today: 0,
      northbound_yi: 0, northbound_signal: "",
      sector_in_industry_tag: "",
      dragon_tiger_recent: undefined, dragon_tiger_reason: undefined,
      sector_inflow_top: undefined, sector_outflow_top: undefined,
      hot_stocks_top: undefined,
    });
  });

  it("null/非对象输入 → 全 0", () => {
    expect(parseHotMoney(null)).toEqual({
      main_net_today: 0, super_net_today: 0, large_net_today: 0,
      inflow_today: 0, outflow_today: 0,
      northbound_yi: 0, northbound_signal: "",
      sector_in_industry_tag: "",
      dragon_tiger_recent: undefined, dragon_tiger_reason: undefined,
      sector_inflow_top: undefined, sector_outflow_top: undefined,
      hot_stocks_top: undefined,
    });
  });

  it("老格式 {net_5d:...}（已废弃的字段名）→ 不再被读取，返回 0", () => {
    // 回归测试：老实现读 raw.net_5d，但 hot_money.py 顶层无此字段（恒 0）。
    // 修正后读 raw.fund_flow.main_net，老格式的 net_5d 应被忽略。
    const r = parseHotMoney({ net_5d: 1.23e8 });
    expect(r.main_net_today).toBe(0);  // 不再从 net_5d 读
  });
});

describe("parseFundamentals", () => {
  // 真实结构对齐 fundamentals.py 的输出（fundamentals.py:27-89）：
  //   valuation.{pe_ttm,pb,...} / financial_snapshot.{revenue,net_profit,...} / stock_info.industry
  // 老测试传伪造的扁平结构（顶层 pe_ttm/pb/revenue_q1/net_profit_q1），与脚本输出不符，
  // 掩盖了字段路径 bug。这里改用真实嵌套结构，确保 parseFundamentals 与 fundamentals.py 对齐。
  it("从嵌套结构提取 pe/pb/rev_q1/np_q1 + industry（对齐 fundamentals.py）", () => {
    const raw = {
      ticker: "600519",
      valuation: { pe_ttm: 35.2, pb: 4.5, name: "贵州茅台", market_cap_yi: 21000 },
      financial_snapshot: { revenue: 1.2e9, net_profit: 1.3e8, roe: 15.2, debt_ratio: 20.1 },
      stock_info: { industry: "白酒", name: "贵州茅台", total_mv: 2.1e12 },
    };
    expect(parseFundamentals(raw)).toEqual({ pe: 35.2, pb: 4.5, rev_q1: 1.2e9, np_q1: 1.3e8, industry: "白酒" });
  });
  it("兼容老扁平格式（顶层 pe_ttm/pb + 别名 rev_q1/np_q1）", () => {
    const raw = { pe: 20, pb: 3, rev_q1: 5e8, np_q1: 6e7 };
    expect(parseFundamentals(raw)).toEqual({ pe: 20, pb: 3, rev_q1: 5e8, np_q1: 6e7, industry: "" });
  });
  it("嵌套结构与扁平结构同时存在时，嵌套优先（对齐 fundamentals.py 主路）", () => {
    const raw = {
      pe_ttm: 999, pb: 999,  // 顶层干扰值，应被嵌套覆盖
      valuation: { pe_ttm: 18.5, pb: 2.1 },
      financial_snapshot: { revenue: 2850000000, net_profit: 320000000 },
    };
    expect(parseFundamentals(raw)).toEqual({ pe: 18.5, pb: 2.1, rev_q1: 2850000000, np_q1: 320000000, industry: "" });
  });
  it("缺字段 → 0 + industry 空字符串", () => {
    expect(parseFundamentals({})).toEqual({ pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" });
  });
  it("industry 空白字符串 → trim 为空", () => {
    expect(parseFundamentals({ stock_info: { industry: "   " } }).industry).toBe("");
  });
  it("非数字（NaN/字符串）不污染数值字段（num 守卫）", () => {
    const raw = { valuation: { pe_ttm: NaN, pb: "高" }, financial_snapshot: { revenue: null } };
    expect(parseFundamentals(raw)).toEqual({ pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" });
  });
  it("读 PE/PB 历史分位（valuation_percentile，0-100）", () => {
    const raw = { valuation_percentile: { pe_percentile: 15.2, pb_percentile: 85 } };
    const r = parseFundamentals(raw);
    expect(r.pe_percentile).toBe(15.2);
    expect(r.pb_percentile).toBe(85);
  });
  it("分位非法值（0/负/>100/NaN）→ undefined（不污染 prompt）", () => {
    const raw = { valuation_percentile: { pe_percentile: 0, pb_percentile: 150 } };
    const r = parseFundamentals(raw);
    expect(r.pe_percentile).toBeUndefined();
    expect(r.pb_percentile).toBeUndefined();
  });
  it("无 valuation_percentile → 分位 undefined（向后兼容）", () => {
    expect(parseFundamentals({}).pe_percentile).toBeUndefined();
    expect(parseFundamentals({ valuation_percentile: {} }).pb_percentile).toBeUndefined();
  });
  it("透传 quarterly_trends / consensus_eps 原样对象（对齐 fundamentals.py）", () => {
    const trends = [
      { report_date: "2025-03-31", revenue_yi: 285, net_profit_yi: 32, revenue_yoy: 10.5 },
      { report_date: "2024-12-31", revenue_yi: 1200, net_profit_yi: 130, revenue_yoy: 8.2 },
    ];
    const consensus = {
      consensus_eps_current: 45, consensus_eps_next: 52, eps_growth_pct: 15.6,
      analyst_count: 26, ratings: { buy: 18, overweight: 5 },
      target_price_min: 1800, target_price_max: 2000,
    };
    const raw = {
      valuation: { pe_ttm: 35.2, pb: 4.5 },
      financial_snapshot: { revenue: 1.2e9, net_profit: 1.3e8 },
      stock_info: { industry: "白酒" },
      quarterly_trends: trends,
      consensus_eps: consensus,
    };
    const r = parseFundamentals(raw);
    expect(r.quarterly_trends).toEqual(trends);
    expect(r.consensus_eps).toEqual(consensus);
  });
  it("无 quarterly_trends / consensus_eps → 两个字段 undefined（不阻塞 render）", () => {
    const raw = { valuation: { pe_ttm: 20 }, financial_snapshot: { revenue: 1e8 } };
    const r = parseFundamentals(raw);
    expect(r.quarterly_trends).toBeUndefined();
    expect(r.consensus_eps).toBeUndefined();
  });
  it("quarterly_trends 非数组 / consensus_eps 非对象 → undefined（防御 fundamentals.py 异常输出）", () => {
    const r = parseFundamentals({ quarterly_trends: "oops", consensus_eps: 42 });
    expect(r.quarterly_trends).toBeUndefined();
    expect(r.consensus_eps).toBeUndefined();
  });
});

// ── fetchStockData: vpa_text 注入（mock execSkillScript）────────────
// 这组测试验证 safeCall 把 result.vpa 透传到 StockData.vpa_text，
// 让 risk-role LLM 能看到 kline.py 预计算的量价背离结论。
vi.mock("../../../src/exec-python", () => ({
  execSkillScript: vi.fn(),
}));

import { fetchStockData } from "../../../src/watchlist/data-fetcher";
import { execSkillScript } from "../../../src/exec-python";

/** 按 skillName 返回不同 stub：kline 带 vpa，其余只有 data。
 *  vpaContent 可覆盖（测"有 vpa"vs"无 vpa"两种）。 */
function mockBySkill(vpaContent?: string) {
  const mocked = vi.mocked(execSkillScript);
  mocked.mockImplementation(async (skillName: string) => {
    if (skillName === "trading-kline") {
      return {
        success: true,
        data: { data: [{ close: 10, volume: 100 }, { close: 11, volume: 110 }] },
        ...(vpaContent ? { vpa: vpaContent } : {}),
      } as any;
    }
    if (skillName === "trading-news") return {
      success: true,
      data: {
        stock_news: [{ title: "x" }],
        layer_stats: { realtime_6h_count: 1, extended_24h_count: 2, history_7d_count: 3, total_categorized: 6 },
      },
    } as any;
    if (skillName === "trading-hot-money") return { success: true, data: { fund_flow: { main_net: 1e8, large_net: 2e7, super_net: 3e7 }, northbound: { total: 1.5, signal: "inflow" } } } as any;
    if (skillName === "trading-fundamentals") return { success: true, data: { pe_ttm: 20, pb: 3, stock_info: { industry: "x" } } } as any;
    return { success: false } as any;
  });
}

describe("fetchStockData vpa_text 注入", () => {
  it("kline 脚本返回 vpa → StockData.vpa_text 被填充", async () => {
    mockBySkill("## VPA\n- **顶部背离信号**: 近5日价格上涨但成交量递减");
    const data = await fetchStockData("SH600519", "贵州茅台", "白酒");
    expect(data).not.toBeNull();
    expect(data!.vpa_text).toContain("顶部背离信号");
  });

  it("kline 脚本无 vpa 字段 → vpa_text undefined", async () => {
    mockBySkill(undefined);  // kline 不带 vpa
    const data = await fetchStockData("SH600519", "贵州茅台", "白酒");
    expect(data).not.toBeNull();
    expect(data!.vpa_text).toBeUndefined();
  });
});

describe("fetchStockData news 调用参数 + layer_stats", () => {
  it("调用 news.py 时传 --skip-macro（省 CLS+akshare 两路 HTTP）", async () => {
    mockBySkill();
    await fetchStockData("SH600519", "贵州茅台", "白酒");
    const mocked = vi.mocked(execSkillScript);
    const newsCall = mocked.mock.calls.find(c => c[0] === "trading-news");
    expect(newsCall).toBeDefined();
    const args = newsCall![3] as string[];
    expect(args).toContain("--skip-macro");
    expect(args).toContain("--ticker");
    expect(args).toContain("--date");
    expect(args).toContain("--lookback-days");
    expect(args).toContain("7");
  });

  it("news.py 返回 layer_stats → StockData.news_layer_stats 被填充", async () => {
    mockBySkill();
    const data = await fetchStockData("SH600519", "贵州茅台", "白酒");
    expect(data).not.toBeNull();
    expect(data!.news_layer_stats).toEqual({
      realtime_6h_count: 1, extended_24h_count: 2, history_7d_count: 3, total_categorized: 6,
    });
  });

  it("news.py 无 layer_stats → StockData.news_layer_stats undefined", async () => {
    const mocked = vi.mocked(execSkillScript);
    mocked.mockImplementation(async (skillName: string) => {
      if (skillName === "trading-news") return { success: true, data: { stock_news: [] } } as any;
      return mockBySkillReturnValue(skillName);
    });
    const data = await fetchStockData("SH600519", "贵州茅台", "白酒");
    expect(data).not.toBeNull();
    expect(data!.news_layer_stats).toBeUndefined();
  });

  // 回归测试：kline/hot_money/fundamentals 的 CLI 参数。
  // 这三个脚本的 --ticker/--date 是 argparse required 命名参数；老实现只传 [ticker]
  // 裸位置参数 → argparse 报错 exit 2 → safeCall 返回 null → 基本面恒为全零、
  // industry 恒为空（commit 56444b0 只修了 news，其余三个漏修）。本测试锁定修复。
  it("kline/hot_money/fundamentals 均传 --ticker/--date 命名参数（防 P0 回归）", async () => {
    mockBySkill();
    await fetchStockData("SH600519", "贵州茅台", "白酒");
    const mocked = vi.mocked(execSkillScript);

    // kline: --ticker required, --date 可选（default=""）
    const klineCall = mocked.mock.calls.find(c => c[0] === "trading-kline");
    expect(klineCall).toBeDefined();
    expect(klineCall![3]).toContain("--ticker");
    expect((klineCall![3] as string[]).includes("SH600519")).toBe(true);

    // hot_money: --ticker/--date 均 required
    const hotCall = mocked.mock.calls.find(c => c[0] === "trading-hot-money");
    expect(hotCall).toBeDefined();
    expect(hotCall![3]).toContain("--ticker");
    expect(hotCall![3]).toContain("--date");

    // fundamentals: --ticker/--date 均 required
    const fundCall = mocked.mock.calls.find(c => c[0] === "trading-fundamentals");
    expect(fundCall).toBeDefined();
    expect(fundCall![3]).toContain("--ticker");
    expect(fundCall![3]).toContain("--date");
  });

  // 回归测试：lockup 的 _calls 纳入健康报告（老实现遗漏 lockupR?.calls）。
  it("lockup 的 calls 被纳入 StockData.calls（防健康报告漏统计）", async () => {
    const mocked = vi.mocked(execSkillScript);
    mocked.mockImplementation(async (skillName: string) => {
      if (skillName === "trading-lockup") {
        return {
          success: true,
          data: { pressure_rating: "无", lockup_upcoming: [], reduce_holdings: [] },
          calls: [{ stage: "lockup/ann_em", success: true, duration_ms: 100, url: "http://x", status_code: 200 }],
        } as any;
      }
      return mockBySkillReturnValue(skillName);
    });
    const data = await fetchStockData("SH600519", "贵州茅台", "白酒");
    expect(data).not.toBeNull();
    expect(data!.calls).toBeDefined();
    expect(data!.calls!.some(c => c.stage === "lockup/ann_em")).toBe(true);
  });
});

/** 辅助：复用 mockBySkill 的返回值逻辑（不重置 mock）。 */
function mockBySkillReturnValue(skillName: string): any {
  if (skillName === "trading-kline") return { success: true, data: { data: [{ close: 10, volume: 100 }, { close: 11, volume: 110 }] } };
  if (skillName === "trading-hot-money") return { success: true, data: { fund_flow: { main_net: 1e8, large_net: 2e7, super_net: 3e7 }, northbound: { total: 1.5, signal: "inflow" } } };
  if (skillName === "trading-fundamentals") return { success: true, data: { pe_ttm: 20, pb: 3, stock_info: { industry: "x" } } };
  return { success: false };
}

// ── parseLockup：解禁+减持解析 ──────────────────────────────
describe("parseLockup", () => {
  it("完整数据 → 评级 + upcoming + reduce_holdings 解析", () => {
    const raw = {
      pressure_rating: "重大压力",
      lockup_upcoming: [
        { date: "2026-08-15", type: "定增限售", shares: "100000000", ratio: "0.4%" },
        { date: "2026-09-20", type: "首发原股东限售", ratio: "1.2%" },
      ],
      reduce_holdings: [
        { date: "2026-06-10", reducing_shareholder: "张某", reducing_shares: "5000000", reducing_ratio: "2.1%", reduce_reason: "个人资金需求" },
      ],
    };
    const l = parseLockup(raw);
    expect(l).not.toBeNull();
    expect(l!.pressure_rating).toBe("重大压力");
    expect(l!.upcoming).toHaveLength(2);
    expect(l!.upcoming[0]).toMatchObject({ date: "2026-08-15", type: "定增限售", ratio: "0.4%" });
    expect(l!.reduce_holdings).toHaveLength(1);
    expect(l!.reduce_holdings[0].reducing_shareholder).toBe("张某");
  });

  it("部分字段缺失（upcoming 元素无 type/shares）→ 只透传有的字段", () => {
    const l = parseLockup({
      pressure_rating: "中等压力",
      lockup_upcoming: [{ date: "2026-08-15", ratio: "0.4%" }],  // 无 type/shares
      reduce_holdings: [],
    });
    expect(l).not.toBeNull();
    expect(l!.upcoming[0]).toEqual({ date: "2026-08-15", ratio: "0.4%" });  // 无 type/shares 键
    expect(l!.upcoming[0].type).toBeUndefined();
  });

  it("无解禁无减持但有评级 → 保留（让 LLM 知道无明显压力）", () => {
    const l = parseLockup({ pressure_rating: "无明显压力", lockup_upcoming: [], reduce_holdings: [] });
    expect(l).not.toBeNull();
    expect(l!.pressure_rating).toBe("无明显压力");
    expect(l!.upcoming).toEqual([]);
  });

  it("全空（评级未知 + 无数据）→ null（无数据，省略整段）", () => {
    expect(parseLockup({})).toBeNull();
    expect(parseLockup(null)).toBeNull();
    expect(parseLockup({ lockup_upcoming: [], reduce_holdings: [] })).toBeNull();  // 无评级 + 空
  });

  it("upcoming 元素缺 date → 过滤掉（date 是必需锚点）", () => {
    const l = parseLockup({
      pressure_rating: "中等压力",
      lockup_upcoming: [{ type: "定增", ratio: "1%" }, { date: "2026-08-15", ratio: "0.4%" }],  // 第一个无 date
      reduce_holdings: [],
    });
    expect(l!.upcoming).toHaveLength(1);
    expect(l!.upcoming[0].date).toBe("2026-08-15");
  });
});

// ── parseMacroView + fetchMacroData：宏观一次性抓取解析 ───────────────
describe("parseMacroView", () => {
  it("完整 sector_view + commodities → MacroView 解析", () => {
    const raw = {
      sector_view: {
        market_view: "震荡偏多",
        pmi_signal: "官方与财新PMI双口径共振向上",
        bullish_sectors: ["银行", "工程机械"],
        bearish_sectors: ["煤炭"],
        sector_scores: { 银行: 3, 工程机械: 2, 煤炭: -1 },
        indicators_used: ["manufacturing_pmi", "m2_yoy"],
      },
      commodities: {
        AU0: { label: "黄金", chg_5d: 2.1, chg_20d: 5.3, trend: "上行" },
        SC0: { label: "原油", chg_5d: -1.0, chg_20d: -3.0, trend: "下行" },
      },
    };
    const v = parseMacroView(raw);
    expect(v).not.toBeNull();
    expect(v!.market_view).toBe("震荡偏多");
    expect(v!.pmi_signal).toBe("官方与财新PMI双口径共振向上");
    expect(v!.bullish_sectors).toEqual(["银行", "工程机械"]);
    expect(v!.bearish_sectors).toEqual(["煤炭"]);
    expect(v!.sector_scores!["银行"]).toBe(3);
    expect(v!.commodities!["AU0"]).toMatchObject({ label: "黄金", chg_5d: 2.1, trend: "上行" });
  });

  it("只有 commodities（无 sector_view）→ 仍返回有效 MacroView", () => {
    const v = parseMacroView({ commodities: { AU0: { label: "黄金" } } });
    expect(v).not.toBeNull();
    expect(v!.commodities!["AU0"].label).toBe("黄金");
    expect(v!.market_view).toBeUndefined();
  });

  it("全空（无 sector_view 无 commodities）→ null", () => {
    expect(parseMacroView({})).toBeNull();
    expect(parseMacroView(null)).toBeNull();
    expect(parseMacroView({ sector_view: {} })).toBeNull();  // 无 market_view + 无 commodities
  });

  it("commodities 元素缺 chg → 只保留 label（容忍）", () => {
    const v = parseMacroView({ commodities: { CU0: { label: "铜" } } });
    expect(v!.commodities!["CU0"]).toEqual({ label: "铜" });
    expect(v!.commodities!["CU0"].chg_5d).toBeUndefined();
  });
});

describe("fetchMacroData", () => {
  beforeEach(() => {
    vi.mocked(execSkillScript).mockReset();
  });

  it("execSkillScript 返回 macro JSON → 解析为 MacroView", async () => {
    const mocked = vi.mocked(execSkillScript);
    mocked.mockResolvedValueOnce({
      success: true,
      data: {
        sector_view: { market_view: "结构性机会为主", bullish_sectors: ["半导体"] },
        commodities: { AU0: { label: "黄金", trend: "上行", chg_5d: 1.5 } },
      },
    } as any);
    const v = await fetchMacroData("2026-06-20");
    expect(v).not.toBeNull();
    expect(v!.market_view).toBe("结构性机会为主");
    expect(v!.bullish_sectors).toEqual(["半导体"]);
    // 验证调用参数：--macro-only --date（mock 是全局共享，按 skillName 找本次调用）
    const macroCall = mocked.mock.calls.find(c => c[0] === "trading-news" && (c[3] as string[]).includes("--macro-only"));
    expect(macroCall).toBeDefined();
    const args = macroCall![3] as string[];
    expect(args).toContain("--macro-only");
    expect(args).toContain("--date");
    expect(args).toContain("2026-06-20");
  });

  it("execSkillScript 失败 → null（graceful degrade）", async () => {
    const mocked = vi.mocked(execSkillScript);
    mocked.mockResolvedValueOnce({ success: false, error: "boom" } as any);
    const v = await fetchMacroData("2026-06-20");
    expect(v).toBeNull();
  });

  it("execSkillScript 抛异常 → null（不阻塞主流程）", async () => {
    const mocked = vi.mocked(execSkillScript);
    mocked.mockRejectedValueOnce(new Error("spawn failed"));
    const v = await fetchMacroData("2026-06-20");
    expect(v).toBeNull();
  });

  it("返回全空 macro → null", async () => {
    const mocked = vi.mocked(execSkillScript);
    mocked.mockResolvedValueOnce({ success: true, data: {} } as any);
    const v = await fetchMacroData("2026-06-20");
    expect(v).toBeNull();
  });
});
