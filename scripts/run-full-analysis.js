// scripts/run-full-analysis.js — Run a full analysis from the CLI
//
// Usage:
//   node scripts/run-full-analysis.js <ticker> [mode]
//   node scripts/run-full-analysis.js 000661           # full analysis
//   node scripts/run-full-analysis.js 600519 quick     # quick analysis
//
// Requires dist/ built (npm run build) and env vars for the LLM provider:
//   OPENAI_API_KEY    API key
//   OPENAI_BASE_URL   Provider base URL (e.g. https://open.bigmodel.cn/api/coding/paas/v4)
//   TRADING_MODEL     Model name (default: gpt-4o)
//
// Example:
//   OPENAI_API_KEY=xxx OPENAI_BASE_URL=https://... TRADING_MODEL=GLM-5.1 \
//     node scripts/run-full-analysis.js 000661

const OpenAI = require("openai");

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const model = process.env.TRADING_MODEL || "gpt-4o";

if (!apiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is required");
  console.error("Set it before running, e.g.:");
  console.error("  OPENAI_API_KEY=your-key OPENAI_BASE_URL=https://... node scripts/run-full-analysis.js 000661");
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL });

const { runFullAnalysis, runQuickAnalysis } = require("../dist/orchestrator");

const config = {
  models: { analyst: model, debater: model, decision: model, risk: model },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: require("os").homedir() + "/.openclaw/trading-reports",
  llm_concurrency: 3,
};

const ticker = process.argv[2] || "000661";
const mode = process.argv[3] || "full";
const date = new Date().toISOString().split("T")[0];

const runFn = mode === "quick" ? runQuickAnalysis : runFullAnalysis;

console.error(`Running ${mode.toUpperCase()} analysis for ${ticker} on ${date}...`);
console.error(`Model: ${model}, Base URL: ${baseURL}`);

(async () => {
  try {
    const [result] = await runFn(ticker, date, config, client);
    console.log(JSON.stringify(result, null, 2));
    console.error(`\nDone! Direction: ${result.final?.direction}`);
  } catch (err) {
    console.error("Failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
