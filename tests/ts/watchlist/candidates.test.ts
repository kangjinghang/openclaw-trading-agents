import { describe, it, expect } from "vitest";
import { buildCandidates } from "../../../src/watchlist/candidates";
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

  it("today_reasons 保留完整字段(当该股今日还有涨 reason)", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x",
        today_reason_points: [{
          timestamp: 1000, description: "今日涨幅10%", reason: "利好消息推动", url: "https://reason"
        }],
        continued_ranges: [],
        new_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up[0].today_reasons).toEqual([
      { timestamp: 1000, description: "今日涨幅10%", reason: "利好消息推动", url: "https://reason" },
    ]);
  });

  it("today_reasons 为空数组(当该股今日没有涨 reason,只有 range)", () => {
    const diff = makeDiff([
      { ticker: "X", name: "x", today_reason_points: [], continued_ranges: [],
        new_ranges: [{ begin: 100, end: 200, type: "LONG", percent: 50, summary: "", points: "", url: "u", title: "t" }] },
    ]);
    const cands = buildCandidates(diff);
    expect(cands.up[0].today_reasons).toEqual([]);
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
