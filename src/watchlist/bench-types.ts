// src/watchlist/bench-types.ts
//
// LLM bench 工具的类型定义。配置（输入）+ 结果（单次调用）+ 统计（聚合）。
// 纯类型文件，无运行时逻辑。

/** bench 配置文件根对象（对应 bench/*.json） */
export interface BenchConfig {
  name: string;
  note?: string;
  traces: {
    phase: "rank" | "rebalance";
    date?: string;          // 缺省取该 phase 最新日期
    roles?: string[];       // 按 trace 文件名前缀（=role）过滤
    limit?: number;         // 最多取 N 个 trace
  };
  repeats: number;
  providers: Record<string, BenchProvider>;
  configs: BenchConfigEntry[];
}

export interface BenchProvider {
  base_url: string;
  api_key: string;          // 支持 "$ENV" 前缀读环境变量
}

export interface BenchConfigEntry {
  id: string;
  provider: string;         // 引用 providers 的 key
  model: string;
  thinking?: { type: string };
  responseFormat?: { type: "json_object" };
  temperature?: number;
  max_tokens?: number;
}

/** 选中的 trace 元信息（回放前的快照） */
export interface SelectedTrace {
  file: string;             // 文件名（不含目录）
  path: string;             // 完整路径
  role: string;
  phase: "rank" | "rebalance";
  ticker: string;           // 从 user_message 提取；rank 标 role 名，提不出标 "unknown"
  baseline_duration_ms: number;
  baseline_parsed: ParsedOutput;   // trace 原始输出的解析字段
}

/** 单次回放调用的结果 */
export interface BenchCallResult {
  trace_file: string;
  config_id: string;
  repeat: number;
  ok: boolean;
  duration_ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost_usd: number;
  raw_content: string;
  parsed: ParsedOutput;
  error?: string;
}

/** LLM 输出的解析结果。_parse_ok=false 表示 JSON 解析失败。
 *  字段是 rank/shallow 三类输出的并集，按实际输出取用。 */
export interface ParsedOutput {
  _parse_ok: boolean;
  // rank
  ranked?: Array<{ ticker: string; score: number }>;
  // shallow analyst
  fitness_score?: number;
  thesis?: string;
  // shallow risk
  overall_risk?: string;
  risk_flags?: Array<{ flag: string; severity: string }>;
  deal_breaker?: boolean;
}

/** results.json 根对象 */
export interface BenchResults {
  bench_name: string;
  config_path: string;
  started_at: string;
  finished_at: string;
  trace_count: number;
  repeats: number;
  config_count: number;
  total_calls: number;
  traces: Array<Omit<SelectedTrace, "path">>;
  results: BenchCallResult[];
}

/** 单个 config 的聚合统计 */
export interface ConfigStats {
  config_id: string;
  success_rate: number;           // 0-1
  success_count: number;
  expected_calls: number;
  duration_median_ms: number | null;
  duration_p90_ms: number | null;
  prompt_tokens_median: number | null;
  completion_tokens_median: number | null;
  parse_success_rate: number;     // 0-1
  total_cost_usd: number;
}

/** 单个 (config × trace) 的稳定性统计 */
export interface StabilityStats {
  config_id: string;
  trace_file: string;
  // analyst: fitness CV；risk: flag 数量 CV；rank: null（用 top-K）
  numeric_cv: number | null;
  // risk: overall_risk 众数一致率；其余: null
  mode_consistency: number | null;
  // rank: top-3 一致率；其余: null
  topk_consistency: number | null;
  // rank: 与 baseline 分数差均值；其余: null
  baseline_score_diff: number | null;
  // 分布快照（值 → 出现次数），用于报告逐样本块
  distribution: Record<string, number>;
}
