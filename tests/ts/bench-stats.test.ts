// tests/ts/bench-stats.test.ts

import { describe, it, expect } from "vitest";
import {
  percentile, coefficientOfVariation, modeConsistency,
  topKConsistency, summarizeConfigStats, meanAbsScoreDiff,
} from "../../src/watchlist/bench-stats";
import type { BenchCallResult } from "../../src/watchlist/bench-types";

describe("percentile", () => {
  it("returns null for empty array", () => {
    expect(percentile([], 0.9)).toBeNull();
  });

  it("computes median of odd-length array", () => {
    // [1,3,5,7,9] median = 5
    expect(percentile([5, 1, 9, 3, 7], 0.5)).toBe(5);
  });

  it("computes p90 with ceil index", () => {
    // n=10, idx = ceil(0.9*10)-1 = 9-1 = 8 → sorted[8]
    // sorted [10,20,...,100] → sorted[8] = 90
    const arr = [100, 20, 80, 40, 60, 50, 70, 30, 90, 10];
    expect(percentile(arr, 0.9)).toBe(90);
  });

  it("p90 of small array clamps to last", () => {
    // n=2, idx = ceil(0.9*2)-1 = ceil(1.8)-1 = 1 → sorted[1]
    expect(percentile([10, 20], 0.9)).toBe(20);
  });
});

describe("coefficientOfVariation", () => {
  it("returns 0 for identical values", () => {
    expect(coefficientOfVariation([7, 7, 7, 7, 7])).toBe(0);
  });

  it("computes std/abs(mean)", () => {
    // values [4,5,6]: mean=5, std=sqrt(((1+0+1)/3))=sqrt(0.667)=0.816, CV=0.163
    const cv = coefficientOfVariation([4, 5, 6])!;
    expect(cv).toBeCloseTo(0.163, 2);
  });

  it("returns null when mean is 0", () => {
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(coefficientOfVariation([])).toBeNull();
  });
});

describe("modeConsistency", () => {
  it("returns 1 when all values equal", () => {
    expect(modeConsistency(["high", "high", "high"])).toBe(1);
  });

  it("returns proportion of most frequent value", () => {
    // ["high","high","medium","high","low"] → high 出现 3/5 = 0.6
    expect(modeConsistency(["high", "high", "medium", "high", "low"])).toBeCloseTo(0.6, 2);
  });

  it("returns null for empty array", () => {
    expect(modeConsistency([])).toBeNull();
  });
});

describe("topKConsistency", () => {
  it("returns 1 when all lists identical", () => {
    const lists = [["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c"]];
    // 3 pairs, each overlap 3/3 = 1 → avg 1
    expect(topKConsistency(lists, 3)).toBe(1);
  });

  it("computes pairwise top-3 overlap average", () => {
    // lists: [a,b,c] [a,b,d] [a,b,c]
    // pair(0,1): {a,b}=2 → 2/3 ; pair(0,2): 3/3 ; pair(1,2): {a,b}=2 → 2/3
    // avg = (2/3 + 1 + 2/3)/3 = (0.667+1+0.667)/3 = 0.778
    const lists = [["a", "b", "c"], ["a", "b", "d"], ["a", "b", "c"]];
    expect(topKConsistency(lists, 3)).toBeCloseTo(0.778, 2);
  });

  it("returns null for fewer than 2 lists", () => {
    expect(topKConsistency([["a", "b"]], 3)).toBeNull();
  });

  it("handles lists shorter than K", () => {
    // [a,b] vs [a,c]: K=3 but lists len 2 → top = 2, overlap {a}=1 → 1/2
    expect(topKConsistency([["a", "b"], ["a", "c"]], 3)).toBeCloseTo(0.5, 2);
  });
});

describe("meanAbsScoreDiff", () => {
  it("computes mean abs diff vs baseline per ticker", () => {
    const baseline = [
      { ticker: "a", score: 10 },
      { ticker: "b", score: 8 },
      { ticker: "c", score: 6 },
    ];
    const run = [
      { ticker: "a", score: 9 },   // |9-10|=1
      { ticker: "b", score: 7 },   // |7-8|=1
      // c 缺失 → 跳过
    ];
    // mean = (1+1)/2 = 1
    expect(meanAbsScoreDiff(baseline, run)).toBeCloseTo(1, 2);
  });

  it("returns null when no overlap", () => {
    const baseline = [{ ticker: "a", score: 10 }];
    const run = [{ ticker: "b", score: 5 }];
    expect(meanAbsScoreDiff(baseline, run)).toBeNull();
  });
});

function makeCall(overrides: Partial<BenchCallResult> = {}): BenchCallResult {
  return {
    trace_file: "t.json",
    config_id: "cfg",
    repeat: 0,
    ok: true,
    duration_ms: 1000,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    cost_usd: 0.001,
    raw_content: "{}",
    parsed: { _parse_ok: true },
    ...overrides,
  };
}

describe("summarizeConfigStats", () => {
  it("aggregates success rate, percentiles, token medians, cost", () => {
    const calls: BenchCallResult[] = [
      makeCall({ duration_ms: 1000, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, cost_usd: 0.001, parsed: { _parse_ok: true } }),
      makeCall({ duration_ms: 3000, usage: { prompt_tokens: 200, completion_tokens: 70, total_tokens: 270 }, cost_usd: 0.002, parsed: { _parse_ok: true } }),
      makeCall({ ok: false, duration_ms: 5000, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0, parsed: { _parse_ok: false }, error: "429" }),
    ];
    const stats = summarizeConfigStats("cfg", calls, 3);
    expect(stats.config_id).toBe("cfg");
    expect(stats.success_count).toBe(2);
    expect(stats.expected_calls).toBe(3);
    expect(stats.success_rate).toBeCloseTo(2 / 3, 2);
    // successful durations [1000,3000] median = 1000 (ceil(0.5*2)-1=0)
    expect(stats.duration_median_ms).toBe(1000);
    expect(stats.duration_p90_ms).toBe(3000);
    // prompt median of [100,200] = 100
    expect(stats.prompt_tokens_median).toBe(100);
    expect(stats.completion_tokens_median).toBe(50);
    // parse success: 2/2 successful calls both parsed
    expect(stats.parse_success_rate).toBe(1);
    expect(stats.total_cost_usd).toBeCloseTo(0.003, 4);
  });

  it("returns nulls when all calls failed", () => {
    const calls = [makeCall({ ok: false, parsed: { _parse_ok: false }, error: "x" })];
    const stats = summarizeConfigStats("cfg", calls, 1);
    expect(stats.duration_median_ms).toBeNull();
    expect(stats.prompt_tokens_median).toBeNull();
    expect(stats.success_rate).toBe(0);
  });
});
