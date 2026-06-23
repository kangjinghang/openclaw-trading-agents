import { describe, it, expect } from "vitest";
import { aggregateRun, computeRollingStats } from "../../../src/watchlist/data-health-aggregator";
import type { SourceCall } from "../../../src/types";

describe("aggregateRun", () => {
  it("按 stage 聚合成功/失败/耗时", () => {
    const calls: SourceCall[] = [
      { stage: "kline/mootdx", success: true, duration_ms: 100 },
      { stage: "kline/mootdx", success: true, duration_ms: 120 },
      { stage: "kline/mootdx", success: false, error: "timeout", duration_ms: 5000 },
      { stage: "news/stock_em", success: true, duration_ms: 200 },
      { stage: "news/stock_em", success: false, error: "429", duration_ms: 50 },
    ];
    const stats = aggregateRun(calls);
    expect(stats).toHaveLength(2);

    const kline = stats.find(s => s.stage === "kline/mootdx")!;
    expect(kline.success).toBe(2);
    expect(kline.failure).toBe(1);
    expect(kline.total).toBe(3);
    expect(kline.success_rate).toBeCloseTo(2 / 3);
    expect(kline.avg_duration_ms).toBe(Math.round((100 + 120 + 5000) / 3));
    expect(kline.last_error).toBe("timeout");

    const news = stats.find(s => s.stage === "news/stock_em")!;
    expect(news.success).toBe(1);
    expect(news.failure).toBe(1);
    expect(news.last_error).toBe("429");
  });

  it("空 calls 返回空数组", () => {
    expect(aggregateRun([])).toEqual([]);
  });

  it("全成功时 last_error 为空", () => {
    const calls: SourceCall[] = [
      { stage: "kline/mootdx", success: true, duration_ms: 100 },
    ];
    const stats = aggregateRun(calls);
    expect(stats[0].last_error).toBeUndefined();
  });
});

describe("computeRollingStats", () => {
  const mockRuns = [
    { run_date: "2026-06-20", calls: [
      { stage: "kline/mootdx", success: true, duration_ms: 100 },
      { stage: "news/cls", success: false, error: "JSONDecodeError", duration_ms: 200 },
    ]},
    { run_date: "2026-06-21", calls: [
      { stage: "kline/mootdx", success: true, duration_ms: 110 },
      { stage: "news/cls", success: false, error: "JSONDecodeError", duration_ms: 200 },
    ]},
    { run_date: "2026-06-22", calls: [
      { stage: "kline/mootdx", success: true, duration_ms: 105 },
      { stage: "news/cls", success: true, duration_ms: 180 },
    ]},
  ];

  it("7 天窗口内正确聚合", () => {
    const stats = computeRollingStats(mockRuns, 7, "2026-06-22");
    const kline = stats.find(s => s.stage === "kline/mootdx")!;
    expect(kline.success).toBe(3);
    expect(kline.failure).toBe(0);
    expect(kline.success_rate).toBe(1);
    expect(kline.runs_with_data).toBe(3);

    const news = stats.find(s => s.stage === "news/cls")!;
    expect(news.success).toBe(1);
    expect(news.failure).toBe(2);
    expect(news.success_rate).toBeCloseTo(1 / 3);
  });

  it("30 天窗口包含全部 run", () => {
    const stats = computeRollingStats(mockRuns, 30, "2026-06-22");
    expect(stats.find(s => s.stage === "kline/mootdx")!.total).toBe(3);
  });

  it("窗口外的 run 被排除", () => {
    const stats = computeRollingStats(mockRuns, 0, "2026-06-22");
    // 窗口=0 天，只有 2026-06-22 的 run 在窗口内（cutoff = 2026-06-22）
    expect(stats.find(s => s.stage === "kline/mootdx")!.total).toBe(1);
  });

  it("空 runs 返回空数组", () => {
    expect(computeRollingStats([], 7, "2026-06-22")).toEqual([]);
  });
});
