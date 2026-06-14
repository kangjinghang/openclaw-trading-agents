import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { TradingAgentsConfig, AnalystReport, DebateResult, DebateStatePayload } from "./types";
/**
 * Extract summary section from debate output.
 */
export declare function extractSummary(content: string): string;
/**
 * Parse a `<!-- DEBATE_STATE: {...} -->` JSON block from LLM debate output.
 * Returns null on: missing block, malformed JSON, or non-object payload.
 * Missing optional fields are coerced to empty defaults so partial LLM output
 * is still usable.
 */
export declare function parseDebateState(content: string): DebateStatePayload | null;
/**
 * Run multi-round Bull<->Bear debate over analyst reports.
 *
 * Each turn prefers the structured `<!-- DEBATE_STATE: {...} -->` payload
 * (state-machine mode: stable claim IDs, resolved/unresolved tracking, focus
 * propagation). When absent, it falls back to `parseClaims()` regex parsing
 * with no state update, preserving legacy behavior.
 */
export declare function runBullBearDebate(analystReports: AnalystReport[], qualitySummary: string, config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger): Promise<DebateResult>;
//# sourceMappingURL=debate.d.ts.map