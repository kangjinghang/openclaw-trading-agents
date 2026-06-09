/**
 * Tests for generateDataQuality in src/orchestrator.ts.
 *
 * Focus on the market-role completeness additions: K-line row-count floor and
 * date-freshness check. The freshness check is gated by isRecentDate(--date)
 * so backtesting never trips it; the row-count floor is unconditional.
 *
 * Dates are built relative to the system clock (iso(offset)) so the suite is
 * stable on any day in CI.
 */

import { describe, it, expect } from "vitest";
import { generateDataQuality } from "../../src/orchestrator";
import type { ScriptResult } from "../../src/types";

/** "YYYY-MM-DD" for today ± offsetDays. */
function iso(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Build a market ScriptResult. `count` drives the row-count check; the single
 *  array element carries `latestDate` for the freshness check. */
function marketResult(count: number, latestDate: string): ScriptResult {
  return {
    success: true,
    data: {
      ticker: "600519",
      count,
      data: [{ date: latestDate, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    },
  };
}

describe("generateDataQuality — failure / generic", () => {
  it("flags a failed script result", () => {
    const r = generateDataQuality("market", iso(0), { success: false, error: "boom" });
    expect(r).toContain("数据缺失");
    expect(r).toContain("不得推测或编造");
  });

  it("flags *_error partial-missing fields", () => {
    const r = generateDataQuality("news", iso(0), {
      success: true,
      data: { ticker: "600519", date: iso(0), stock_news: [], macro_news_error: "timeout" },
    });
    expect(r).toContain("部分数据缺失");
    expect(r).toContain("macro_news");
  });

  it("warns when fewer than 3 top-level fields", () => {
    const r = generateDataQuality("news", iso(0), {
      success: true,
      data: { ticker: "600519" },
    });
    expect(r).toContain("数据字段较少");
  });

  it("returns 完整 for a normal non-market result", () => {
    const r = generateDataQuality("news", iso(0), {
      success: true,
      data: { ticker: "600519", date: iso(0), stock_news: [{ title: "x" }] },
    });
    expect(r).toContain("数据完整");
  });
});

describe("generateDataQuality — market row-count floor", () => {
  it("flags K-line under the bar floor (technical indicators need ≥50)", () => {
    const r = generateDataQuality("market", iso(0), marketResult(20, iso(0)));
    expect(r).toContain("K线仅 20 根");
    expect(r).toContain("置信度应显著降低");
  });

  it("accepts K-line at/above the bar floor", () => {
    const r = generateDataQuality("market", iso(0), marketResult(120, iso(0)));
    expect(r).toContain("数据完整");
  });

  it("row-count floor fires even for backtest dates (unconditional)", () => {
    const r = generateDataQuality("market", iso(-365), marketResult(20, iso(-365)));
    expect(r).toContain("K线仅 20 根");
  });
});

describe("generateDataQuality — market date freshness", () => {
  it("flags stale bar within the recent window", () => {
    // --date is today, latest bar is 30 days ago → stale
    const r = generateDataQuality("market", iso(0), marketResult(120, iso(-30)));
    expect(r).toContain("可能过期");
    expect(r).toContain(iso(-30));
  });

  it("tolerates a weekend-sized gap (<= 7 days)", () => {
    // --date today, latest bar 3 days ago → within tolerance, not flagged
    const r = generateDataQuality("market", iso(0), marketResult(120, iso(-3)));
    expect(r).toContain("数据完整");
  });

  it("skips freshness for backtest dates even if bar is 'stale'", () => {
    // --date a year ago → not a recent analysis → freshness check skipped
    const r = generateDataQuality("market", iso(-365), marketResult(120, iso(-365)));
    expect(r).not.toContain("过期");
    expect(r).toContain("数据完整");
  });

  it("does not double-report: stale bar AND low count surface together", () => {
    const r = generateDataQuality("market", iso(0), marketResult(20, iso(-30)));
    expect(r).toContain("K线仅 20 根");
    expect(r).toContain("可能过期");
  });
});
