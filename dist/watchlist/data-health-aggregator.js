"use strict";
// src/watchlist/data-health-aggregator.ts
//
// 数据源健康统计：收集单次 run 的子源调用记录，聚合历史数据，计算 7天/30天 滚动成功率。
// 输出供 plan.md 渲染的 DataHealthReport。
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateRun = aggregateRun;
exports.computeRollingStats = computeRollingStats;
exports.generateDataHealthReport = generateDataHealthReport;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ── 单次 run 聚合 ──────────────────────────────────────────────────────────
/** 把一个 run 的所有 SourceCall[] 聚合为 per-stage 统计。 */
function aggregateRun(calls) {
    const byStage = new Map();
    for (const c of calls) {
        let entry = byStage.get(c.stage);
        if (!entry) {
            entry = { successes: 0, failures: 0, durations: [] };
            byStage.set(c.stage, entry);
        }
        if (c.success) {
            entry.successes++;
        }
        else {
            entry.failures++;
            if (c.error)
                entry.lastError = c.error;
        }
        if (c.duration_ms != null)
            entry.durations.push(c.duration_ms);
    }
    const stats = [];
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
/** 读取 rebalanceDir 下所有 data-health.json 文件。 */
function readHistoricalRuns(rebalanceDir) {
    const runs = [];
    // rebalanceDir 是当天的目录，需要往上一级找历史 run
    const watchlistDir = path.dirname(rebalanceDir);
    if (!fs.existsSync(watchlistDir))
        return runs;
    const entries = fs.readdirSync(watchlistDir);
    for (const entry of entries) {
        const subDir = path.join(watchlistDir, entry);
        if (!fs.statSync(subDir).isDirectory())
            continue;
        const healthFile = path.join(subDir, "data-health.json");
        if (!fs.existsSync(healthFile))
            continue;
        try {
            const content = fs.readFileSync(healthFile, "utf-8");
            const parsed = JSON.parse(content);
            if (parsed.run_date && Array.isArray(parsed.calls)) {
                runs.push(parsed);
            }
        }
        catch {
            // 跳过损坏的文件
        }
    }
    return runs.sort((a, b) => a.run_date.localeCompare(b.run_date));
}
// ── 跨 run 滚动统计 ────────────────────────────────────────────────────────
/** 计算指定天数窗口内的滚动统计。 */
function computeRollingStats(runs, windowDays, currentDate) {
    // 直接用字符串比较，避免时区转换问题
    const cutoffDate = new Date(currentDate + "T12:00:00+08:00");
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    // 只取窗口内的 run
    const windowRuns = runs.filter(r => r.run_date >= cutoffStr);
    if (windowRuns.length === 0)
        return [];
    // 按 stage 聚合
    const byStage = new Map();
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
            }
            else {
                entry.failures++;
                entry.lastFailureAt = run.run_date;
                if (c.error)
                    entry.lastError = c.error;
            }
            if (c.duration_ms != null)
                entry.durations.push(c.duration_ms);
        }
    }
    const stats = [];
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
function generateDataHealthReport(runDate, currentCalls, rebalanceDir) {
    const currentRun = aggregateRun(currentCalls);
    const historicalRuns = readHistoricalRuns(rebalanceDir);
    return {
        run_date: runDate,
        current_run: currentRun,
        rolling_7d: computeRollingStats(historicalRuns, 7, runDate),
        rolling_30d: computeRollingStats(historicalRuns, 30, runDate),
    };
}
//# sourceMappingURL=data-health-aggregator.js.map