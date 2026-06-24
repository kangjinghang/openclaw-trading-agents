/** bench 配置文件根对象（对应 bench/*.json） */
export interface BenchConfig {
    name: string;
    note?: string;
    traces: {
        phase: "rank" | "rebalance";
        date?: string;
        roles?: string[];
        limit?: number;
    };
    repeats: number;
    providers: Record<string, BenchProvider>;
    configs: BenchConfigEntry[];
}
export interface BenchProvider {
    base_url: string;
    api_key: string;
}
export interface BenchConfigEntry {
    id: string;
    provider: string;
    model: string;
    thinking?: {
        type: string;
    };
    responseFormat?: {
        type: "json_object";
    };
    temperature?: number;
    max_tokens?: number;
}
/** 选中的 trace 元信息（回放前的快照） */
export interface SelectedTrace {
    file: string;
    path: string;
    role: string;
    phase: "rank" | "rebalance";
    ticker: string;
    baseline_duration_ms: number;
    baseline_parsed: ParsedOutput;
}
/** 单次回放调用的结果 */
export interface BenchCallResult {
    trace_file: string;
    config_id: string;
    repeat: number;
    ok: boolean;
    duration_ms: number;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    cost_usd: number;
    raw_content: string;
    parsed: ParsedOutput;
    error?: string;
}
/** LLM 输出的解析结果。_parse_ok=false 表示 JSON 解析失败。
 *  字段是 rank/shallow 三类输出的并集，按实际输出取用。 */
export interface ParsedOutput {
    _parse_ok: boolean;
    ranked?: Array<{
        ticker: string;
        score: number;
    }>;
    fitness_score?: number;
    thesis?: string;
    overall_risk?: string;
    risk_flags?: Array<{
        flag: string;
        severity: string;
    }>;
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
    success_rate: number;
    success_count: number;
    expected_calls: number;
    duration_median_ms: number | null;
    duration_p90_ms: number | null;
    prompt_tokens_median: number | null;
    completion_tokens_median: number | null;
    parse_success_rate: number;
    total_cost_usd: number;
}
/** 单个 (config × trace) 的稳定性统计 */
export interface StabilityStats {
    config_id: string;
    trace_file: string;
    numeric_cv: number | null;
    mode_consistency: number | null;
    deal_breaker_true_rate: number | null;
    topk_consistency: number | null;
    baseline_score_diff: number | null;
    distribution: Record<string, number>;
}
//# sourceMappingURL=bench-types.d.ts.map