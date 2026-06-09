// tests/ts/quality-review.test.ts

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock callLLM so runQualityReview is isolated from its retry/sleep logic.
vi.mock("../../src/llm-client", () => ({
  callLLM: vi.fn(),
  parseVerdict: vi.fn(),
}));

import { callLLM } from "../../src/llm-client";
import {
  parseQualityReview,
  formatQualityReview,
  runQualityReview,
} from "../../src/quality-review";
import {
  AnalystReport,
  QualitySummary,
  TradingAgentsConfig,
} from "../../src/types";

const mockedCallLLM = vi.mocked(callLLM);

const mockConfig: TradingAgentsConfig = {
  models: { analyst: "gpt-4o", debater: "gpt-4o", decision: "gpt-4o", risk: "gpt-4o" },
  debate_rounds: 1,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  llm_concurrency: 3,
  report_dir: "/tmp/t",
};

function goodSummary(): QualitySummary {
  return { grades: [], failed_count: 0, warn_count: 0, summary_text: "" };
}

function makeReport(role: string): AnalystReport {
  return {
    role,
    content: `${role} report`,
    verdict: { direction: "看多", reason: "x" },
    data_sources_used: [],
  };
}

describe("parseQualityReview", () => {
  it("parses a valid QUALITY_REVIEW block", () => {
    const c = `review text\n<!-- QUALITY_REVIEW: {"credibility": "中", "note": "部分数据略旧", "stale_reports": ["hot_money"], "fabrication_suspects": []} -->`;
    const r = parseQualityReview(c);
    expect(r).not.toBeNull();
    expect(r!.credibility).toBe("中");
    expect(r!.note).toBe("部分数据略旧");
    expect(r!.stale_reports).toEqual(["hot_money"]);
    expect(r!.fabrication_suspects).toEqual([]);
  });

  it("returns null when no block present", () => {
    expect(parseQualityReview("just prose, no block")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseQualityReview("<!-- QUALITY_REVIEW: {bad json} -->")).toBeNull();
  });

  it("returns null when credibility is not 高/中/低", () => {
    expect(
      parseQualityReview('<!-- QUALITY_REVIEW: {"credibility": "maybe"} -->')
    ).toBeNull();
  });

  it("coerces missing arrays/note to defaults and tolerates partial output", () => {
    const r = parseQualityReview('<!-- QUALITY_REVIEW: {"credibility": "高"} -->');
    expect(r).not.toBeNull();
    expect(r!.credibility).toBe("高");
    expect(r!.stale_reports).toEqual([]);
    expect(r!.fabrication_suspects).toEqual([]);
    expect(r!.note).toBe("");
  });
});

describe("formatQualityReview", () => {
  it("renders credibility + note + flagged roles", () => {
    const text = formatQualityReview({
      credibility: "低",
      note: "存在编造",
      stale_reports: ["news"],
      fabrication_suspects: ["fundamentals"],
    });
    expect(text).toContain("数据可信度");
    expect(text).toContain("低");
    expect(text).toContain("存在编造");
    expect(text).toContain("news");
    expect(text).toContain("fundamentals");
  });

  it("omits the flagged-roles lines when arrays are empty", () => {
    const text = formatQualityReview({
      credibility: "高",
      note: "ok",
      stale_reports: [],
      fabrication_suspects: [],
    });
    expect(text).not.toContain("时效存疑");
    expect(text).not.toContain("数值可疑");
  });
});

describe("runQualityReview", () => {
  beforeEach(() => {
    mockedCallLLM.mockReset();
  });

  it("skips the LLM call when ≥4 reports hard-failed Layer 1", async () => {
    const quality = { ...goodSummary(), failed_count: 4 };
    const r = await runQualityReview(
      [makeReport("market")],
      quality,
      "600519",
      "2026-06-09",
      mockConfig,
      {} as any,
      { record: vi.fn(), count: 0 } as any
    );
    expect(r).toBeNull();
    expect(mockedCallLLM).not.toHaveBeenCalled();
  });

  it("returns parsed review when callLLM emits a valid block", async () => {
    mockedCallLLM.mockResolvedValue({
      content: `复核通过\n<!-- QUALITY_REVIEW: {"credibility": "高", "note": "数据新近可信", "stale_reports": [], "fabrication_suspects": []} -->`,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      costUsd: 0,
    } as any);

    const r = await runQualityReview(
      [makeReport("market")],
      goodSummary(),
      "600519",
      "2026-06-09",
      mockConfig,
      {} as any,
      { record: vi.fn(), count: 0 } as any
    );

    expect(r).not.toBeNull();
    expect(r!.credibility).toBe("高");
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    // uses the cheap analyst tier and a dedicated phase
    const callOpts = mockedCallLLM.mock.calls[0][1] as any;
    expect(callOpts.model).toBe("gpt-4o");
    expect(callOpts.phase).toBe("quality_review");
  });

  it("gracefully degrades to null when no QUALITY_REVIEW block", async () => {
    mockedCallLLM.mockResolvedValue({
      content: "no structured block here",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      costUsd: 0,
    } as any);

    const r = await runQualityReview(
      [makeReport("market")],
      goodSummary(),
      "600519",
      "2026-06-09",
      mockConfig,
      {} as any,
      { record: vi.fn(), count: 0 } as any
    );
    expect(r).toBeNull();
  });

  it("gracefully degrades to null when callLLM throws", async () => {
    mockedCallLLM.mockRejectedValue(new Error("boom"));

    const r = await runQualityReview(
      [makeReport("market")],
      goodSummary(),
      "600519",
      "2026-06-09",
      mockConfig,
      {} as any,
      { record: vi.fn(), count: 0 } as any
    );
    expect(r).toBeNull();
  });
});
