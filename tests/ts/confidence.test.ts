// tests/ts/confidence.test.ts — tests for calculateQuickConfidence

import { describe, it, expect } from "vitest";
import { calculateQuickConfidence } from "../../src/orchestrator";
import { AnalystReport } from "../../src/types";

/** Helper to create an analyst report with given content */
function makeReport(role: string, content: string): AnalystReport {
  return {
    role,
    content,
    verdict: { direction: "中性", reason: "test" },
    data_sources_used: [],
  };
}

/** Helper to create quality grades */
function makeGrades(grades: Array<{ role: string; grade: string }>) {
  return { grades, summary_text: "", failed_analysts: [], poor_analysts: [] };
}

describe("calculateQuickConfidence", () => {
  it("should return 0.1 when no reports", () => {
    const result = calculateQuickConfidence([], makeGrades([]));
    expect(result).toBe(0.1);
  });

  it("should return high confidence when all analysts succeed with A/B grades", () => {
    const reports = [
      makeReport("market", "Full analysis content here..."),
      makeReport("fundamentals", "Full analysis content here..."),
      makeReport("news", "Full analysis content here..."),
      makeReport("sentiment", "Full analysis content here..."),
      makeReport("policy", "Full analysis content here..."),
      makeReport("hot_money", "Full analysis content here..."),
      makeReport("lockup", "Full analysis content here..."),
    ];
    const quality = makeGrades([
      { role: "market", grade: "A" },
      { role: "fundamentals", grade: "A" },
      { role: "news", grade: "B" },
      { role: "sentiment", grade: "A" },
      { role: "policy", grade: "B" },
      { role: "hot_money", grade: "A" },
      { role: "lockup", grade: "B" },
    ]);

    const result = calculateQuickConfidence(reports, quality);
    // All succeed (7/7=1.0), all A/B (7/7=1.0) → 0.6*1.0 + 0.4*1.0 = 1.0, capped at 0.85
    expect(result).toBe(0.85);
  });

  it("should return very low confidence when most analysts fail (429 scenario)", () => {
    const reports = [
      makeReport("market", "Full analysis content here..."),  // success
      makeReport("fundamentals", "[分析失败: 429 rate limited]"),
      makeReport("news", "[分析失败: 429 rate limited]"),
      makeReport("sentiment", "[分析失败: 429 rate limited]"),
      makeReport("policy", "[分析失败: 429 rate limited]"),
      makeReport("hot_money", "[分析失败: 429 rate limited]"),
      makeReport("lockup", "[分析失败: 429 rate limited]"),
    ];
    const quality = makeGrades([
      { role: "market", grade: "A" },
      { role: "fundamentals", grade: "F" },
      { role: "news", grade: "F" },
      { role: "sentiment", grade: "F" },
      { role: "policy", grade: "F" },
      { role: "hot_money", grade: "F" },
      { role: "lockup", grade: "F" },
    ]);

    const result = calculateQuickConfidence(reports, quality);
    // 1/7 success = 0.14, 1/7 A/B = 0.14 → 0.6*0.14 + 0.4*0.14 = 0.14
    expect(result).toBe(0.14);
  });

  it("should handle skipped analysts (template errors)", () => {
    const reports = [
      makeReport("market", "Full analysis content here..."),
      makeReport("fundamentals", "Full analysis content here..."),
      makeReport("news", "[分析跳过: 模板占位符未替换]"),
      makeReport("sentiment", "Full analysis content here..."),
      makeReport("policy", "Full analysis content here..."),
      makeReport("hot_money", "Full analysis content here..."),
      makeReport("lockup", "Full analysis content here..."),
    ];
    const quality = makeGrades([
      { role: "market", grade: "A" },
      { role: "fundamentals", grade: "B" },
      { role: "news", grade: "F" },
      { role: "sentiment", grade: "A" },
      { role: "policy", grade: "A" },
      { role: "hot_money", grade: "B" },
      { role: "lockup", grade: "A" },
    ]);

    const result = calculateQuickConfidence(reports, quality);
    // 6/7 success = 0.857, 6/7 A/B = 0.857 → 0.6*0.857 + 0.4*0.857 = 0.857, capped 0.85
    expect(result).toBe(0.85);
  });

  it("should return moderate confidence for partial failures", () => {
    const reports = [
      makeReport("market", "Full analysis content here..."),
      makeReport("fundamentals", "Full analysis content here..."),
      makeReport("news", "Full analysis content here..."),
      makeReport("sentiment", "[分析失败: 429 rate limited]"),
      makeReport("policy", "[分析失败: 429 rate limited]"),
      makeReport("hot_money", "[分析失败: 429 rate limited]"),
      makeReport("lockup", "[分析失败: 429 rate limited]"),
    ];
    const quality = makeGrades([
      { role: "market", grade: "A" },
      { role: "fundamentals", grade: "B" },
      { role: "news", grade: "A" },
      { role: "sentiment", grade: "F" },
      { role: "policy", grade: "F" },
      { role: "hot_money", grade: "F" },
      { role: "lockup", grade: "F" },
    ]);

    const result = calculateQuickConfidence(reports, quality);
    // 3/7 success = 0.428, 3/7 A/B = 0.428 → 0.6*0.428 + 0.4*0.428 = 0.428
    expect(result).toBe(0.43);
  });

  it("should penalize poor quality even when all analysts succeed", () => {
    const reports = [
      makeReport("market", "Full analysis content here..."),
      makeReport("fundamentals", "Full analysis content here..."),
      makeReport("news", "Full analysis content here..."),
      makeReport("sentiment", "Full analysis content here..."),
      makeReport("policy", "Full analysis content here..."),
      makeReport("hot_money", "Full analysis content here..."),
      makeReport("lockup", "Full analysis content here..."),
    ];
    const quality = makeGrades([
      { role: "market", grade: "C" },
      { role: "fundamentals", grade: "D" },
      { role: "news", grade: "C" },
      { role: "sentiment", grade: "D" },
      { role: "policy", grade: "C" },
      { role: "hot_money", grade: "D" },
      { role: "lockup", grade: "C" },
    ]);

    const result = calculateQuickConfidence(reports, quality);
    // 7/7 success = 1.0, 0/7 A/B = 0.0 → 0.6*1.0 + 0.4*0.0 = 0.6
    expect(result).toBe(0.6);
  });
});
