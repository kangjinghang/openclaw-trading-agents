// src/types.ts

/** Configuration from openclaw.json plugins.entries.trading-agents.config */
export interface TradingAgentsConfig {
  models: {
    analyst: string;
    debater: string;
    decision: string;
    risk: string;
    /**
     * Deep/reasoning model for the two synthesis-gatekeeper roles
     * (research manager + risk manager) — the reasoning-intensive calls.
     * Optional: when unset, research manager falls back to `decision`
     * and risk manager falls back to `risk` (legacy behavior).
     * Mirrors TradingAgents' quick/deep-thinking two-tier split.
     */
    decision_deep?: string;
    /**
     * Per-tier thinking mode override for GLM models.
     * Only affects GLM-4.5+ models; ignored by other providers.
     * Valid values: "enabled" | "disabled" | (unset = API default).
     * When set, passed as `thinking: { type }` in the chat completion request.
     */
    analyst_thinking?: string;
    decision_thinking?: string;
  };
  debate_rounds: number;
  risk_debate_rounds: number;
  max_risk_retries: number;
  report_dir: string;
  llm_concurrency: number;
  /** Optional: override API key for LLM calls (independent of OpenClaw host) */
  api_key?: string;
  /** Optional: override base URL for LLM calls */
  base_url?: string;
}

/** Phase 1 output: single analyst report */
export interface AnalystReport {
  role: string;
  content: string;
  verdict: Verdict;
  data_sources_used: string[];
}

export interface Verdict {
  direction: string;
  reason: string;
}

/** Phase 5 output: final trading decision */
export interface FinalDecision {
  ticker: string;
  company_name: string;
  date: string;
  direction: "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
  confidence: number;
  target_price: number;
  stop_loss: number;
  position_pct: number;
  reasoning: string;
  key_risks: string[];
  analyst_verdicts: Record<string, string>;
  bull_bear_summary: string;
  risk_assessment: "pass" | "revise" | "reject";
  execution_plan: string;
  next_review_trigger: string;
  /** Human-readable explanation of WHY the final decision was made (e.g. analyst conflicts, risk overrides). */
  decision_rationale?: string;
}

/** Quick analysis result (returned by trading_quick tool) */
export interface QuickAnalysisResult {
  ticker: string;
  date: string;
  mode: "quick";
  analysts: AnalystReport[];
  final: FinalDecision;
}

/** Summary JSON saved to trading-reports/ */
export interface AnalysisReport {
  id: string;
  run_id?: string;
  ticker: string;
  company_name: string;
  date: string;
  mode: "full" | "quick";
  created_at: string;
  duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  final: FinalDecision;
  analyst_verdicts: Record<string, { direction: string; reason: string }>;
  detail_dir: string;
  trace_count: number;
  /** Silent fallbacks that fired during the run (parse → default/synonym). */
  warnings?: FallbackWarning[];
  /** Cross-stage structural anomalies (full mode only). */
  cross_stage_issues?: CrossStageIssue[];
  /** Pipeline health issues collected at each checkpoint. */
  pipeline_health?: PipelineIssue[];
  /**
   * Full RiskAssessment object (review gap #4). `final.risk_assessment` is the
   * string status for backward compatibility; this field carries the complete
   * object (judge constraints, risk_score, retries_exhausted) so dashboard and
   * external consumers can access risk details without reading detail files.
   * Undefined in quick mode (no risk phase).
   */
  risk_assessment_detail?: RiskAssessment;
  /**
   * Provenance chain recording the decision flow through pipeline stages
   * (review gap #5). Each entry captures the key decision and a reference
   * to the detail file, so a reviewer can trace how the final decision was
   * derived without reading through all detail files.
   */
  provenance: ProvenanceStage[];
}

/**
 * A structural anomaly across pipeline stages — e.g. the trader's target price
 * is on the wrong side of the market, risk passed despite a conservative
 * reject, or analysts are bearish while research says Buy. Unlike the analyst-
 * only quality gate, these run at the END of the full pipeline and check that
 * the stages agree with each other and with the market. Deterministic — zero
 * LLM cost.
 */
