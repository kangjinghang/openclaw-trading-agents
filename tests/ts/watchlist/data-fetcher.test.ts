import { describe, it, expect } from "vitest";
import { parseKline, parseNews, parseNewsLayerStats, parseHotMoney, parseFundamentals, computeVolumeRatio } from "../../../src/watchlist/data-fetcher";

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
  it("提取 net_5d 净流入", () => {
    expect(parseHotMoney({ net_5d: 1.23e8 })).toEqual({ net_5d: 1.23e8 });
  });
  it("缺字段 → 0", () => {
    expect(parseHotMoney({})).toEqual({ net_5d: 0 });
  });
});

describe("parseFundamentals", () => {
  it("提取 pe/pb/rev_q1/np_q1 + industry（来自 stock_info）", () => {
    const raw = {
      pe_ttm: 35.2, pb: 4.5, revenue_q1: 1.2e9, net_profit_q1: 1.3e8,
      stock_info: { industry: "白酒", name: "贵州茅台", total_mv: 2.1e12 },
    };
    expect(parseFundamentals(raw)).toEqual({ pe: 35.2, pb: 4.5, rev_q1: 1.2e9, np_q1: 1.3e8, industry: "白酒" });
  });
  it("支持 pe_ttm 别名 + industry 缺失 → 空字符串", () => {
    const raw = { pe: 20, pb: 3, rev_q1: 5e8, np_q1: 6e7 };
    expect(parseFundamentals(raw)).toEqual({ pe: 20, pb: 3, rev_q1: 5e8, np_q1: 6e7, industry: "" });
  });
  it("缺字段 → 0 + industry 空字符串", () => {
    expect(parseFundamentals({})).toEqual({ pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" });
  });
  it("industry 空白字符串 → trim 为空", () => {
    expect(parseFundamentals({ stock_info: { industry: "   " } }).industry).toBe("");
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
    if (skillName === "trading-hot-money") return { success: true, data: { net_5d: 1e8 } } as any;
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
});

/** 辅助：复用 mockBySkill 的返回值逻辑（不重置 mock）。 */
function mockBySkillReturnValue(skillName: string): any {
  if (skillName === "trading-kline") return { success: true, data: { data: [{ close: 10, volume: 100 }, { close: 11, volume: 110 }] } };
  if (skillName === "trading-hot-money") return { success: true, data: { net_5d: 1e8 } };
  if (skillName === "trading-fundamentals") return { success: true, data: { pe_ttm: 20, pb: 3, stock_info: { industry: "x" } } };
  return { success: false };
}
