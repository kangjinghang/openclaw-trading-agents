// tests/ts/cross_stage_checks.test.ts

import { describe, it, expect } from "vitest";
import { crossStageChecks } from "../../src/cross-stage-checks";
import { FullAnalysisResult, AnalystReport } from "../../src/types";

/** A healthy Buy run: target above current, stop below, consensus aligned,
 * risk passed cleanly. Must yield ZERO cross-stage issues. */
function baseResult(over: Partial<FullAnalysisResult> = {}): FullAnalysisResult {
  return {
    ticker: "600519",
    date: "2026-06-05",
    mode: "full",
    analysts: [],
    debate: { rounds: [], bull_summary: "", bear_summary: "", total_tokens: 0, total_cost_usd: 0 },
    research_decision: {
      direction: "Buy", confidence: 0.7, bull_score: 70, bear_score: 40,
      reasoning: "", key_debate_points: [], verdict: { direction: "Buy", reason: "" },
    },
    trading_plan: {
      direction: "Buy", target_price: 110, stop_loss: 95, position_pct: 10,
      execution_plan: "分批建仓", entry_signals: [], exit_signals: [],
      invalidations: [], key_risks: [], t_plus_1_note: "",
    },
    risk_debate: { rounds: [], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
    risk_assessment: { status: "pass", reasoning: "", risk_score: 50 },
    final: {
      ticker: "600519", company_name: "T", date: "2026-06-05",
      direction: "Buy", confidence: 0.7, target_price: 110, stop_loss: 95, position_pct: 10,
      reasoning: "", key_risks: [], analyst_verdicts: {}, bull_bear_summary: "",
      risk_assessment: "pass", execution_plan: "分批建仓", next_review_trigger: "",
    },
    ...over,
  };
}

const bear = (role: string): AnalystReport => ({
  role, content: "x",
  verdict: { direction: "看空", reason: "" },
  data_sources_used: [],
});
const bull = (role: string): AnalystReport => ({
  role, content: "x",
  verdict: { direction: "看多", reason: "" },
  data_sources_used: [],
});

describe("crossStageChecks", () => {
  it("returns no issues for a healthy, internally-consistent Buy run", () => {
    const issues = crossStageChecks(baseResult(), 100);
    expect(issues).toEqual([]);
  });

  it("flags a target_price far above the current price (absurd upside)", () => {
    const r = baseResult({
      trading_plan: { ...baseResult().trading_plan, target_price: 250 },
      final: { ...baseResult().final, target_price: 250 },
    });
    const issues = crossStageChecks(r, 100);
    expect(issues.some((i) => i.check === "target_price_band" && i.severity === "warn")).toBe(true);
  });

  it("flags a Buy target_price below the current price (wrong side)", () => {
    const r = baseResult({
      trading_plan: { ...baseResult().trading_plan, target_price: 88 },
      final: { ...baseResult().final, target_price: 88 },
    });
    const issues = crossStageChecks(r, 100);
    expect(issues.some((i) => i.check === "target_price_band")).toBe(true);
  });

  it("flags when conservative risk debater rejected but risk manager passed", () => {
    const r = baseResult({
      risk_debate: {
        rounds: [[]],
        risk_arguments: [
          { role: "aggressive", position: "", evidence: [], verdict: "pass" },
          { role: "conservative", position: "", evidence: [], verdict: "reject" },
          { role: "neutral", position: "", evidence: [], verdict: "pass" },
        ],
        total_tokens: 0, total_cost_usd: 0,
      },
      risk_assessment: { status: "pass", reasoning: "", risk_score: 50 },
    });
    const issues = crossStageChecks(r);
    expect(issues.some((i) => i.check === "conservative_overruled")).toBe(true);
  });

  it("flags when analysts are clearly bearish but research direction is Buy", () => {
    const r = baseResult({
      analysts: [bear("market"), bear("fundamentals"), bear("news"), bear("sentiment"), bull("policy")],
      research_decision: {
        direction: "Buy", confidence: 0.8, bull_score: 75, bear_score: 30,
        reasoning: "", key_debate_points: [], verdict: { direction: "Buy", reason: "" },
      },
    });
    const issues = crossStageChecks(r);
    expect(issues.some((i) => i.check === "consensus_conflict")).toBe(true);
  });

  it("flags retries_exhausted (gave up revising) as a warning", () => {
    const r = baseResult({
      risk_assessment: { status: "revise", reasoning: "", risk_score: 70, retries_exhausted: true },
    });
    const issues = crossStageChecks(r);
    expect(issues.some((i) => i.check === "retries_exhausted")).toBe(true);
  });

  it("flags a Buy stop_loss at or above the current price (wrong side)", () => {
    const r = baseResult({
      trading_plan: { ...baseResult().trading_plan, stop_loss: 100 },
      final: { ...baseResult().final, stop_loss: 100 },
    });
    const issues = crossStageChecks(r, 100);
    expect(issues.some((i) => i.check === "stop_loss_side")).toBe(true);
  });

  it("flags reject with a non-empty execution_plan as an error", () => {
    const r = baseResult({
      risk_assessment: { status: "reject", reasoning: "", risk_score: 90 },
      final: { ...baseResult().final, risk_assessment: "reject", execution_plan: "仍然给出了建仓计划" },
    });
    const issues = crossStageChecks(r);
    const hit = issues.find((i) => i.check === "reject_has_plan");
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe("error");
  });

  it("does NOT flag reject when execution_plan is empty", () => {
    const r = baseResult({
      risk_assessment: { status: "reject", reasoning: "", risk_score: 90 },
      final: { ...baseResult().final, risk_assessment: "reject", execution_plan: "" },
    });
    const issues = crossStageChecks(r);
    expect(issues.some((i) => i.check === "reject_has_plan")).toBe(false);
  });
});
