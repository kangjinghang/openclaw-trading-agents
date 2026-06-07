// src/types.ts

/** Configuration from openclaw.json plugins.entries.trading-agents.config */
export interface TradingAgentsConfig {
  models: {
    analyst: string;
    debater: string;
    decision: string;
    risk: string;
  };
  debate_rounds: number;
  risk_debate_rounds: number;
  max_risk_retries: number;
  report_dir: string;
  llm_concurrency: number;
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
}

/** Single LLM call trace for auditing */
export interface LLMCallTrace {
  trace_id: string;
  run_id?: string;
  call_index: number;
  phase: "analyst" | "debate" | "research" | "trader" | "risk_debate" | "risk" | "portfolio";
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
  };
}

/** Result from a Python data script */
export interface ScriptResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  _source?: string;
  vpa?: string;
  technical_indicators?: string;
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
}

/** One round of Bull↔Bear debate. */
export interface DebateRound {
  round: number;
  bull_claims: DebateClaim[];
  bear_claims: DebateClaim[];
}

/** Full Bull↔Bear debate result. */
export interface DebateResult {
  rounds: DebateRound[];
  bull_summary: string;
  bear_summary: string;
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
  entry_signals: string[];
  exit_signals: string[];
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

/** Risk Manager final assessment. */
export interface RiskAssessment {
  status: "pass" | "revise" | "reject";
  revised_plan?: TradingPlan;
  reasoning: string;
  risk_score: number;
  max_position_override?: number;
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

/** Metadata about an analysis run for auditing */
export interface RunMeta {
  run_id: string;
  trace_dir: string;
  duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  llm_call_count: number;
}