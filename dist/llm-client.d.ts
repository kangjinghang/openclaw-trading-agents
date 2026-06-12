import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { LLMCallTrace } from "./types";
/** Cost per 1M tokens (input, output) */
export declare const MODEL_COSTS: Record<string, {
    input: number;
    output: number;
}>;
export interface LLMCallOptions {
    model: string;
    systemPrompt: string;
    userMessage: string;
    temperature?: number;
    maxTokens?: number;
    phase: LLMCallTrace["phase"];
    role: string;
    traceLogger: TraceLogger;
}
export interface LLMCallResult {
    content: string;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    costUsd: number;
    traceId: string;
}
/**
 * Make an LLM chat completion call, record trace, and return result.
 * Automatically retries up to LLM_MAX_RETRIES times if the response content is empty.
 * Each attempt has a timeout of LLM_TIMEOUT_MS to prevent indefinite hangs.
 */
export declare function callLLM(client: OpenAI, options: LLMCallOptions): Promise<LLMCallResult>;
/**
 * Extract verdict from LLM output.
 *
 * Extraction strategy (in priority order):
 * 1. VERDICT tag: <!-- VERDICT: {"direction": "...", "reason": "..."} -->
 * 2. Explicit patterns: "最终裁决：买入", "方向：看空", "核心定性：持有"
 * 3. Keyword scan: look for direction keywords in the first 20 lines
 *
 * Returns null only if no direction signal can be found at all.
 */
export declare function parseVerdict(content: string): {
    direction: string;
    reason: string;
} | null;
//# sourceMappingURL=llm-client.d.ts.map