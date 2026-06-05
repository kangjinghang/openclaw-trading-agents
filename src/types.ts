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
  analyst: AnalystReport;
  final: FinalDecision;
}

/** Summary JSON saved to trading-reports/ */
export interface AnalysisReport {
  id: string;
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
  call_index: number;
  phase: "analyst" | "debate" | "trader" | "risk" | "portfolio";
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
  data?: any;
  error?: string;
  _source?: string;
}