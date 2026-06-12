import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { TradingAgentsConfig, AnalystReport, QualitySummary, QualityReview } from "./types";
/**
 * Parse a `<!-- QUALITY_REVIEW: {...} -->` JSON block from an LLM review turn.
 * Returns null on: missing block, malformed JSON, non-object payload, or a
 * `credibility` value outside 高/中/低. String-array fields are coerced to
 * empty defaults when missing so partial output is still usable.
 */
export declare function parseQualityReview(content: string): QualityReview | null;
/**
 * Render a parsed review into a markdown section to append to the Layer-1
 * `summary_text`, so downstream agents (debate / research / trader / PM) see
 * the credibility signal alongside the grade table.
 */
export declare function formatQualityReview(review: QualityReview): string;
/**
 * Run the LLM Layer-2 credibility review over all analyst reports.
 *
 * Returns null (graceful degrade to Layer-1-only) when:
 *  - ≥4 reports already hard-failed Layer 1 (not worth a review call), or
 *  - the LLM call throws / returns empty / emits no parseable block.
 *
 * Never throws — this is an optional enrichment that must not block the pipeline.
 */
export declare function runQualityReview(reports: AnalystReport[], quality: QualitySummary, ticker: string, date: string, config: TradingAgentsConfig, client: OpenAI, traceLogger: TraceLogger): Promise<QualityReview | null>;
//# sourceMappingURL=quality-review.d.ts.map