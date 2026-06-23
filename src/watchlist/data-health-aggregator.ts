// src/watchlist/data-health-aggregator.ts
//
// 数据源健康统计：收集单次 run 的子源调用记录，聚合历史数据，计算 7天/30天 滚动成功率。
// 输出供 plan.md 渲染的 DataHealthReport。

import * as fs from "fs";
import * as path from "path";
import type { SourceCall } from "../types";

// ── 单次 run 的子源统计 ────────────────────────────────────────────────────

export interface SourceStat {
  stage: string;
  success: number;
  failure: number;
  total: number;
  success_rate: number;       // 0-1
  avg_duration_ms: number;
  last_error?: string;        // 最近一次失败原因
}

// ── 跨 run 聚合统计 ────────────────────────────────────────────────────────

export interface RollingStat {
  stage: string;
  success: number;
  failure: number;
  total: number;
  success_rate: number;
  avg_duration_ms: number;
  last_error?: string;
  last_success_at?: string;   // 最近成功时间
  last_failure_at?: string;   // 最近失败时间
  runs_with_data: number;     // 有数据的 run 数
}

// ── 完整的 DataHealthReport ─────────────────────────────────────────────────

export interface DataHealthReport {
  run_date: string;
  /** 本次 run 各子源的调用统计 */
  current_run: SourceStat[];
  /** 7 天滚动统计（含本次） */
  rolling_7d: RollingStat[];
  /** 30 天滚动统计（含本次） */
  rolling_30d: RollingStat[];
}

// ── 单次 run 聚合 ──────────────────────────────────────────────────────────

/** 把一个 run 的所有 SourceCall[] 聚合为 per-stage 统计。 */
export function aggregateRun(calls: SourceCall[]): SourceStat[] {
  const byStage = new Map<string, { successes: number; failures: number; durations: number[]; lastError?: string }>();

  for (const c of calls) {
    let entry = byStage.get(c.stage);
    if (!entry) {
      entry = { successes: 0, failures: 0, durations: [] };
      byStage.set(c.stage, entry);
    }
    if (c.success) {
      entry.successes++;
    } else {
      entry.failures++;
      if (c.error) entry.lastError = c.error;
    }
    if (c.duration_ms != null) entry.durations.push(c.duration_ms);
  }

  const stats: SourceStat[] = [];
  for (const [stage, entry] of byStage) {
    const total = entry.successes + entry.failures;
    stats.push({
      stage,
      success: entry.successes,
      failure: entry.failures,
      total,
      success_rate: total > 0 ? entry.successes / total : 0,
      avg_duration_ms: entry.durations.length > 0
        ? Math.round(entry.durations.reduce((s, d) => s + d, 0) / entry.durations.length)
        : 0,
      last_error: entry.lastError,
    });
  }
  return stats.sort((a, b) => a.stage.localeCompare(b.stage));
}

// ── 历史文件读取 ────────────────────────────────────────────────────────────

interface StoredRun {
  run_date: string;
  calls: Array<{ stage: string; success: boolean; error?: string | null; duration_ms?: number | null }>;
}

/** 读取 rebalanceDir 下所有 data-health.json 文件。 */
function readHistoricalRuns(rebalanceDir: string): StoredRun[] {
  const runs: StoredRun[] = [];
  // rebalanceDir 是当天的目录，需要往上一级找历史 run
  const watchlistDir = path.dirname(rebalanceDir);
  if (!fs.existsSync(watchlistDir)) return runs;

  const entries = fs.readdirSync(watchlistDir);
  for (const entry of entries) {
    const subDir = path.join(watchlistDir, entry);
    if (!fs.statSync(subDir).isDirectory()) continue;
    const healthFile = path.join(subDir, "data-health.json");
    if (!fs.existsSync(healthFile)) continue;
    try {
      const content = fs.readFileSync(healthFile, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed.run_date && Array.isArray(parsed.calls)) {
        runs.push(parsed);
      }
    } catch {
      // 跳过损坏的文件
    }
  }
  return runs.sort((a, b) => a.run_date.localeCompare(b.run_date));
}

// ── 跨 run 滚动统计 ────────────────────────────────────────────────────────

/** 计算指定天数窗口内的滚动统计。 */
export function computeRollingStats(
  runs: StoredRun[],
  windowDays: number,
  currentDate: string,
): RollingStat[] {
  // 直接用字符串比较，避免时区转换问题
  const cutoffDate = new Date(currentDate + "T12:00:00+08:00");
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  // 只取窗口内的 run
  const windowRuns = runs.filter(r => r.run_date >= cutoffStr);
  if (windowRuns.length === 0) return [];

  // 按 stage 聚合
  const byStage = new Map<string, {
    successes: number; failures: number; durations: number[];
    lastError?: string; lastSuccessAt?: string; lastFailureAt?: string;
  }>();

  for (const run of windowRuns) {
    for (const c of run.calls) {
      let entry = byStage.get(c.stage);
      if (!entry) {
        entry = { successes: 0, failures: 0, durations: [] };
        byStage.set(c.stage, entry);
      }
      if (c.success) {
        entry.successes++;
        entry.lastSuccessAt = run.run_date;
      } else {
        entry.failures++;
        entry.lastFailureAt = run.run_date;
        if (c.error) entry.lastError = c.error;
      }
      if (c.duration_ms != null) entry.durations.push(c.duration_ms);
    }
  }

  const stats: RollingStat[] = [];
  for (const [stage, entry] of byStage) {
    const total = entry.successes + entry.failures;
    stats.push({
      stage,
      success: entry.successes,
      failure: entry.failures,
      total,
      success_rate: total > 0 ? entry.successes / total : 0,
      avg_duration_ms: entry.durations.length > 0
        ? Math.round(entry.durations.reduce((s, d) => s + d, 0) / entry.durations.length)
        : 0,
      last_error: entry.lastError,
      last_success_at: entry.lastSuccessAt,
      last_failure_at: entry.lastFailureAt,
      runs_with_data: windowRuns.filter(r => r.calls.some(c => c.stage === stage)).length,
    });
  }
  return stats.sort((a, b) => a.stage.localeCompare(b.stage));
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/** 生成完整的 DataHealthReport。 */
export function generateDataHealthReport(
  runDate: string,
  currentCalls: SourceCall[],
  rebalanceDir: string,
): DataHealthReport {
  const currentRun = aggregateRun(currentCalls);
  const historicalRuns = readHistoricalRuns(rebalanceDir);

  return {
    run_date: runDate,
    current_run: currentRun,
    rolling_7d: computeRollingStats(historicalRuns, 7, runDate),
    rolling_30d: computeRollingStats(historicalRuns, 30, runDate),
  };
}
