import OpenAI from "openai";
import { TradingAgentsConfig, QuickAnalysisResult, FullAnalysisResult, AnalystReport, ScriptResult, RunMeta } from "./types";
/** Generate a data quality description for an analyst based on their ScriptResult. */
export declare function generateDataQuality(role: string, date: string, result: ScriptResult): string;
/**
 * Build template variable mapping for an analyst role.
 * Most roles use a 1:1 mapping { [dataKey]: dataJson }.
 * News, sentiment, and policy roles need the data JSON split into
 * multiple template variables to match their prompt templates
 * (e.g. {{stock_news}} + {{macro_news}} instead of {{news}}).
 */
export declare function buildTemplateVars(role: string, dataKey: string, dataJson: string): Record<string, string>;
/** Pre-run validation: check environment before starting analysis */
/** Calculate quick-mode confidence based on analyst success rate and quality grades */
export declare function calculateQuickConfidence(reports: AnalystReport[], quality: {
    grades: Array<{
        role: string;
        grade: string;
    }>;
}, layer2?: {
    credibility?: string;
    fabrication_suspects?: string[];
} | null): number;
/** Structured progress log to stderr */
/** Optional progress callback for OpenClaw onUpdate integration */
export type ProgressCallback = (text: string, id?: string) => void;
/** Create a run-scoped logProgress that also forwards to OpenClaw onUpdate */
declare function makeLogProgress(runId: string, onProgress?: ProgressCallback): (message: string, tokens?: number, costUsd?: number, id?: string) => void;
type LogProgressFn = ReturnType<typeof makeLogProgress>;
/** Compute overall % within a stage's [start,end] range given a 0..1 fraction. */
export declare function pctInRange(range: [number, number], frac: number): number;
/** Format elapsed ms as "45s" (<60s) or "1m30s" (>=60s). */
export declare function formatElapsed(ms: number): string;
/** Duration-weighted stage → [startPct, endPct] maps. Analysts dominate (~80% quick / ~52% full). */
export declare const QUICK_WEIGHTS: Record<string, [number, number]>;
export declare const FULL_WEIGHTS: Record<string, [number, number]>;
/**
 * Emits a single in-place "overall-progress" line: `总进度 N% · 已用 Xs`.
 * Monotonic: emit is a no-op when the computed pct does not strictly exceed
 * the last emitted pct. This makes revise-loop re-runs of trader/riskDebate
 * automatically skip (they'd re-compute a lower pct) without the orchestrator
 * needing to track first-pass vs retry.
 */
export declare class ProgressTracker {
    private startTime;
    private log;
    private weights;
    private lastPct;
    constructor(startTime: number, log: LogProgressFn, weights: Record<string, [number, number]>);
    emit(stage: string, frac?: number): void;
}
/**
 * Run a quick analysis workflow with 7 parallel analysts:
 * 1. Fetch data from all 7 scripts in parallel (graceful degradation)
 * 2. Run all 7 analysts in parallel (graceful degradation)
 * 3. Portfolio Manager synthesizes all 7 reports
 * 4. Persist and return result
 */
export declare function runQuickAnalysis(ticker: string, date: string, config: TradingAgentsConfig, openaiClient: OpenAI, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<[QuickAnalysisResult, RunMeta]>;
/**
 * Extract the most recent daily close from the market data script result, for
 * use as the market reference in cross-stage checks (target/stop on wrong side
 * of current price). Returns undefined when market data is missing/failed or
 * has no bars — callers skip the market-dependent checks in that case.
 */
export declare function extractLatestClose(dataResults: Array<{
    role: string;
    result: ScriptResult;
}>): number | undefined;
/**
 * Run full analysis with debate and risk layers:
 * 1. 7 analysts (parallel) → 2. Bull↔Bear debate → 3. Research Manager
 * 4. Trader → 5. Risk Debate (3-way parallel) → 6. Risk Manager (with revise loop)
 */
export declare function runFullAnalysis(ticker: string, date: string, config: TradingAgentsConfig, openaiClient: OpenAI, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<[FullAnalysisResult, RunMeta]>;
export {};
//# sourceMappingURL=orchestrator.d.ts.map