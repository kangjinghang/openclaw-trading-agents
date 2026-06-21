import { describe, it, expect } from "vitest";
import { buildCandidates, buildDailyCandidates } from "../../../src/watchlist/candidates";
import type { DiffFile } from "../../../src/watchlist/types";

function makeDiff(changes: any[]): DiffFile {
  return { scan_date: "2026-06-17", baseline: "2026-06-16", changes };
}

describe("buildCandidates (rich schema, only range stocks, neutral dropped)", () => {
  it("derived 只收有 range 的股(B1 或 B2),无 range 的(A only)直接丢", () => {
    const diff = makeDiff([
      // 有 range(B2 新成型)
      { ticker: "X", name: "x", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 50, summary: "s", points: "p", url: "u", title: "t" }] },
      // 无 range(只有 A 类)
      { ticker: "N", name: "n",
        today_reason_points: [{ timestamp: 1, description: "今日涨幅5%", reason: "r", url: "u" }],
        continued_ranges: [], new_ranges: [] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up.map((c) => c.ticker)).toEqual(["X"]);
    expect(cands).not.toHaveProperty("neutral");
  });

  it("range 字段保留雪球全部 8 字段(begin/end/type/percent/summary/points/url/title)", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 50,
          summary: "区间总结", points: "驱动因素", url: "https://xq", title: "上涨原因分析" }] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up[0].range).toEqual({
      begin: 100, end: 200, type: "LONG", percent: 50,
      summary: "区间总结", points: "驱动因素", url: "https://xq", title: "上涨原因分析",
    });
  });

  it("range_kind 标注 B1=continued / B2=new", () => {
    const diff = makeDiff([
      { ticker: "B1", name: "x", today_reason_points: [],
        continued_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 10, summary: "", points: "", url: "u", title: "t" }],
        new_ranges: [] },
      { ticker: "B2", name: "y", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 300, end: 400, type: "LONG", percent: 20, summary: "", points: "", url: "u", title: "t" }] },
    ]);
    const cands = buildCandidates(diff);
    const b1 = cands.up.find((c) => c.ticker === "B1")!;
    const b2 = cands.up.find((c) => c.ticker === "B2")!;
    expect(b1.range_kind).toBe("continued");
    expect(b2.range_kind).toBe("new");
  });

  it("days 是 range 跨度天数", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 1, end: 1 + 30 * DAY, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up[0].days).toBe(30);
  });

  it("range_events 从 diff.range_events 透传，保留完整字段", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x",
        today_reason_points: [],
        continued_ranges: [],
        new_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }],
        range_events: [
          { timestamp: 100, description: "区间启动日 +5%", reason: "订单落地", url: "https://r1" },
          { timestamp: 200, description: "区间末日 +10%", reason: "业绩兑现", url: "https://r2" },
        ] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up[0].range_events).toEqual([
      { timestamp: 100, description: "区间启动日 +5%", reason: "订单落地", url: "https://r1" },
      { timestamp: 200, description: "区间末日 +10%", reason: "业绩兑现", url: "https://r2" },
    ]);
  });

  it("range_events 为空数组（diff.range_events 为空）", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }],
        range_events: [] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up[0].range_events).toEqual([]);
  });

  it("sorts up by days 大 > |percent| 大", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const diff = makeDiff([
      // A: 30d +50%
      { ticker: "A", name: "a", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 1, end: 1 + 30 * DAY, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }] },
      // B: 5d +500%
      { ticker: "B", name: "b", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 1, end: 1 + 5 * DAY, type: "SHORT", percent: 500, summary: "", points: "", url: "u", title: "t" }] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up.map((c) => c.ticker)).toEqual(["A", "B"]);
  });

  it("schema 不再有 down / neutral / top_trend / new_today 字段", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 1, end: 2, type: "LONG", percent: 10, summary: "", points: "", url: "u", title: "t" }] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands).not.toHaveProperty("down");
    expect(cands).not.toHaveProperty("neutral");
    expect(cands.up[0]).not.toHaveProperty("top_trend");
    expect(cands.up[0]).not.toHaveProperty("new_today");
  });
});

describe("buildDailyCandidates (单日异动榜，今日上涨)", () => {
  it("只收 today_reason_points 非空的股（无今日涨 reason 的丢弃）", () => {
    const diff = makeDiff([
      { ticker: "UP", name: "u", today_reason_points: [{ timestamp: 1, description: "今日涨幅5%", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
      { ticker: "NONE", name: "n", today_reason_points: [], continued_ranges: [{ begin: 1, end: 2, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }], new_ranges: [] },
    ]);
    const daily = buildDailyCandidates(diff);
    expect(daily.up.map((c) => c.ticker)).toEqual(["UP"]);
  });

  it("pct 从 description 提取'涨幅X%'", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [{ timestamp: 1, description: "今日涨幅10.5%", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).up[0].pct).toBe(10.5);
  });

  it("涨停算 10（description 含'涨停'但无数值）", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [{ timestamp: 1, description: "放量涨停封板", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).up[0].pct).toBe(10);
  });

  it("pct 提取不出为 null", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [{ timestamp: 1, description: "无涨幅数字的描述", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).up[0].pct).toBeNull();
  });

  it("多条 reason 取最大 pct", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [
        { timestamp: 1, description: "涨幅3%", reason: "r", url: "u" },
        { timestamp: 2, description: "涨幅8%", reason: "r", url: "u" },
      ], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).up[0].pct).toBe(8);
  });

  it("排序：pct 降序，null 排后", () => {
    const diff = makeDiff([
      { ticker: "LOW", name: "l", today_reason_points: [{ timestamp: 1, description: "涨幅3%", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
      { ticker: "HIGH", name: "h", today_reason_points: [{ timestamp: 1, description: "涨幅9%", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
      { ticker: "NULL", name: "n", today_reason_points: [{ timestamp: 1, description: "无数值", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).up.map((c) => c.ticker)).toEqual(["HIGH", "LOW", "NULL"]);
  });

  it("today_reasons 完整保留（可能多条）", () => {
    const reason = { timestamp: 1000, description: "今日涨幅10%", reason: "利好", url: "https://r" };
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [reason], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).up[0].today_reasons).toEqual([reason]);
  });

  it("scan_date 跟随 diff", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [{ timestamp: 1, description: "涨幅5%", reason: "r", url: "u" }], continued_ranges: [], new_ranges: [] },
    ]);
    expect(buildDailyCandidates(diff).scan_date).toBe("2026-06-17");
  });
});
