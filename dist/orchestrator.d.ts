import OpenAI from "openai";
import { TradingAgentsConfig, QuickAnalysisResult, FullAnalysisResult, ScriptResult, RunMeta } from "./types";
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
/**
 * Run a quick analysis workflow with 7 parallel analysts:
 * 1. Fetch data from all 7 scripts in parallel (graceful degradation)
 * 2. Run all 7 analysts in parallel (graceful degradation)
 * 3. Portfolio Manager synthesizes all 7 reports
 * 4. Persist and return result
 */
export declare function runQuickAnalysis(ticker: string, date: string, config: TradingAgentsConfig, openaiClient: OpenAI, signal?: AbortSignal): Promise<[QuickAnalysisResult, RunMeta]>;
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
export declare function runFullAnalysis(ticker: string, date: string, config: TradingAgentsConfig, openaiClient: OpenAI, signal?: AbortSignal): Promise<[FullAnalysisResult, RunMeta]>;
//# sourceMappingURL=orchestrator.d.ts.map