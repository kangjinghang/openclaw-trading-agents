import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { TradingAgentsConfig, AnalystReport, ResearchDecision, TradingPlan, RiskJudge } from "./types";
/**
 * Parse the total position size (%) from a trader plan.
 *
 * The prompt labels this field "建议仓位" (a Buy-view phrase), so for
 * Sell/Underweight and Hold plans the LLM often emits a direction-appropriate
 * synonym instead — "减仓总量", "减仓比例", "总仓位", "建仓总量". The single-
 * label parser missed those → position_pct fell back to 0, which also silently
 * defeated the risk cap-binding downstream (a cap of N% is never < 0).
 * Regression: the 600600 Sell run wrote "减仓总量 ... 30%" yet stored
 * position_pct=0.
 *
 * Tries the canonical label first; if that yields nothing, falls back through
 * the synonyms. Returns 0 only when no total-position value is present
 * anywhere. Sub-batch tranche labels (第一批/第二批/分批/加仓) are never
 * synonyms, so a per-tranche number is never mistaken for the total.
 */
export declare function parsePositionPctSource(content: string): {
    value: number;
    source: string;
};
export declare function parsePositionPct(content: string): number;
/**
 * Parse a `<!-- TRADER_PLAN: {...} -->` JSON block from trader output.
 * Returns null on: missing block, malformed JSON, or non-object payload.
 * Missing optional arrays are coerced to empty defaults so partial LLM
 * output is still usable. Mirrors the VERDICT/DEBATE_STATE/RISK_JUDGE
 * structured-output protocol — decouples signal parsing from the exact
 * markdown heading format the LLM happens to emit.
 */
export declare function parseTraderPlan(content: string): {
    entry_signals: string[];
    exit_signals: string[];
    invalidations: string[];
    key_risks: string[];
} | null;
export declare function runTrader(researchDecision: ResearchDecision, analystReports: AnalystReport[], qualitySummary: string, config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger, ticker?: string, date?: string, riskJudge?: RiskJudge): Promise<TradingPlan>;
//# sourceMappingURL=trader.d.ts.map