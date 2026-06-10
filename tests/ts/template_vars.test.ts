// tests/ts/template_vars.test.ts — unit tests for buildTemplateVars
import { describe, it, expect } from "vitest";
import { buildTemplateVars } from "../../src/orchestrator";

// ── Fixtures ──────────────────────────────────────────────────

const NEWS_FULL = JSON.stringify({
  ticker: "600315",
  date: "2026-06-10",
  lookback_days: 7,
  stock_news: [
    { title: "测试新闻", time: "2026-06-10", source: "cls" },
  ],
  news_layers: { realtime_6h: [], extended_24h: [], history_7d: [] },
  layer_stats: { realtime_6h_count: 0, extended_24h_count: 0, history_7d_count: 1, total_categorized: 1 },
  macro_news: [{ title: "央行降准", time: "2026-06-09", source: "xinhua" }],
});

const NEWS_EMPTY_STOCK = JSON.stringify({
  ticker: "600315",
  date: "2026-06-10",
  lookback_days: 7,
  stock_news: [],
  news_layers: { realtime_6h: [], extended_24h: [], history_7d: [] },
  layer_stats: { realtime_6h_count: 0, extended_24h_count: 0, history_7d_count: 0, total_categorized: 0 },
  // macro_news key intentionally missing
  macro_news_error: "接口超时",
});

const NEWS_NO_MACRO = JSON.stringify({
  ticker: "600315",
  stock_news: [{ title: "新闻" }],
  news_layers: {},
  layer_stats: {},
  // macro_news key missing, no macro_news_error either
});

const NEWS_NO_STOCK = JSON.stringify({
  ticker: "600315",
  macro_news: [{ title: "宏观" }],
  // stock_news, news_layers, layer_stats all missing
  stock_news_error: "接口超时",
});

const SENTIMENT_FULL = JSON.stringify({
  ticker: "600315",
  date: "2026-06-10",
  hot_rank: null,
  zt_pool: { limit_up_count: 56, max_streak: 4 },
  stock_news: [],
  news_sentiment: { score: -0.3, label: "偏悲观" },
});

const SAMPLE_JSON = '{"key":"value"}';

// ── Tests ─────────────────────────────────────────────────────

describe("buildTemplateVars", () => {
  // ── Group 1: Default 1:1 mapping (backward compat) ──

  it("market role: returns {kline: dataJson}", () => {
    const result = buildTemplateVars("market", "kline", SAMPLE_JSON);
    expect(result).toEqual({ kline: SAMPLE_JSON });
  });

  it("fundamentals role: returns {fundamentals: dataJson}", () => {
    const result = buildTemplateVars("fundamentals", "fundamentals", SAMPLE_JSON);
    expect(result).toEqual({ fundamentals: SAMPLE_JSON });
  });

  it("hot_money role: returns {hot_money: dataJson}", () => {
    const result = buildTemplateVars("hot_money", "hot_money", SAMPLE_JSON);
    expect(result).toEqual({ hot_money: SAMPLE_JSON });
  });

  it("lockup role: returns {lockup: dataJson}", () => {
    const result = buildTemplateVars("lockup", "lockup", SAMPLE_JSON);
    expect(result).toEqual({ lockup: SAMPLE_JSON });
  });

  // ── Group 2: News role (split into stock_news + macro_news) ──

  it("news with full data: splits into stock_news and macro_news", () => {
    const result = buildTemplateVars("news", "news", NEWS_FULL);
    expect(result).toHaveProperty("stock_news");
    expect(result).toHaveProperty("macro_news");
    expect(result).not.toHaveProperty("news");

    const stockPart = JSON.parse(result.stock_news);
    expect(stockPart).toHaveProperty("stock_news");
    expect(stockPart).toHaveProperty("news_layers");
    expect(stockPart).toHaveProperty("layer_stats");
    expect(stockPart).not.toHaveProperty("macro_news"); // should not leak
    expect(stockPart).not.toHaveProperty("ticker"); // should not leak metadata

    const macroPart = JSON.parse(result.macro_news);
    expect(macroPart).toHaveProperty("macro_news");
    expect(macroPart).not.toHaveProperty("stock_news");
  });

  it("news with empty stock_news array: stock_news is valid JSON (not sentinel)", () => {
    const result = buildTemplateVars("news", "news", NEWS_EMPTY_STOCK);
    const stockPart = JSON.parse(result.stock_news);
    expect(stockPart.stock_news).toEqual([]);
    // macro_news missing → sentinel
    expect(result.macro_news).toBe("[数据缺失: 宏观新闻]");
  });

  it("news missing macro_news key: returns sentinel", () => {
    const result = buildTemplateVars("news", "news", NEWS_NO_MACRO);
    expect(result.stock_news).toBeTruthy();
    expect(result.macro_news).toBe("[数据缺失: 宏观新闻]");
  });

  it("news missing stock_news key: returns sentinel", () => {
    const result = buildTemplateVars("news", "news", NEWS_NO_STOCK);
    expect(result.stock_news).toBe("[数据缺失: 个股新闻]");
    const macroPart = JSON.parse(result.macro_news);
    expect(macroPart.macro_news).toHaveLength(1);
  });

  // ── Group 3: Policy role (same split logic as news) ──

  it("policy with full data: same split as news", () => {
    const result = buildTemplateVars("policy", "news", NEWS_FULL);
    expect(result).toHaveProperty("stock_news");
    expect(result).toHaveProperty("macro_news");
    expect(result).not.toHaveProperty("news");

    const stockPart = JSON.parse(result.stock_news);
    expect(stockPart).toHaveProperty("stock_news");
    const macroPart = JSON.parse(result.macro_news);
    expect(macroPart).toHaveProperty("macro_news");
  });

  // ── Group 4: Sentiment role ──

  it("sentiment role: maps to sentiment_data (not sentiment)", () => {
    const result = buildTemplateVars("sentiment", "sentiment", SENTIMENT_FULL);
    expect(result).toEqual({ sentiment_data: SENTIMENT_FULL });
    expect(result).not.toHaveProperty("sentiment");
  });

  // ── Group 5: Edge cases ──

  it("sentinel string: falls back to default {dataKey: sentinel}", () => {
    const sentinel = "[数据缺失: ConnectionError]";
    const result = buildTemplateVars("news", "news", sentinel);
    expect(result).toEqual({ news: sentinel });
  });

  it("invalid JSON: falls back to default", () => {
    const result = buildTemplateVars("news", "news", "not json at all");
    expect(result).toEqual({ news: "not json at all" });
  });

  it("empty object for news: both fields get sentinel", () => {
    const result = buildTemplateVars("news", "news", "{}");
    expect(result.stock_news).toBe("[数据缺失: 个股新闻]");
    expect(result.macro_news).toBe("[数据缺失: 宏观新闻]");
  });
});
