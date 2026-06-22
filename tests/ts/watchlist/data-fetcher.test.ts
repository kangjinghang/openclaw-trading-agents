import { describe, it, expect } from "vitest";
import { parseKline, parseNews, parseHotMoney, parseFundamentals } from "../../../src/watchlist/data-fetcher";

describe("parseKline", () => {
  it("解析 data 对象数组（kline.py 真实结构）→ pct_5d/pct_20d/support/resistance/volatility_20d", () => {
    // 25 个收盘价，从 10 到 22（每个 +0.5）
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const raw = { data: closes.map(c => ({ date: "2026-01-01", open: c, high: c, low: c, close: c, volume: 100 })) };
    const k = parseKline(raw);
    expect(k.pct_5d).toBeGreaterThan(0);
    expect(k.pct_20d).toBeGreaterThan(k.pct_5d);
    expect(k.support).toBeLessThan(k.resistance);
    expect(k.volatility_20d).toBeGreaterThan(0);
  });

  it("兼容老格式：扁平 closes 数组", () => {
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const k = parseKline({ closes });
    expect(k.pct_5d).toBeGreaterThan(0);
    expect(k.volatility_20d).toBeGreaterThan(0);
  });

  it("空 data → 全 0", () => {
    expect(parseKline({ data: [] })).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0 });
  });

  it("无 data/closes 字段 → 全 0（防御性）", () => {
    expect(parseKline({})).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0 });
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
});

describe("parseNews", () => {
  it("提取 news 列表的 title 字段（最多 5 条）", () => {
    const raw = { news: [
      { title: "新闻 1", content: "..." },
      { title: "新闻 2", content: "..." },
    ] };
    expect(parseNews(raw)).toEqual(["新闻 1", "新闻 2"]);
  });

  it("无 news 字段 → 空数组", () => {
    expect(parseNews({})).toEqual([]);
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
