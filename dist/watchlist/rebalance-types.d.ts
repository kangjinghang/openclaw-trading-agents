export interface Position {
    ticker: string;
    name: string;
    weight: number;
    entry_price: number;
    entry_date: string;
    shares: number;
    sector: string;
}
export interface Holdings {
    updated_at: string;
    cash_pct: number;
    positions: Position[];
}
export interface LastRebalanceAction {
    action: "BUY" | "SELL" | "ADD" | "REDUCE";
    ticker: string;
    weight: number;
}
export interface LastRebalance {
    date: string;
    actions: LastRebalanceAction[];
}
export interface AnalystReport {
    thesis: string;
    fitness_score: number;
    data_freshness: string;
    key_signals: string[];
    data_gaps: string[];
}
export interface RiskFlag {
    flag: string;
    severity: "低" | "中" | "高";
    detail: string;
}
export interface RiskReport {
    risk_flags: RiskFlag[];
    overall_risk: "low" | "medium" | "high";
    deal_breaker: boolean;
}
export interface StockReport {
    ticker: string;
    name: string;
    sector: string;
    thesis: string;
    fitness_score: number;
    key_signals: string[];
    data_gaps: string[];
    risk_flags: RiskFlag[];
    overall_risk: "low" | "medium" | "high";
    deal_breaker: boolean;
    is_held: boolean;
    current_weight: number;
    days_held: number;
    locked: boolean;
    ranker_score?: number;
}
export type ActionType = "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD";
export interface Evaluation {
    ticker: string;
    judgment: "BUY" | "HOLD" | "REDUCE" | "SELL" | "SKIP";
    brief: string;
}
export interface Action {
    action: ActionType;
    ticker: string;
    name: string;
    current_weight: number;
    target_weight: number;
    delta: number;
    reason: string;
    priority: number;
}
export interface PortfolioAfter {
    positions: Array<{
        ticker: string;
        weight: number;
    }>;
    cash_pct: number;
}
export interface RebalancePlan {
    evaluations: Evaluation[];
    actions: Action[];
    portfolio_after: PortfolioAfter;
    summary: string;
}
export interface ConstraintViolation {
    rule: string;
    detail: string;
}
export interface ValidationResult {
    passed: boolean;
    violations: ConstraintViolation[];
}
export interface ExecutionStep {
    step: number;
    action: Exclude<ActionType, "HOLD">;
    ticker: string;
    name: string;
    weight_delta: number;
    est_cash_after: number;
    note?: string;
}
export interface ExecutionPlan {
    execution_sequence: ExecutionStep[];
    final_state: PortfolioAfter;
    warnings: string[];
}
export interface RebalancePlanFile {
    scan_date: string;
    written_at: string;
    status: "ok" | "constraint_violation" | "llm_failed";
    model: string;
    tokens: number;
    holdings_before: Holdings;
    candidates: Array<{
        ticker: string;
        ranker_score: number;
    }>;
    last_rebalance: LastRebalance | null;
    reports: StockReport[];
    rebalancer_output: RebalancePlan;
    constraint_check: {
        passed: boolean;
        violations: string[];
        revise_count: number;
    };
    execution_plan: ExecutionPlan;
    /** 行业拉取相关警告（fundamentals.industry 为空的股按"未分类"累计，规则 3 对它们失效） */
    sector_warnings?: string[];
}
export interface RebalanceConstraints {
    single_name: number;
    single_sector: number;
    daily_turnover: number;
    cash_reserve: number;
}
export interface RebalanceConfig {
    top_n: number;
    constraints: RebalanceConstraints;
    anti_churn_days: number;
    max_revise_retries: number;
    run_optional_scripts: boolean;
}
export declare const DEFAULT_REBALANCE_CONFIG: RebalanceConfig;
//# sourceMappingURL=rebalance-types.d.ts.map