// src/cli.ts — Standalone CLI entry point (no OpenClaw required)
//
// Usage:
//   node dist/cli.js quick 600519
//   node dist/cli.js quick 600519 2026-06-05
//   node dist/cli.js full 600519
//   node dist/cli.js full 600519 --debate-rounds 3
//
// Environment variables:
//   OPENAI_API_KEY   — Required. Your LLM API key.
//   OPENAI_BASE_URL  — Optional. For OpenAI-compatible APIs (e.g. ZhiPu, DeepSeek).

import OpenAI from "openai";
import { runQuickAnalysis, runFullAnalysis } from "./orchestrator";
import { TradingAgentsConfig } from "./types";

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
OpenClaw Trading Agents — Standalone CLI

Usage:
  node dist/cli.js <mode> <ticker> [date] [options]

Modes:
  quick    Quick analysis (8 LLM calls)
  full     Full analysis with debate + risk (15+ LLM calls)

Options:
  --debate-rounds <n>      Number of debate rounds (default: 2)
  --risk-debate-rounds <n> Number of risk debate rounds (default: 1)
  --model <name>           Use this model for all roles (default: gpt-4o)
  --report-dir <path>      Save reports to this directory (default: ./trading-reports)

Environment:
  OPENAI_API_KEY    Required. Your LLM API key.
  OPENAI_BASE_URL   Optional. For OpenAI-compatible APIs.

Examples:
  node dist/cli.js quick 600519
  node dist/cli.js full 600519 2026-06-05
  OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/ node dist/cli.js quick 600519
`);
}

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printUsage();
  process.exit(0);
}

const mode = args[0];
if (mode !== "quick" && mode !== "full") {
  console.error(`Error: mode must be "quick" or "full", got "${mode}"`);
  printUsage();
  process.exit(1);
}

const ticker = args[1];
if (!ticker || !/^\d{6}$/.test(ticker)) {
  console.error("Error: ticker must be a 6-digit stock code (e.g. 600519)");
  process.exit(1);
}

// Parse optional arguments
let date: string | undefined;
let debateRounds = 2;
let riskDebateRounds = 1;
let model = "gpt-4o";
let reportDir = "./trading-reports";

for (let i = 2; i < args.length; i++) {
  if (args[i] === "--debate-rounds" && args[i + 1]) {
    debateRounds = parseInt(args[++i], 10);
  } else if (args[i] === "--risk-debate-rounds" && args[i + 1]) {
    riskDebateRounds = parseInt(args[++i], 10);
  } else if (args[i] === "--model" && args[i + 1]) {
    model = args[++i];
  } else if (args[i] === "--report-dir" && args[i + 1]) {
    reportDir = args[++i];
  } else if (!date && /^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
    date = args[i];
  }
}

if (!date) {
  date = new Date().toISOString().split("T")[0];
}

// Validate API key
if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is required.");
  console.error("  export OPENAI_API_KEY=your-api-key");
  console.error("  For OpenAI-compatible APIs, also set OPENAI_BASE_URL.");
  process.exit(1);
}

const config: TradingAgentsConfig = {
  models: {
    analyst: model,
    debater: model,
    decision: model,
    risk: model,
  },
  debate_rounds: debateRounds,
  risk_debate_rounds: riskDebateRounds,
  max_risk_retries: 1,
  report_dir: reportDir,
};

async function main() {
  const client = new OpenAI();
  const analysisDate = date!;

  console.error(`\n  OpenClaw Trading Agents — ${mode.toUpperCase()} mode`);
  console.error(`  Ticker: ${ticker}  Date: ${analysisDate}`);
  console.error(`  Model: ${model}  Debate rounds: ${debateRounds}`);
  console.error(`  Report dir: ${reportDir}\n`);

  const startTime = Date.now();

  try {
    const result =
      mode === "quick"
        ? await runQuickAnalysis(ticker, analysisDate, config, client)
        : await runFullAnalysis(ticker, analysisDate, config, client);

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n  Completed in ${durationSec}s`);

    // Output result to stdout as JSON
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(`\n  Error: ${err.message}`);
    process.exit(1);
  }
}

main();
