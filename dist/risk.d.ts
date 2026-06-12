import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { TradingAgentsConfig, AnalystReport, TradingPlan, RiskArgument, RiskDebateResult, RiskAssessment, RiskJudge } from "./types";
export declare const RISK_ROLES: Array<{
    role: RiskArgument["role"];
    instructions: string;
}>;
export declare function parseRiskArgument(content: string, role: RiskArgument["role"]): RiskArgument;
/**
 * Parse a `<!-- RISK_JUDGE: {...} -->` JSON block from risk-manager output.
 * Returns null on: missing block, malformed JSON, non-object payload, or a
 * `verdict` value outside pass/revise/reject. Missing optional constraint
 * arrays are coerced to empty defaults so partial LLM output is still usable.
 */
export declare function parseRiskJudge(content: string): RiskJudge | null;
/**
 * Extract a numeric total-position cap (%) from `hard_constraints` text like
 * "总仓位≤10%", "仓位不超过20%", "最终持仓≤30%". Returns the SMALLEST cap found
 * (most restrictive) when multiple constraints apply. Returns undefined when
 * no total-position constraint is present — callers treat undefined as "no
 * override" and leave position_pct unchanged.
 *
 * Matches both "仓位" and "持仓" — they're synonyms in A-share trading and the
 * LLM emits either (600600 real run used "最终持仓≤30%"; an earlier run used
 * "总仓位≤10%"). The % sign is REQUIRED: it's what distinguishes a position-
 * PERCENT cap from an absolute-quantity constraint like "持仓量≤100万手"
 * (open interest) or "持仓≤1000股" (share count), which must NOT be treated
 * as a percentage cap.
 *
 * Why text extraction instead of a dedicated RISK_JUDGE field: the cap already
 * lives in hard_constraints (the LLM emits it there naturally — confirmed on
 * 600600); adding a parallel numeric field risks the two disagreeing. Zero
 * extra LLM cost, deterministic.
 *
 * Sub-batch constraints ("首批建仓≤5%", "首笔仓位≤3%", "分批…", "加仓…") are
 * explicitly skipped — they cap a tranche, not the total.
 */
export declare function extractPositionCap(hardConstraints: string[] | undefined): number | undefined;
export declare function runRiskDebate(tradingPlan: TradingPlan, analystReports: AnalystReport[], config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger): Promise<RiskDebateResult>;
export declare function runRiskManager(riskDebate: RiskDebateResult, tradingPlan: TradingPlan, config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger): Promise<RiskAssessment>;
//# sourceMappingURL=risk.d.ts.map