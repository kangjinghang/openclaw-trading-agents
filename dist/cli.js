"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
const openai_1 = __importDefault(require("openai"));
const orchestrator_1 = require("./orchestrator");
const errors_1 = require("./errors");
const constants_1 = require("./constants");
const report_formatter_1 = require("./report-formatter");
/** Parse CLI arguments into a structured object. Throws on invalid input. */
function parseArgs(argv) {
    const args = argv;
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        throw Object.assign(new Error("USAGE"), { code: "USAGE" });
    }
    const mode = args[0];
    if (mode !== "quick" && mode !== "full") {
        throw new Error(`mode must be "quick" or "full", got "${mode}"`);
    }
    const ticker = args[1];
    if (!ticker || !/^\d{6}$/.test(ticker)) {
        throw new Error("ticker must be a 6-digit stock code (e.g. 600519)");
    }
    let date;
    let debateRounds = 2;
    let riskDebateRounds = 1;
    let model = "gpt-4o";
    let reportDir = "./trading-reports";
    let format = "json";
    for (let i = 2; i < args.length; i++) {
        if (args[i] === "--debate-rounds" && args[i + 1]) {
            debateRounds = parseInt(args[++i], 10);
        }
        else if (args[i] === "--risk-debate-rounds" && args[i + 1]) {
            riskDebateRounds = parseInt(args[++i], 10);
        }
        else if (args[i] === "--model" && args[i + 1]) {
            model = args[++i];
        }
        else if (args[i] === "--report-dir" && args[i + 1]) {
            reportDir = args[++i];
        }
        else if (args[i] === "--format" && args[i + 1]) {
            format = args[++i];
        }
        else if (!date && /^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
            date = args[i];
        }
    }
    if (!date) {
        date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    }
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY environment variable is required.");
    }
    return {
        mode,
        ticker,
        date,
        format,
        config: {
            models: { analyst: model, debater: model, decision: model, risk: model },
            debate_rounds: debateRounds,
            risk_debate_rounds: riskDebateRounds,
            max_risk_retries: 1,
            report_dir: reportDir,
            llm_concurrency: constants_1.DEFAULT_LLM_CONCURRENCY,
        },
    };
}
// ── Main entry (only runs when executed directly, not when imported for testing) ──
if (require.main === module) {
    const args = process.argv.slice(2);
    let parsed;
    try {
        parsed = parseArgs(args);
    }
    catch (err) {
        if (err.code === "USAGE") {
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
  --format <fmt>           Output format: json (default), md, html

Environment:
  OPENAI_API_KEY    Required. Your LLM API key.
  OPENAI_BASE_URL   Optional. For OpenAI-compatible APIs.

Examples:
  node dist/cli.js quick 600519
  node dist/cli.js full 600519 2026-06-05
  OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/ node dist/cli.js quick 600519
`);
            process.exit(0);
        }
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
    const { mode, ticker, date: analysisDate, config, format } = parsed;
    async function main() {
        const client = new openai_1.default();
        console.error(`\n  OpenClaw Trading Agents — ${mode.toUpperCase()} mode`);
        console.error(`  Ticker: ${ticker}  Date: ${analysisDate}`);
        console.error(`  Model: ${config.models.analyst}  Debate rounds: ${config.debate_rounds}`);
        console.error(`  Report dir: ${config.report_dir}\n`);
        // Graceful shutdown: abort analysis on Ctrl+C
        const controller = new AbortController();
        let shutdownCount = 0;
        const shutdownHandler = () => {
            shutdownCount++;
            if (shutdownCount === 1) {
                console.error("\n  正在完成当前阶段，请稍候... (再按一次强制退出)");
                controller.abort();
            }
            else {
                console.error("\n  强制退出");
                process.exit(130);
            }
        };
        process.on("SIGINT", shutdownHandler);
        process.on("SIGTERM", shutdownHandler);
        const startTime = Date.now();
        try {
            const [result, meta] = mode === "quick"
                ? await (0, orchestrator_1.runQuickAnalysis)(ticker, analysisDate, config, client, controller.signal)
                : await (0, orchestrator_1.runFullAnalysis)(ticker, analysisDate, config, client, controller.signal);
            const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
            console.error(`\n  Completed in ${durationSec}s`);
            console.error(`  Run ID:    ${meta.run_id}`);
            console.error(`  Traces:    ${meta.trace_dir}`);
            console.error(`  LLM calls: ${meta.llm_call_count}  Tokens: ${meta.total_tokens.toLocaleString()}  Cost: $${meta.total_cost_usd.toFixed(4)}`);
            if (format === "md") {
                console.log((0, report_formatter_1.toMarkdown)(result));
            }
            else if (format === "html") {
                console.log((0, report_formatter_1.toHtml)(result));
            }
            else {
                console.log(JSON.stringify(result, null, 2));
            }
        }
        catch (err) {
            if (err instanceof errors_1.AbortError) {
                console.error(`\n  分析已取消 (Ctrl+C)`);
                process.exit(130);
            }
            if (err instanceof errors_1.EnvironmentError) {
                console.error(`\n  环境错误: ${err.message}`);
                process.exit(1);
            }
            console.error(`\n  Error: ${err.message}`);
            process.exit(1);
        }
        finally {
            process.removeListener("SIGINT", shutdownHandler);
            process.removeListener("SIGTERM", shutdownHandler);
        }
    }
    main();
}
//# sourceMappingURL=cli.js.map