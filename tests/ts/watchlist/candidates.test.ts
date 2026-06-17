import { describe, it, expect } from "vitest";
import { buildCandidates } from "../../../src/watchlist/candidates";
import type { DiffFile, RawSnapshotFile } from "../../../src/watchlist/types";

function makeDiff(changes: any[]): DiffFile {
  return { scan_date: "2026-06-17", baseline: "2026-06-16", changes };
}

/** 造一个 rawToday，只有指定 ticker 的 range_reason_list。
 * end_date=2026-06-17 → scanEndMs ≈ 1.78e12；end=9.99e12 视为进行中。 */
function makeRaw(stocks: Record<string, { range_reason_list?: any[] }>): RawSnapshotFile {
  return {
    scan_date: "2026-06-17",
    begin_ms: 0, end_ms: 1781193599000, begin_date: "2025-04-17", end_date: "2026-06-17",
    window_months: 14, scanned: 0, succeeded: 0, failed: 0,
    stocks,
  } as any as RawSnapshotFile;
}

describe("buildCandidates (up/down split)", () => {
  it("splits up and down by percent sign", () => {
    const diff = makeDiff([
      { ticker: "UP1", name: "up-stock", new_reason_points: [], new_range_trends: [
        { begin: 100, end: 200, type: "LONG", percent: 756, summary: "", points: "" },
      ]},
      { ticker: "DOWN1", name: "down-stock", new_reason_points: [], new_range_trends: [
        { begin: 100, end: 200, type: "LONG", percent: -78, summary: "", points: "" },
      ]},
    ]);
    const cands = buildCandidates(diff, makeRaw({
      "UP1": { range_reason_list: [{ begin: 100, end: 200, type: "LONG", percent: 756, summary: "", points: "" }] },
      "DOWN1": { range_reason_list: [{ begin: 100, end: 200, type: "LONG", percent: -78, summary: "", points: "" }] },
    }));
    expect(cands.up.map((c) => c.ticker)).toEqual(["UP1"]);
    expect(cands.down.map((c) => c.ticker)).toEqual(["DOWN1"]);
  });

  it("sorts up group by ongoing > days > |percent|", () => {
    // A: 进行中 +50% ; B: 已结束 30d +500% ; C: 已结束 5d +500%
    // 预期: A(进行中) > B(30d) > C(5d) —— 注意 B、C 幅度相同，比天数
    const diff = makeDiff([
      { ticker: "A", name: "a", new_reason_points: [], new_range_trends: [{ begin: 1, end: 9999999999999, type: "LONG", percent: 50, summary: "", points: "" }] },
      { ticker: "B", name: "b", new_reason_points: [], new_range_trends: [{ begin: 1, end: 1 + 30 * 86400000, type: "LONG", percent: 500, summary: "", points: "" }] },
      { ticker: "C", name: "c", new_reason_points: [], new_range_trends: [{ begin: 1, end: 1 + 5 * 86400000, type: "SHORT", percent: 500, summary: "", points: "" }] },
    ]);
    const cands = buildCandidates(diff, makeRaw({
      "A": { range_reason_list: [{ begin: 1, end: 9999999999999, type: "LONG", percent: 50, summary: "", points: "" }] },
      "B": { range_reason_list: [{ begin: 1, end: 1 + 30 * 86400000, type: "LONG", percent: 500, summary: "", points: "" }] },
      "C": { range_reason_list: [{ begin: 1, end: 1 + 5 * 86400000, type: "SHORT", percent: 500, summary: "", points: "" }] },
    }));
    expect(cands.up.map((c) => c.ticker)).toEqual(["A", "B", "C"]);
  });

  it("picks top_trend as the strongest range (ongoing > days > |pct|)", () => {
    // 进行中的小涨幅 vs 已结束的大涨幅 → top_trend 选进行中的
    const diff = makeDiff([
      { ticker: "X", name: "x", new_reason_points: [], new_range_trends: [] },
    ]);
    const cands = buildCandidates(diff, makeRaw({
      "X": { range_reason_list: [
        { begin: 1, end: 2, type: "LONG", percent: 500, summary: "ended-big", points: "" },
        { begin: 1, end: 9999999999999, type: "SHORT", percent: 10, summary: "ongoing-small", points: "" },
      ]},
    }));
    expect(cands.up[0].top_trend?.percent).toBe(10);
    expect(cands.up[0].top_trend?.ongoing).toBe(true);
  });

  it("counts new_today from diff changes", () => {
    const diff = makeDiff([
      { ticker: "A", name: "a",
        new_reason_points: [{ timestamp: 1 }, { timestamp: 2 }] as any,
        new_range_trends: [{ begin: 1, end: 2 }] as any },
    ]);
    const cands = buildCandidates(diff, makeRaw({ "A": { range_reason_list: [{ begin: 1, end: 2, type: "LONG", percent: 10, summary: "", points: "" }] } }));
    expect(cands.up[0].new_today).toEqual({ reasons: 2, ranges: 1 });
  });

  it("routes stock to neutral when no ranges (only reason points)", () => {
    const diff = makeDiff([
      { ticker: "N", name: "n", new_reason_points: [{ timestamp: 1 }] as any, new_range_trends: [] },
    ]);
    const cands = buildCandidates(diff, makeRaw({ "N": {} }));
    expect(cands.neutral).toHaveLength(1);
    expect(cands.neutral[0].top_trend).toBeNull();
    expect(cands.up).toHaveLength(0);
    expect(cands.down).toHaveLength(0);
  });

  it("does NOT prioritize LONG over SHORT in selection (type is window length, not direction)", () => {
    // 回归测试：修正前 typeRank 让 LONG>SHORT，埋没了 SHORT 大涨。
    // 现在 SHORT +90% 的进行中趋势应被选为 top_trend，而非 LONG 的已结束小趋势。
    const diff = makeDiff([{ ticker: "S", name: "s", new_reason_points: [], new_range_trends: [] }]);
    const cands = buildCandidates(diff, makeRaw({
      "S": { range_reason_list: [
        { begin: 1, end: 9999999999999, type: "SHORT", percent: 90, summary: "ongoing-short-up", points: "" },
        { begin: 1, end: 2, type: "LONG", percent: 5, summary: "ended-long-tiny", points: "" },
      ]},
    }));
    expect(cands.up[0].top_trend?.type).toBe("SHORT");
    expect(cands.up[0].top_trend?.percent).toBe(90);
  });
});
