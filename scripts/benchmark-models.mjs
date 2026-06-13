#!/usr/bin/env node
/**
 * Model Benchmark Script
 *
 * Reads real prompts from trace files, replays them with different model configs,
 * and compares speed + quality metrics.
 *
 * Usage:
 *   node scripts/benchmark-models.mjs
 *   node scripts/benchmark-models.mjs --trace-dir <path>
 *   node scripts/benchmark-models.mjs --roles market,news
 *   node scripts/benchmark-models.mjs --config A,B
 */

import OpenAI from "openai";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ─── Configuration ───────────────────────────────────────────────────────────

const API_KEY = "04449db5f1814765af8c57e083a41171.xEyPrpeMZ4OZGiTm";
const BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const DEFAULT_TRACE_DIR =
  join(homedir(), ".openclaw/trading-reports/600507/2026-06-12_quick/02_traces/run-mqb6l5rf-drdxk");

const MODELS = {
  "glm-4.7":         { label: "GLM-4.7" },
  "glm-5-turbo":     { label: "GLM-5-Turbo" },
  "glm-5.1":         { label: "GLM-5.1" },
  "glm-4.7-flashx":  { label: "GLM-4.7-FlashX" },
};

const CONFIGS = {
  A: { analyst: "glm-4.7",        pm: "glm-5.1",     thinking: null,     temp: 0.4, label: "baseline (4.7+5.1)" },
  B: { analyst: "glm-5-turbo",    pm: "glm-5-turbo", thinking: null,     temp: 0.4, label: "5-turbo all" },
  C: { analyst: "glm-5.1",        pm: "glm-5.1",     thinking: null,     temp: 0.4, label: "5.1 all" },
  D: { analyst: "glm-4.7-flashx", pm: "glm-5.1",     thinking: null,     temp: 0.4, label: "4.7-flashx analyst" },
  E: { analyst: "glm-5-turbo",    pm: "glm-5.1",     thinking: "disabled", temp: 0.4, label: "5-turbo no-think" },
};

// Roles to test (market = longest bottleneck, news = shortest, portfolio_manager = PM)
const DEFAULT_ROLES = ["market", "news", "portfolio_manager"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { traceDir: DEFAULT_TRACE_DIR, roles: DEFAULT_ROLES, configs: Object.keys(CONFIGS) };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--trace-dir" && args[i + 1]) opts.traceDir = args[++i];
    if (args[i] === "--roles" && args[i + 1]) opts.roles = args[++i].split(",");
    if (args[i] === "--config" && args[i + 1]) opts.configs = args[++i].split(",");
  }
  return opts;
}

function loadTracePrompts(traceDir, roles) {
  const files = readdirSync(traceDir).filter(f => f.includes("-trace-") && f.endsWith(".json"));
  const prompts = {};
  for (const file of files) {
    const raw = readFileSync(join(traceDir, file), "utf-8");
    const trace = JSON.parse(raw);
    const role = trace.role || trace.phase;
    if (roles.includes(role)) {
      prompts[role] = {
        system: trace.request.system_prompt,
        user: trace.request.user_message,
        baselineDuration: trace.meta.duration_ms,
        baselineTokens: trace.meta.usage.completion_tokens,
        baselineModel: trace.request.model,
      };
    }
  }
  return prompts;
}

function parseVerdict(content) {
  const match = content.match(/<!--\s*VERDICT:\s*(\{.*?\})\s*-->/s);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1]);
    if (obj.direction && typeof obj.direction === "string") return obj;
  } catch {}
  return null;
}

function countNumericCitations(content) {
  // Count specific numeric patterns like "32.81", "385,836", "4.29元"
  const matches = content.match(/\d+[\.,]?\d*[¥元%手万股]|[\d,]+[\s]*(手|股|元|%|万)/g);
  return matches ? matches.length : 0;
}

function countMissingDataSentinels(content) {
  const matches = content.match(/\[数据缺失[：:]\s*[^\]]+\]/g);
  return matches ? matches.length : 0;
}

