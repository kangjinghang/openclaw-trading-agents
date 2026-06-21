import { describe, it, expect } from "vitest";
import { formatRebalancerPrompt, parseRebalancePlan } from "../../../src/watchlist/rebalancer";
import type { StockReport, Holdings, LastRebalance, RebalanceConstraints } from "../../../src/watchlist/rebalance-types";

const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10 };

function makeReport(over: Partial<StockReport> = {}): StockReport {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    thesis: "x", fitness_score: 8, key_signals: [], data_gaps: [],
    risk_flags: [], overall_risk: "low", deal_breaker: false,
    is_held: false, current_weight: 0, days_held: 0, locked: false,
    ...over,
  };
}

describe("formatRebalancerPrompt", () => {
  it("包含约束 + 持仓 + reports", () => {
    const reports = [makeReport({ ticker: "SZ300319" })];
    const holdings: Holdings = { updated_at: "x", cash_pct: 0.15, positions: [] };
    const prompt = formatRebalancerPrompt(reports, holdings, null, C, 7);
    expect(prompt).toContain("0.15");
    expect(prompt).toContain("0.3");  // JS number formatting strips trailing zero
    expect(prompt).toContain("SZ300319 麦捷科技");
    expect(prompt).toContain('"cash_pct": 0.15');  // JSON format includes quotes
  });

  it("包含 last_rebalance（防反向）", () => {
    const last: LastRebalance = {
      date: "2026-06-14",
      actions: [{ action: "SELL", ticker: "SH600519", weight: 0.10 }],
    };
    const prompt = formatRebalancerPrompt([], { updated_at: "x", cash_pct: 1, positions: [] }, last, C, 7);
    expect(prompt).toContain("SH600519");
    expect(prompt).toContain("SELL");
  });
});

describe("parseRebalancePlan", () => {
  it("解析完整 JSON（含 evaluations + actions + portfolio_after）", () => {
    const validTickers = new Set(["SZ300319", "SH600519"]);
    const content = JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "好" }],
      actions: [
        { action: "BUY", ticker: "SZ300319", name: "麦捷科技", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "x", priority: 3 },
      ],
      portfolio_after: { positions: [{ ticker: "SZ300319", weight: 0.10 }], cash_pct: 0.90 },
      summary: "x",
    });
    const plan = parseRebalancePlan(content, validTickers);
    expect(plan).not.toBeNull();
    expect(plan!.actions).toHaveLength(1);
    expect(plan!.actions[0]).toMatchObject({ action: "BUY", ticker: "SZ300319", priority: 3 });
    expect(plan!.portfolio_after.cash_pct).toBe(0.90);
  });

  it("过滤幻觉 ticker", () => {
    const valid = new Set(["A"]);
    const content = JSON.stringify({
      evaluations: [],
      actions: [
        { action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 },
        { action: "BUY", ticker: "FAKE", name: "fake", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 },
      ],
      portfolio_after: { positions: [], cash_pct: 0.80 },
      summary: "x",
    });
    const plan = parseRebalancePlan(content, valid)!;
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].ticker).toBe("A");
  });

  it("非 JSON 返回 null", () => {
    expect(parseRebalancePlan("not json", new Set())).toBeNull();
  });
});
