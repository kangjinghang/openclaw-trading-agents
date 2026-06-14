// tests/ts/confidence.test.ts — tests for calculateQuickConfidence

import { describe, it, expect } from "vitest";
import { calculateQuickConfidence } from "../../src/orchestrator";
import { AnalystReport, QualityReview } from "../../src/types";

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

describe("calculateQuickConfidence with Layer-2 QualityReview", () => {
  // Reusable high-quality setup: 7 successful analysts, 5 A/B grades
  // → raw = 0.6*1.0 + 0.4*(5/7) = 0.886 → default cap 0.85
  const allReports = [
    "market", "fundamentals", "news", "sentiment", "policy", "hot_money", "lockup",
  ].map(r => makeReport(r, "Full analysis content here..."));

  const highQuality = makeGrades([
    { role: "market", grade: "A" },
    { role: "fundamentals", grade: "A" },
    { role: "news", grade: "B" },
    { role: "sentiment", grade: "A" },
    { role: "policy", grade: "B" },
    { role: "hot_money", grade: "A" },
    { role: "lockup", grade: "C" },  // 5/7 A/B
  ]);

  /** Helper to construct a QualityReview with optional overrides */
  function makeLayer2(overrides: Partial<QualityReview> = {}): QualityReview {
    return {
      credibility: "高",
      note: "",
      stale_reports: [],
      fabrication_suspects: [],
      ...overrides,
    };
  }

  it("caps at 0.5 when Layer-2 credibility is 中", () => {
    const layer2 = makeLayer2({ credibility: "中" });
    expect(calculateQuickConfidence(allReports, highQuality, layer2)).toBe(0.5);
  });

  it("caps at 0.3 when Layer-2 credibility is 低", () => {
    const layer2 = makeLayer2({ credibility: "低" });
    expect(calculateQuickConfidence(allReports, highQuality, layer2)).toBe(0.3);
  });

  it("caps at 0.5 when fabrication_suspects is non-empty (even if credibility is 高)", () => {
    const layer2 = makeLayer2({
      credibility: "高",
      fabrication_suspects: ["market"],
    });
    expect(calculateQuickConfidence(allReports, highQuality, layer2)).toBe(0.5);
  });

  it("keeps default 0.85 cap when Layer-2 is 高 and no fabrication_suspects", () => {
    const layer2 = makeLayer2({ credibility: "高" });
    expect(calculateQuickConfidence(allReports, highQuality, layer2)).toBe(0.85);
  });

  it("does not cap when Layer-2 is null (backward compat)", () => {
    expect(calculateQuickConfidence(allReports, highQuality, null)).toBe(0.85);
  });

  it("does not cap when Layer-2 is undefined (backward compat)", () => {
    expect(calculateQuickConfidence(allReports, highQuality, undefined)).toBe(0.85);
  });

  it("uses the smaller of raw and layer2-cap when raw is below the cap", () => {
    // 3/7 success, 3/7 A/B → raw = 0.428
    const partialReports = [
      makeReport("market", "Full analysis content here..."),
      makeReport("fundamentals", "Full analysis content here..."),
      makeReport("news", "Full analysis content here..."),
      makeReport("sentiment", "[分析失败: 429 rate limited]"),
      makeReport("policy", "[分析失败: 429 rate limited]"),
      makeReport("hot_money", "[分析失败: 429 rate limited]"),
      makeReport("lockup", "[分析失败: 429 rate limited]"),
    ];
    const partialQuality = makeGrades([
      { role: "market", grade: "A" },
      { role: "fundamentals", grade: "B" },
      { role: "news", grade: "A" },
      { role: "sentiment", grade: "F" },
      { role: "policy", grade: "F" },
      { role: "hot_money", grade: "F" },
      { role: "lockup", grade: "F" },
    ]);
    const layer2 = makeLayer2({ credibility: "中" });
    // raw 0.428 < cap 0.5 → result is 0.43
    expect(calculateQuickConfidence(partialReports, partialQuality, layer2)).toBe(0.43);
  });

  it("combines credibility=低 + fabrication_suspects: cap is 0.3 (the stricter)", () => {
    const layer2 = makeLayer2({
      credibility: "低",
      fabrication_suspects: ["market", "fundamentals"],
    });
    expect(calculateQuickConfidence(allReports, highQuality, layer2)).toBe(0.3);
  });
});
