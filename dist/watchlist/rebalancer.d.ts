import type { Holdings, LastRebalance, RebalanceConstraints, RebalancePlan, StockReport, ConstraintViolation, RebalanceConfig } from "./rebalance-types";
import { type ValidationContext } from "./constraint-validator";
import { type ShallowLlmCaller, type StockData } from "./shallow-analyzer";
import { buildExecutionPlan } from "./execution-planner";
import type { ScanSummary } from "./types";
export declare function formatRebalancerPrompt(reports: StockReport[], holdings: Holdings, lastRebalance: LastRebalance | null, c: RebalanceConstraints, antiChurnDays: number): string;
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
}
/** 跑 rebalancer + revise loop。最多 max_revise_retries 次。 */
export declare function runRebalanceWithRevise(caller: RebalanceLlmCaller, basePrompt: string, ctx: ValidationContext, config: RebalanceConfig): Promise<RebalanceResult>;
export interface RebalancePipelineInput {
    scan: ScanSummary;
    holdings: Holdings;
    lastRebalance: LastRebalance | null;
    currentDate: string;
    shallowCaller: ShallowLlmCaller;
    rebalanceCaller: RebalanceLlmCaller;
    dataByTicker?: Map<string, StockData>;
    config?: Partial<RebalanceConfig>;
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
}
/** 完整 pipeline：候选选择 → shallow-analyzer → rebalancer + revise → execution plan。 */
export declare function rebalancePipeline(input: RebalancePipelineInput): Promise<RebalancePipelineResult>;
//# sourceMappingURL=rebalancer.d.ts.map