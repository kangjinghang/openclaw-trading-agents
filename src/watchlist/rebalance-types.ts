// src/watchlist/rebalance-types.ts

// ═══ 输入 ═══

export interface Position {
  ticker: string;
  name: string;
  weight: number;                  // 0-1
  entry_price: number;
  entry_date: string;              // "YYYY-MM-DD"
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
  /** ticker → 最近卖出日期（YYYY-MM-DD）。跨多次 rebalance 累积，用于 anti-churn 买锁。
   *  旧版 last_rebalance.json 无此字段（向后兼容：undefined 视为空）。 */
  recent_sells?: Record<string, string>;
}

// ═══ shallow-analyzer 产物 ═══

export interface AnalystReport {
  thesis: string;
  fitness_score: number;           // 0-10
  data_freshness: string;          // "YYYY-MM-DD"
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
  current_weight: number;          // is_held=false → 0
  days_held: number;               // is_held=false → 0
  locked: boolean;                 // is_held=false → false
  ranker_score?: number;
  /** 确定性质量门控标注（applyQualityGate 产物，空则不输出）。
   *  例：["fitness 8→6（PE=0 数据缺失封顶）"]。和 position_traces 同源，
   *  让 fitness 也可溯源（"为什么这只股从 8 分变 6 分"）。 */
  quality_notes?: string[];
}

// ═══ rebalancer 产物 ═══

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
  priority: number;                // 1=SELL, 2=REDUCE, 3=BUY, 4=ADD, 5=HOLD
}

export interface PortfolioAfter {
  positions: Array<{ ticker: string; weight: number }>;
  cash_pct: number;
}

export interface RebalancePlan {
  evaluations: Evaluation[];
  actions: Action[];
  portfolio_after: PortfolioAfter;
  summary: string;
}

// ═══ constraint-validator ═══

export interface ConstraintViolation {
  rule: string;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  violations: ConstraintViolation[];
}

// ═══ execution-planner ═══

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

// ═══ 完整 plan.json ═══

export interface RebalancePlanFile {
  scan_date: string;
  written_at: string;
  status: "ok" | "constraint_violation" | "llm_failed";
  model: string;
  tokens: number;
  holdings_before: Holdings;
  candidates: Array<{ ticker: string; ranker_score: number }>;
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
  /** 仓位计算器溯源（ticker → 可读字符串，如 "BUY：8分基础 5.0% × 波动率1.0 × 风险0.6 = 3.00%"） */
  position_traces?: Record<string, string>;
  /** 数据源健康统计（子源级成功率 + 7天/30天滚动） */
  data_health?: import("./data-health-aggregator").DataHealthReport;
}

// ═══ 配置 ═══

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
  /** shallow-analyzer 跨股并发数（任意时刻最多 N 个 LLM call）。
   *  zhipu glm-5.x 在并发 ≥3 时易触发 429（推理模型耗时长，请求堆积），
   *  默认 2 比 analyzeAll 原默认 3 更稳；可通过 config.json 覆盖。 */
  shallow_concurrency: number;
}

export const DEFAULT_REBALANCE_CONFIG: RebalanceConfig = {
  top_n: 10,
  constraints: {
    single_name: 0.15,
    single_sector: 0.30,
    daily_turnover: 0.30,
    cash_reserve: 0.10,
  },
  anti_churn_days: 7,
  max_revise_retries: 2,
  run_optional_scripts: false,
  shallow_concurrency: 2,
};