export interface CrossStageIssue {
  severity: "warn" | "error";
  check: string;
  message: string;
}

/** A single pipeline health check result. */
export interface PipelineIssue {
  /** Pipeline stage where the issue was detected. */
  stage: "data_collection" | "template_render" | "analyst_output" | "quality_gate" | "quality_review" | "debate" | "research" | "trader" | "risk_debate" | "risk_manager" | "risk_revise" | "cross_stage";
  /** abort = stop pipeline; skip = skip this item; warn = record only; error = serious but non-fatal (e.g. self-contradictory report). */
  severity: "abort" | "skip" | "warn" | "error";
  /** Short check name (e.g. "placeholders_remaining"). */
  check: string;
  /** Human-readable description. */
  message: string;
  /** Optional context (role, placeholder names, etc.). */
  context?: Record<string, any>;
}

/** Single LLM call trace for auditing */
export interface LLMCallTrace {
  trace_id: string;
  run_id?: string;
  call_index: number;
  phase: "analyst" | "debate" | "research" | "trader" | "risk_debate" | "risk" | "portfolio" | "quality_review" | "rank" | "rebalance";
  role: string;
  request: {
    model: string;
    system_prompt: string;
    user_message: string;
    temperature?: number;
    max_tokens?: number;
  };
  response: {
    raw_content: string;
    parsed_verdict?: Verdict;
  };
  meta: {
    timestamp: string;
    duration_ms: number;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    cost_usd: number;
    /** True when this call only stopped because the LLM_TOTAL_DEADLINE_MS
     *  budget elapsed (callLLM gave up mid-retry-loop). Lets a reviewer
     *  distinguish "model was slow" from "we hard-stopped it" when reading
     *  a trace. Absent on normal calls. */
    deadline_hit?: boolean;
  };
}

/**
 * A silent fallback that fired during a run: a parse/extract path degraded to a
 * default, synonym, or alternative without failing outright. Surfaces these so a
 * reviewer can see "this run degraded here" (e.g. position_pct fell back to a
 * synonym, or risk defaulted to "pass") instead of a report that looks healthy
 * while a value quietly went wrong. `severity: "error"` marks dangerous defaults
 * (risk → pass, numeric → 0); `"warn"` marks benign synonyms/fallbacks.
 */
export interface FallbackWarning {
  phase: string;
  fn: string;
  detail: string;
  severity: "warn" | "error";
}

/** Per-source call result emitted by Python data scripts via `_calls` array. */
export interface SourceCall {
  /** Source identifier, slash-separated for hierarchy (e.g. "hot_money/northbound"). */
  stage: string;
  /** True if the call yielded usable data. */
  success: boolean;
  /** Short error message if failed; null/undefined if succeeded. */
  error?: string | null;
  /** Call duration in ms (for slow-source detection). */
  duration_ms?: number | null;
  /** HTTP URL that was called (for debugging). */
  url?: string | null;
  /** HTTP status code (for debugging). */
  status_code?: number | null;
  /** Response body size in bytes (for debugging). */
  response_size?: number | null;
  /** Full response body (for debugging). */
  response_snippet?: string | null;
}

/** Result from a Python data script */
export interface ScriptResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  _source?: string;
  vpa?: string;
  technical_indicators?: string;
  /** Non-fatal source/sub-source failures recorded by the Python script via
   *  http_helpers.record_error(). Surfaced so a silent partial outage (e.g. a
   *  secondary data feed down) is observable without affecting `success`.
   *  Backward-compat view of `calls` (failure-only); prefer reading `calls`. */
  errors?: Array<{ stage: string; error: string }>;
  /** All per-source call results (success + failure). Preferred over `errors`
   *  for computing per-source success rates and detecting outages/rate-limits.
   *  Emitted by Python via http_helpers.record_call() → output_json() `_calls`. */
  calls?: SourceCall[];
}

