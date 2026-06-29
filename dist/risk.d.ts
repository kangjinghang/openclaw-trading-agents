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
/** 从 hard_constraints 文本里抽止损价下限（元），如 "止损价≥60.5元"。
 *  仅用于 resolveMinStopLoss 的 fallback（数值字段缺失时）。提取多个时取最大值
 *  （最严格：要求更高的止损价）。无匹配返回 undefined。 */
export declare function extractStopLossFromText(hardConstraints: string[] | undefined): number | undefined;
/**
 * 解析仓位上限的统一入口：数值字段优先，正则 fallback。
 *
 * - judge.max_position_pct 存在 → 直接用（已 clamp 0-100），这是权威路径
 * - 否则 fallback 到 extractPositionCap(hard_constraints)（旧正则，兜底）
 *
 * 返回 cap（undefined = 无上限）+ mismatch 标志。mismatch=true 表示数值字段
 * 与正则抽出的值不一致（差值 > 0.5%）——调用方应 recordWarning，但仍以数值字段为准。
 * 这是对"正则反推"系统弱点的收敛：数值字段为单一权威源，正则仅兜底 + 一致性校验。
 */
export declare function resolveMaxPosition(judge: RiskJudge | null | undefined): {
    cap: number | undefined;
    mismatch: boolean;
};
/**
 * 解析止损价下限的统一入口：数值字段优先，正则 fallback。与 resolveMaxPosition
 * 对称。orchestrator 用它替代内联的 hard_constraints 正则。
 */
export declare function resolveMinStopLoss(judge: RiskJudge | null | undefined): {
    floor: number | undefined;
    mismatch: boolean;
};
export declare function runRiskDebate(tradingPlan: TradingPlan, analystReports: AnalystReport[], config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger): Promise<RiskDebateResult>;
export declare function runRiskManager(riskDebate: RiskDebateResult, tradingPlan: TradingPlan, config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger): Promise<RiskAssessment>;
//# sourceMappingURL=risk.d.ts.map