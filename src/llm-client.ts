// src/llm-client.ts

import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { LLMCallTrace, Verdict } from "./types";

/** Cost per 1M tokens (input, output) */
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
};

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
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  costUsd: number;
  traceId: string;
}

/** Generate a unique trace ID */
function generateTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Calculate cost in USD based on model and token usage */
function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const costs = MODEL_COSTS[model];
  if (!costs) {
    // Default to gpt-4o pricing if model not found
    const defaultCosts = MODEL_COSTS["gpt-4o"];
    return (
      (promptTokens / 1_000_000) * defaultCosts.input +
      (completionTokens / 1_000_000) * defaultCosts.output
    );
  }
  return (
    (promptTokens / 1_000_000) * costs.input +
    (completionTokens / 1_000_000) * costs.output
  );
}

/**
 * Make an LLM chat completion call, record trace, and return result
 */
export async function callLLM(
  client: OpenAI,
  options: LLMCallOptions
): Promise<LLMCallResult> {
  const {
    model,
    systemPrompt,
    userMessage,
    temperature = 0.4,
    maxTokens = 4000,
    phase,
    role,
    traceLogger,
  } = options;

  const traceId = generateTraceId();
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature,
      max_tokens: maxTokens,
    });

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    const content = response.choices[0]?.message?.content || "";
    const usage = {
      prompt_tokens: response.usage?.prompt_tokens || 0,
      completion_tokens: response.usage?.completion_tokens || 0,
      total_tokens: response.usage?.total_tokens || 0,
    };

    const costUsd = calculateCost(
      model,
      usage.prompt_tokens,
      usage.completion_tokens
    );

    // Parse verdict from content
    const parsedVerdict = parseVerdict(content);

    // Record trace
    const trace: LLMCallTrace = {
      trace_id: traceId,
      call_index: traceLogger.count,
      phase,
      role,
      request: {
        model,
        system_prompt: systemPrompt,
        user_message: userMessage,
        temperature,
        max_tokens: maxTokens,
      },
      response: {
        raw_content: content,
        parsed_verdict: parsedVerdict || undefined,
      },
      meta: {
        timestamp,
        duration_ms: durationMs,
        usage,
        cost_usd: costUsd,
      },
    };

    traceLogger.record(trace);

    return {
      content,
      usage,
      costUsd,
      traceId,
    };
  } catch (error) {
    // Record error trace
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    const errorTrace: LLMCallTrace = {
      trace_id: traceId,
      call_index: traceLogger.count,
      phase,
      role,
      request: {
        model,
        system_prompt: systemPrompt,
        user_message: userMessage,
        temperature,
        max_tokens: maxTokens,
      },
      response: {
        raw_content: "",
        parsed_verdict: undefined,
      },
      meta: {
        timestamp,
        duration_ms: durationMs,
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        cost_usd: 0,
      },
    };

    traceLogger.record(errorTrace);

    throw error;
  }
}

/**
 * Extract verdict from LLM output.
 * Looks for <!-- VERDICT: {"direction": "...", "reason": "..."} -->
 */
export function parseVerdict(
  content: string
): { direction: string; reason: string } | null {
  const verdictRegex = /<!--\s*VERDICT:\s*(\{[^}]+\})\s*-->/;
  const match = content.match(verdictRegex);

  if (!match) {
    return null;
  }

  try {
    const verdict = JSON.parse(match[1]);

    if (typeof verdict.direction !== "string" || typeof verdict.reason !== "string") {
      return null;
    }

    return {
      direction: verdict.direction,
      reason: verdict.reason,
    };
  } catch {
    return null;
  }
}
