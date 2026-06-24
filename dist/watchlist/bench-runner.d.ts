import OpenAI from "openai";
import { RateLimitCoordinator } from "../llm-client";
import type { BenchConfig, BenchProvider, SelectedTrace, BenchCallResult, BenchResults, ParsedOutput, ConfigStats, StabilityStats, BenchConfigEntry } from "./bench-types";
/**
 * 展开 api_key："$ENV" 前缀读环境变量，否则当字面量。
 * 环境变量未设时抛错（避免静默用空 key 调出 401）。
 */
export declare function expandApiKey(raw: string): string;
/**
 * 校验配置结构（不碰 key）：phase 合法、repeats>0、provider 引用存在。
 * 不展开 $ENV，所以 dry-run 也能用（无需真实 key）。
 */
export declare function validateConfigStructure(config: BenchConfig): void;
/**
 * 校验配置完整性 + 展开 $ENV。结构校验通过后，把每个 provider 的 api_key 展开。
 * 真实 run 用这个（强制 key 存在）；dry-run 用 validateConfigStructure。
 */
export declare function validateConfig(config: BenchConfig): Record<string, BenchProvider & {
    api_key: string;
}>;
/**
 * 从 LLM 原始输出提取 JSON 并解析为 ParsedOutput。
 * 容忍 ```json 围栏和前后噪声文本。解析失败返回 { _parse_ok: false }。
 */
export declare function parseOutput(rawContent: string): ParsedOutput;
/**
 * 从 shallow trace 的 user_message 提取 ticker（A 股 6 位代码）。
 * rank trace 不用此函数（多股摘要，用 role 标识）。
 */
export declare function extractTicker(userMessage: string): string;
/**
 * 按 phase/date/roles 选择 trace 文件，解析元信息。
 * phase=rank → scan/{date}/traces/；phase=rebalance → rebalance/{date}/traces/。
 * date 缺省取该 phase 下最新日期。
 */
export declare function selectTraces(watchlistDir: string, sel: {
    phase: "rank" | "rebalance";
    date?: string;
    roles?: string[];
    limit?: number;
}): SelectedTrace[];
/** 单次回放的入参（传给 caller） */
export interface BenchCallArgs {
    trace: SelectedTrace;
    config: BenchConfigEntry;
    configId: string;
    repeat: number;
}
/** 单次回放的返回（caller 实现生产=callLLM，测试=mock）。 */
export interface BenchCallOutcome {
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
/** 注入点：runner 不直接调 callLLM，由 CLI 注入（生产）或测试 mock。 */
export type BenchCaller = (args: BenchCallArgs) => Promise<BenchCallOutcome>;
/**
 * 回放执行器：对每个 trace × config × repeat 调 caller。
 * 失败不中断——单次失败记 ok:false，继续后续。
 * 不同 config 间并行（Promise.all），同 config 内 traces×repeats 串行
 * （caller 内部限流协调负责同 provider 退避）。
 */
export declare function runReplay(traces: SelectedTrace[], configs: BenchConfigEntry[], repeats: number, caller: BenchCaller): Promise<BenchCallResult[]>;
/**
 * 按 (config × trace) 聚合稳定性。按 trace.phase 和 role 决定用哪个指标：
 * - rank: topK 一致率 + baseline 分数差；numeric_cv/mode=null
 * - analyst-shallow: fitness_score 的 CV；topk/mode=null
 * - risk-shallow: overall_risk 众数一致率 + risk_flags 数量的 CV
 */
export declare function computeStability(configId: string, trace: SelectedTrace, calls: BenchCallResult[]): StabilityStats;
/**
 * 格式化 report.md：概览表 + 稳定性表 + 逐样本块。
 * 逐样本块只放分数网格，thesis/ranked 全文不贴（在 results.json）。
 */
export declare function formatReport(results: BenchResults, configStats: ConfigStats[], stability: StabilityStats[]): string;
/**
 * 生产用 caller：用 callLLM 回放单条 trace。
 * 给整个 run 一个临时 TraceLogger（写 tmpdir，仅满足 callLLM 签名，bench 不读其 trace）。
 * 同 provider 的 config 共享一个 RateLimitCoordinator（429 协调）。
 *
 * prompt 按 trace 文件名缓存（同一 trace 的所有 config × repeat 读同一份文件，
 * 不必每次重读 12KB 的 rank user_message）。
 */
export declare function makeCaller(clients: Record<string, OpenAI>, coordinators: Record<string, RateLimitCoordinator>): BenchCaller;
/**
 * bench 总入口：选 trace → 造 clients/coordinators → 回放 → 聚合 → 写产物。
 * 返回产物目录路径。dryRun=true 时只打印选中 trace 和调用数，不调 LLM。
 */
export declare function runBench(config: BenchConfig, configPath: string, watchlistDir: string, dryRun?: boolean): Promise<string | null>;
//# sourceMappingURL=bench-runner.d.ts.map