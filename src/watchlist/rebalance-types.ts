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
  /** 建仓时 LLM 评的 fitness（0-10），用于平仓后校准评分预测力。可选：旧持仓/hand-edit 可能缺失。 */
  entry_fitness?: number;
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

export interface Fill {
  ticker: string;
  action: "BUY" | "SELL" | "ADD" | "REDUCE";
  /** QMT 委托号，溯源/撤单用。pending 时为空串。 */
  order_sys_id: string;
  filled_price: number;
  filled_volume: number;             // 实际成交股数
  intended_volume: number;           // 计划股数，部分成交时对比
  status: "filled" | "partial" | "rejected" | "cancelled";
}

export type ExecStatus = "pending" | "executing" | "filled" | "partial" | "failed";

export interface Execution {
  status: ExecStatus;
  /** ISO timestamp，云服务器回填。pending/executing 时为 null。 */
  executed_at: string | null;
  /** 执行时总资产（元），对账溯源用（下单换算用实时查的值）。pending 时为 null。 */
  account_total_asset: number | null;
  fills: Fill[];
  errors: string[];
}

export interface LastRebalance {
  date: string;
  /** 幂等键：date + "-" + sha256(canonicalize(actions)).slice(0,6)。
   *  旧版无此字段（视为 pending 旧订单）。 */
  order_id?: string;
  actions: LastRebalanceAction[];
  /** Mac 算好的下单顺序（SELL→REDUCE→BUY→ADD，按 |delta| 降序）。
   *  供云服务器 Python 直接读、不重算。旧版无此字段。 */
  execution_sequence?: ExecutionStep[];
  /** ticker → 最近卖出日期（YYYY-MM-DD）。跨多次 rebalance 累积，用于 anti-churn 买锁。
   *  旧版 last_rebalance.json 无此字段（向后兼容：undefined 视为空）。 */
  recent_sells?: Record<string, string>;
  /** 订单执行状态机。云服务器执行后回填。开发机产出时写 pending 占位。
   *  旧版无此字段（视为从未执行）。 */
  execution?: Execution;
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
  status: "ok" | "constraint_violation" | "parse_failed" | "llm_failed";
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
  /** 全市场宏观视图（一次性抓取，注入组合决策层）。
   *  拉取失败时不写该字段。详见 data-fetcher.ts 的 MacroView。 */
  macro_view?: import("./data-fetcher").MacroView;
  /** 本次生效的约束配置（写进 planFile 供 plan.md 渲染真实阈值对比，
   *  而非硬编码 0.15/0.30/0.50/0.10——后者会与真实 single_name=0.22 等配置不符，
   *  让合规方案在 plan.md 里误报 ✗）。缺失时 formatter 回退到默认配置并标注。 */
  constraints?: RebalanceConstraints;
}

// ═══ 配置 ═══

export interface RebalanceConstraints {
  single_name: number;
  single_sector: number;
  daily_turnover: number;
  cash_reserve: number;
  /** 建仓回撤止损阈值：建仓后 initial_stop_days 天内，从 entry_price 回撤 ≥ 此值 → 强制 SELL。
   *  补技术信号的盲区：建仓次日大跌但未跌破支撑位/量比正常时，纯技术信号不触发。 */
  initial_stop_drawdown: number;
  /** 建仓回撤止损观察窗口（天）。超过后靠技术信号（MACD死叉/破位/量价背离）。 */
  initial_stop_days: number;
  /** 持仓数上限（target_weight>0 的 action 数 ≤ 此值）。
   *  落实"3-5 只集中"定位——之前这只是一句 prompt 软引导，LLM 无视它一路买到 7-8 只，
   *  仓位打满后触发换手率死亡螺旋（满仓想换仓，双向换手率数学上必超上限，永远调不动仓）。
   *  这是上限不是必须达到：手数取整买不足一手被跳过时，实际持仓可少于上限，不违规。 */
  max_positions: number;
  /** 止盈豁免阈值：locked 期内浮盈（cur/entry-1）≥ 此值时，允许突破 anti-churn 锁卖出。
   *  anti-churn 防"无谓 churn"（噪音驱动的冲动卖出），但止盈是合理操作——落袋为安不是 churn。
   *  没 这个豁免时，豫光金铅 +7.6% 浮盈想止盈也被 7 天锁挡死，LLM 撞锁死磕整天调不动仓。
   *  与 stopLossSignal（止损豁免）镜像：止损防下行、止盈锁上行利润。 */
  take_profit_threshold: number;
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

// 趋势模式默认配置：集中（3-5 只 / 单仓≤22%）+ 低现金（3%）+ 高换手容忍
// 20 万小账户定位：3-5 只集中（÷4=5万/只，覆盖100元以下标的能买整手），fit8 单票≈1.9万
//
// 参数置信度（✅回测验证 / ⚠️猜测待验证 / ❓未知），调参前看 docs/backtest-params.md：
//   single_name 0.22          ✅ 回测验证（集中定位，让 fit10 不截断）
//   single_sector 0.25         ⚠️ 当前仓位下未触发（一级聚合后电子 18.5% < 25%），本金变大才会真正考验
//   cash_reserve 0.03          ✅ 回测验证（趋势要在场）
//   initial_stop_drawdown 0.07 ✅ 国瓷 -8.3% 能触发，香农正常波动 <5% 不误伤
//   initial_stop_days 3        ❓ 生益第6天破位未触发，可能偏短，待 A/B 对比 3/5/7 天
//   max_positions 5            ✅ 落实"3-5 只"定位（之前是 prompt 软引导，LLM 无视买到 7-8 只）
//   take_profit_threshold 0.15 ✅ 止盈豁免（浮盈≥15% 可突破锁，豫光 +7.6% 想止盈被挡的 case）
//   daily_turnover 0.50        ✅ 单向算法（max(买,卖)）+ 放宽 0.40→0.50，修满仓换仓死亡螺旋
//   max_revise_retries 3       ✅ 2→3，多一次收敛机会（换手/持仓数违规时需要 LLM 砍动作）
//   anti_churn_days 7          ⚠️ 经验值（防 churn vs 灵活调仓的平衡点，未压力测试）
export const DEFAULT_REBALANCE_CONFIG: RebalanceConfig = {
  top_n: 15,  // 候选数 15（max_positions=5 的 3 倍，给跨行业选股 + 备选留空间；太小→非电子强标的进不来）
  constraints: {
    single_name: 0.22,    // 单仓上限 22%（集中定位，对应 fit10 baseWeight 22% 不被截断）
    single_sector: 0.25,  // 单行业 25%（分散，一级聚合）
    daily_turnover: 0.50, // 日换手上限 50%（单向 max(买入,卖出)；满仓换 3 只≈30%，留余量）
    cash_reserve: 0.03,   // 现金下限 3%（趋势模式要在场，少留现金）
    initial_stop_drawdown: 0.07,  // 建仓回撤止损 7%（国瓷 -8.3% 能触发，香农正常波动 <5% 不误伤）
    initial_stop_days: 3,          // 建仓后 3 天内回撤超阈值 → 强制清仓；超过靠技术信号
    max_positions: 5,    // 持仓数上限 5（落实"3-5 只"集中定位，上限非必须达到）
    take_profit_threshold: 0.15,   // 止盈豁免 15%（浮盈≥15% 可突破 anti-churn 锁卖出，落袋为安不是 churn）
  },
  anti_churn_days: 7,
  max_revise_retries: 3,
  run_optional_scripts: false,
  shallow_concurrency: 2,
};