// ── Phase 3: Debate types ──

/** A single debate claim with structured evidence. */
export interface DebateClaim {
  id: string;
  side: "bull" | "bear";
  topic: string;
  evidence: string;
  confidence: number;
  responded_by?: string;
  // ── DEBATE_STATE tracking (optional, additive) ──
  status?: "open" | "addressed" | "resolved" | "unresolved";
  round?: number;
}

/** One round of Bull↔Bear debate. */
export interface DebateRound {
  round: number;
  bull_claims: DebateClaim[];
  bear_claims: DebateClaim[];
  // ── DEBATE_STATE tracking (optional, additive) ──
  bull_responded_ids?: string[];
  bear_responded_ids?: string[];
  resolved_ids?: string[];
  unresolved_ids?: string[];
  next_focus_ids?: string[];
  round_summary?: string;
  round_goal?: string;
}

/**
 * Parsed DEBATE_STATE payload from an LLM debate turn.
 * Extracted from `<!-- DEBATE_STATE: {...} -->` JSON blocks.
 */
export interface DebateStatePayload {
  responded_claim_ids: string[];
  new_claims: { claim: string; evidence: string[]; confidence: number }[];
  resolved_claim_ids: string[];
  unresolved_claim_ids: string[];
  next_focus_claim_ids: string[];
  round_summary: string;
  round_goal: string;
}

/** Full Bull↔Bear debate result. */
export interface DebateResult {
  rounds: DebateRound[];
  bull_summary: string;
  bear_summary: string;
  /** 0-1, how well the debate converged (ratio of resolved claims, minus divergence penalty). */
  convergence_score: number;
  /** Resolved claim summaries across all rounds. */
  resolved_points: string[];
  total_tokens: number;
  total_cost_usd: number;
}

/** Research Manager scoring of the debate. */
export interface ResearchDecision {
  direction: "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
  confidence: number;
  bull_score: number;
  bear_score: number;
  reasoning: string;
  key_debate_points: string[];
  verdict: Verdict;
}

/** Trader execution plan with A-share specific constraints. */
export interface TradingPlan {
  direction: FinalDecision["direction"];
  target_price: number;
  stop_loss: number;
  position_pct: number;
  execution_plan: string;
  entry_signals: string[];        // 进场触发条件 (triggers — 等什么信号才动手)
  exit_signals: string[];
  invalidations: string[];        // 失效条件 (invalidations — 出现即推翻整个交易判断)
  key_risks: string[];
  t_plus_1_note: string;
}

/** One risk debater's argument. */
export interface RiskArgument {
  role: "aggressive" | "conservative" | "neutral";
  position: string;
  evidence: string[];
  verdict: "pass" | "revise" | "reject";
}

/** Three-way risk debate result. */
export interface RiskDebateResult {
  rounds: RiskArgument[][];
  risk_arguments: RiskArgument[];
  total_tokens: number;
  total_cost_usd: number;
}

/**
 * Parsed RISK_JUDGE payload from an LLM risk-manager turn.
 * Extracted from `<!-- RISK_JUDGE: {...} -->` JSON blocks.
 * Upgrades the binary pass/revise/reject gate into an actionable
 * constraint checklist that downstream consumers (esp. the trader on
 * revise-retry) can honor.
 */