async function callModel(client, model, system, user, temperature, thinking) {
  const startTime = Date.now();
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const body = { model, messages, temperature, max_tokens: 16000 };
  if (thinking) {
    body.thinking = { type: thinking };
  }

  const response = await client.chat.completions.create(body);
  const durationMs = Date.now() - startTime;

  const content = response.choices[0]?.message?.content || "";
  const usage = {
    prompt_tokens: response.usage?.prompt_tokens || 0,
    completion_tokens: response.usage?.completion_tokens || 0,
    total_tokens: response.usage?.total_tokens || 0,
  };

  return { content, durationMs, usage };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log("=== Model Benchmark ===\n");
  console.log(`Trace dir: ${opts.traceDir}`);
  console.log(`Roles:     ${opts.roles.join(", ")}`);
  console.log(`Configs:   ${opts.configs.join(", ")}\n`);

  const prompts = loadTracePrompts(opts.traceDir, opts.roles);
  const missingRoles = opts.roles.filter(r => !prompts[r]);
  if (missingRoles.length) {
    console.error(`WARNING: No traces found for roles: ${missingRoles.join(", ")}`);
  }

  const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
  const results = [];

  for (const configId of opts.configs) {
    const config = CONFIGS[configId];
    if (!config) { console.error(`Unknown config: ${configId}`); continue; }
    console.log(`\n--- Config ${configId}: ${config.label} ---`);

    for (const role of opts.roles) {
      const prompt = prompts[role];
      if (!prompt) continue;

      const model = role === "portfolio_manager" ? config.pm : config.analyst;
      const modelLabel = MODELS[model]?.label || model;

      try {
        console.log(`  [${configId}] ${role} → ${modelLabel} ...`);
        const result = await callModel(
          client, model, prompt.system, prompt.user, config.temp, config.thinking
        );

        const verdict = parseVerdict(result.content);
        const nums = countNumericCitations(result.content);
        const missing = countMissingDataSentinels(result.content);
        const toksPerS = result.usage.completion_tokens / (result.durationMs / 1000);
        const baselineRatio = (result.durationMs / prompt.baselineDuration * 100).toFixed(0);

        const quality = {
          verdictOk: verdict !== null,
          direction: verdict?.direction || "PARSE_FAIL",
          length: result.content.length,
          completionTokens: result.usage.completion_tokens,
          numericCitations: nums,
          missingSentinels: missing,
          empty: result.content.trim().length === 0,
        };

        results.push({
          configId, configLabel: config.label, role, model, modelLabel,
          ...result, ...quality, toksPerS, baselineRatio,
          baselineDuration: prompt.baselineDuration,
          baselineTokens: prompt.baselineTokens,
        });

        const verdictStr = quality.verdictOk ? quality.direction : "PARSE_FAIL";
        const speed = `${toksPerS.toFixed(0)} tok/s`;
        const ratio = `${baselineRatio}%`;
        console.log(`    → ${result.durationMs / 1000}s | ${result.usage.completion_tokens} tokens | ${speed} | baseline ${ratio} | verdict: ${verdictStr} | citations: ${nums}${quality.empty ? " | ⚠ EMPTY" : ""}`);
      } catch (err) {
        console.error(`    ✗ ERROR: ${err.message}`);
        results.push({
          configId, configLabel: config.label, role, model, modelLabel,
          error: err.message, durationMs: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          content: "", verdictOk: false, direction: "ERROR", length: 0, completionTokens: 0,
          numericCitations: 0, missingSentinels: 0, empty: true, toksPerS: 0, baselineRatio: "ERR",
          baselineDuration: prompts[role].baselineDuration, baselineTokens: prompts[role].baselineTokens,
        });
      }
    }
  }

  // ─── Summary Table ─────────────────────────────────────────────────────────
  console.log("\n\n=== RESULTS SUMMARY ===\n");

  // Per-role table
  for (const role of opts.roles) {
    console.log(`\n── Role: ${role} (baseline: ${prompts[role]?.baselineModel} ${prompts[role]?.baselineDuration / 1000}s) ──`);
    console.log("Config | Model          | Time   | Tokens | Speed    | vs Baseline | Verdict     | Citations | Quality");
    console.log("-------|----------------|--------|--------|----------|-------------|-------------|-----------|--------");
    for (const r of results.filter(r => r.role === role)) {
      const time = r.error ? " ERROR " : `${(r.durationMs / 1000).toFixed(1).padStart(5)}s`;
      const tokens = String(r.completionTokens).padStart(5);
      const speed = `${r.toksPerS.toFixed(0).padStart(3)} tok/s`;
      const ratio = r.error ? "  ERR " : `${r.baselineRatio.padStart(4)}%`;
      const verdict = r.error ? "ERROR" : (r.verdictOk ? r.direction.padEnd(4) : "FAIL").padEnd(11);
      const cits = String(r.numericCitations).padStart(3);
      const qualityFlag = r.empty ? "EMPTY" : r.error ? "ERR" : (r.verdictOk ? "OK" : "BAD");
      console.log(`  ${r.configId}   | ${r.modelLabel.padEnd(14)} | ${time} | ${tokens} | ${speed} | ${ratio}    | ${verdict} | ${cits}       | ${qualityFlag}`);
    }
  }

  // Save JSON results
  const outPath = join(opts.traceDir, "..", `benchmark-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
