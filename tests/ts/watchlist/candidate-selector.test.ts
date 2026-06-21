import { describe, it, expect } from "vitest";
import { selectCandidates } from "../../../src/watchlist/candidate-selector";
import type { Holdings, Position } from "../../../src/watchlist/rebalance-types";
import type { ScanSummary } from "../../../src/watchlist/types";

function makePosition(over: Partial<Position> = {}): Position {
  return { ticker: "SH600519", name: "贵州茅台", weight: 0.1, entry_price: 100, entry_date: "2026-06-01", shares: 100, sector: "白酒", ...over };
}

function makeScan(topPicks: Array<{ ticker: string; name: string; score: number; group: "LONG" | "SHORT"; percent: number; days: number; range_kind: "continued" | "new"; reason: string }> = []): ScanSummary {
  return {
    scan_date: "2026-06-21",
    total_candidates: 178,
    groups: { LONG: { total: 35, ranked: 7, excluded: 5, fallback: false }, SHORT: { total: 44, pre_filter: 138, post_common_filter: 110, ranked: 8, excluded: 5, fallback: false } },
    top_picks: topPicks,
  };
}

describe("selectCandidates", () => {
  it("合并 ranker top-N + 持仓，按 ticker 去重", () => {
    const scan = makeScan([
      { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "..." },
      { ticker: "SH600183", name: "生益科技", score: 9.2, group: "LONG", percent: 258, days: 77, range_kind: "continued", reason: "..." },
    ]);
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.85,
      positions: [
        makePosition({ ticker: "SH600519", name: "贵州茅台", sector: "白酒" }),
        makePosition({ ticker: "SZ300319", name: "麦捷科技", entry_date: "2026-06-15", sector: "电子" }),
      ],
    };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    const tickers = result.map(c => c.ticker);
    expect(tickers).toEqual(expect.arrayContaining(["SZ300319", "SH600183", "SH600519"]));
    expect(tickers.filter(t => t === "SZ300319")).toHaveLength(1);
  });

  it("ranker top-N 截取前 N 支", () => {
    const picks = Array.from({ length: 15 }, (_, i) => ({
      ticker: `SZ30000${i}`, name: `s${i}`, score: 9 - i * 0.1, group: "LONG" as const,
      percent: 50, days: 30, range_kind: "continued" as const, reason: "r",
    }));
    const scan = makeScan(picks);
    const holdings: Holdings = { updated_at: "x", cash_pct: 1.0, positions: [] };
    const result = selectCandidates(scan, holdings, { topN: 5, currentDate: "2026-06-21", antiChurnDays: 7 });
    expect(result).toHaveLength(5);
    expect(result[0].ticker).toBe("SZ300000");
  });

  it("持仓标 is_held=true + current_weight + days_held", () => {
    const scan = makeScan([]);
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [makePosition({ ticker: "SH600519", name: "贵州茅台", weight: 0.20, entry_date: "2026-06-01", sector: "白酒" })],
    };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    const held = result.find(c => c.ticker === "SH600519")!;
    expect(held.is_held).toBe(true);
    expect(held.current_weight).toBe(0.20);
    expect(held.days_held).toBe(20);
    expect(held.locked).toBe(false);
  });

  it("持仓 entry_date 在 7 天内 → locked=true", () => {
    const scan = makeScan([]);
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [makePosition({ ticker: "SZ300319", entry_date: "2026-06-18", sector: "电子" })],
    };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    expect(result[0].locked).toBe(true);
  });

  it("候选股（非持仓）is_held=false + current_weight=0 + locked=false", () => {
    const scan = makeScan([
      { ticker: "SH600183", name: "生益科技", score: 9.2, group: "LONG", percent: 258, days: 77, range_kind: "continued", reason: "r" },
    ]);
    const holdings: Holdings = { updated_at: "x", cash_pct: 1.0, positions: [] };
    const result = selectCandidates(scan, holdings, { topN: 10, currentDate: "2026-06-21", antiChurnDays: 7 });
    expect(result[0]).toMatchObject({ is_held: false, current_weight: 0, locked: false, days_held: 0 });
    expect(result[0].ranker_score).toBe(9.2);
  });
});