export interface RiskJudge {
  verdict: "pass" | "revise" | "reject";
  reason: string;
  hard_constraints: string[];          // 硬约束（必须遵守，违反即视为不合规）
  soft_constraints: string[];          // 软建议（推荐但非强制）
  execution_preconditions: string[];   // 进场前提（满足后才动手）
  de_risk_triggers: string[];          // 降风险触发器（出现即减仓/重新评估）
  /**
   * 总仓位上限（%），权威数值。prompt 要求 LLM 在 RISK_JUDGE 里直接填这个数字，
   * resolveMaxPosition 优先读它；hard_constraints 文本里的"仓位≤20%"仅供人读，
   * 作为 fallback（旧解析器/LLM 未填数值字段时）。
   * undefined = 风控未给仓位上限 → position_pct 不被 cap（维持原值）。
   *
   * 反转了之前的"文本为主、不设数值字段防漂移"设计（risk.ts 旧注释）：数值字段
   * 为单一权威源，反而消除了"正则漏匹配→cap 静默失效"的系统性风险（600600 真实回归）。
   */
  max_position_pct?: number;
  /**
   * 止损价下限（元），权威数值。同 max_position_pct：prompt 直填，orchestrator
   * 优先读它；hard_constraints 文本里的"止损价≥60.5元"降为 fallback。
   * undefined = 风控未给止损下限 → stop_loss 不被上调（维持原值）。
   */
  min_stop_loss?: number;
}

/** Risk Manager final assessment. */
export interface RiskAssessment {
  status: "pass" | "revise" | "reject";
  /** Structured constraints from RISK_JUDGE block (undefined when LLM emits only VERDICT). */
  judge?: RiskJudge;
  revised_plan?: TradingPlan;
  reasoning: string;
  risk_score: number;
  max_position_override?: number;
  /**
   * True when the revise loop exited because max_risk_retries was hit while
   * risk_manager kept returning "revise". The status field is left honest
   * ("revise") rather than silently flipped to "pass" — downstream consumers
   * (dashboard badge, report formatter) already handle the revise state, and
   * `final.risk_assessment` propagates it. The flag lets audits distinguish
   * "clean pass" from "gave up revising".
   */
  retries_exhausted?: boolean;
}

/** Full analysis result with debate and risk layers. */
export interface FullAnalysisResult {
  ticker: string;
  date: string;
  mode: "full";
  analysts: AnalystReport[];
  debate: DebateResult;
  research_decision: ResearchDecision;
  trading_plan: TradingPlan;
  risk_debate: RiskDebateResult;
  risk_assessment: RiskAssessment;
  final: FinalDecision;
}

/** Quality gate result for a single analyst report. */
export interface QualityGrade {
  role: string;
  grade: "A" | "B" | "C" | "D" | "F";
  issues: string[];
}

/** Quality gate summary for all analyst reports. */
export interface QualitySummary {
  grades: QualityGrade[];
  failed_count: number;
  warn_count: number;
  summary_text: string;
}

/**
 * LLM Layer-2 quality review of analyst reports (data-credibility lens).
 * Parsed from `<!-- QUALITY_REVIEW: {...} -->` JSON. Catches semantic issues
 * the deterministic Layer-1 gate cannot (fabrication, stale data, internal
 * inconsistency). null/undefined when the review is skipped (≥4 hard-fails) or
 * the LLM call fails — downstream then relies on Layer-1 grades only.
 */
export interface QualityReview {
  credibility: "高" | "中" | "低";
  note: string;
  stale_reports: string[];          // roles whose data looks stale/outdated
  fabrication_suspects: string[];   // roles with suspicious/unsupported numbers
}

/**
 * A single stage in the provenance chain — records the decision flow through
 * the pipeline so a reviewer can trace how the final decision was derived
 * without reading through all detail files. Deterministic (built from pipeline
 * data, not LLM output).
 */
export interface ProvenanceStage {
  /** Pipeline stage name */
  stage: "analysts" | "portfolio_manager" | "debate" | "research" | "trader" | "risk";
  /**
   * Human-readable summary of the key decision from this stage.
   * e.g. "2看多/0看空/1中性", "Buy (80%)", "Bull 70 vs Bear 40",
   * "Overweight (75%)", "Buy target=1400 stop=1200 pos=25%", "pass (35/100)"
   */
  key_decision: string;
  /** Relative path to detail file(s) within the detail directory. */
  detail_ref?: string;
}

/** Metadata about an analysis run for auditing */
export interface RunMeta {
  run_id: string;
  trace_dir: string;
  duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  llm_call_count: number;
  warnings?: FallbackWarning[];
  pipeline_health?: PipelineIssue[];
}