import type { Holdings, LastRebalance, RebalanceConstraints, RebalancePlan, StockReport, ConstraintViolation, RebalanceConfig } from "./rebalance-types";
import { type ValidationContext } from "./constraint-validator";
import { type ShallowLlmCaller, type StockData } from "./shallow-analyzer";
import { buildExecutionPlan } from "./execution-planner";
import { type ApplyPositionsContext } from "./position-calculator";
import type { MacroView } from "./data-fetcher";
import type { ScanSummary } from "./types";
export declare function formatRebalancerPrompt(reports: StockReport[], holdings: Holdings, lastRebalance: LastRebalance | null, c: RebalanceConstraints, antiChurnDays: number, macroView?: MacroView | null): string;
/** 解析 rebalancer 输出。过滤幻觉 ticker。失败返回 null。 */
export declare function parseRebalancePlan(content: string, validTickers: Set<string>): RebalancePlan | null;
export type RebalanceLlmCaller = (input: {
    systemPrompt: string;
    userMessage: string;
}) => Promise<string>;
export interface RebalanceResult {
    plan: RebalancePlan | null;
    reviseCount: number;
    status: "ok" | "constraint_violation" | "llm_failed";
    finalViolations: ConstraintViolation[];
    positionTraces: Map<string, string>;
}
/** 跑 rebalancer + revise loop。最多 max_revise_retries 次。
 *
 *  positionCtx 可选：传入后每次 parse 出的 plan 会先经 applyPositions 改写
 *  （LLM 只出方向，代码算仓位），再 validate。这是确定性仓位计算器的接入点。 */
export declare function runRebalanceWithRevise(caller: RebalanceLlmCaller, basePrompt: string, ctx: ValidationContext, config: RebalanceConfig, positionCtx?: ApplyPositionsContext, 
/** ticker → 当前仓位（持仓股才有，候选股=0）。
 *  用于 parse 后补齐 current_weight（LLM 不再输出这个字段）。 */
currentWeights?: Map<string, number>): Promise<RebalanceResult>;
export interface RebalancePipelineInput {
    scan: ScanSummary;
    holdings: Holdings;
    lastRebalance: LastRebalance | null;
    currentDate: string;
    shallowCaller: ShallowLlmCaller;
    rebalanceCaller: RebalanceLlmCaller;
    dataByTicker?: Map<string, StockData>;
    config?: Partial<RebalanceConfig>;
    /** 全市场宏观视图（一次性抓取，注入组合决策层）。
     *  null/undefined → rebalancer prompt 省略宏观段（向后兼容）。 */
    macroView?: MacroView | null;
}
export interface RebalancePipelineResult {
    reports: StockReport[];
    rebalancer_output: RebalancePlan;
    constraint_check: {
        passed: boolean;
        violations: string[];
        revise_count: number;
    };
    execution_plan: ReturnType<typeof buildExecutionPlan>;
    status: "ok" | "constraint_violation" | "llm_failed";
    /** 行业拉取相关警告（fundamentals.industry 为空的股按"未分类"累计，规则 3 对它们失效） */
    sector_warnings: string[];
    /** 仓位计算器溯源（ticker → 可读字符串） */
    position_traces: Record<string, string>;
}
/** 完整 pipeline：候选选择 → shallow-analyzer → rebalancer + revise → execution plan。 */
export declare function rebalancePipeline(input: RebalancePipelineInput): Promise<RebalancePipelineResult>;
//# sourceMappingURL=rebalancer.d.ts.map