import { describe, it, expect } from "vitest";
import { parseKline, parseNews, parseHotMoney, parseFundamentals } from "../../../src/watchlist/data-fetcher";

describe("parseKline", () => {
  it("解析 closes 数组 → pct_5d/pct_20d/support/resistance", () => {
    // 25 个收盘价，从 10 到 22（每个 +0.5）
    const closes = Array.from({ length: 25 }, (_, i) => 10 + i * 0.5);
    const k = parseKline({ closes });
    expect(k.pct_5d).toBeGreaterThan(0);
    expect(k.pct_20d).toBeGreaterThan(k.pct_5d);
    expect(k.support).toBeLessThan(k.resistance);
  });

  it("空 closes → 全 0", () => {
    expect(parseKline({ closes: [] })).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 });
  });

  it("无 closes 字段 → 全 0（防御性）", () => {
    expect(parseKline({})).toEqual({ pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 });
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
  it("提取 pe/pb/rev_q1/np_q1（支持 pe_ttm 别名）", () => {
    const raw = { pe_ttm: 35.2, pb: 4.5, revenue_q1: 1.2e9, net_profit_q1: 1.3e8 };
    expect(parseFundamentals(raw)).toEqual({ pe: 35.2, pb: 4.5, rev_q1: 1.2e9, np_q1: 1.3e8 });
  });
  it("缺字段 → 0", () => {
    expect(parseFundamentals({})).toEqual({ pe: 0, pb: 0, rev_q1: 0, np_q1: 0 });
  });
});
