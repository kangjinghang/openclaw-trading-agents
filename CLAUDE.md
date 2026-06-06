# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Trading Agents is an OpenClaw plugin implementing multi-agent debate-driven A-share stock analysis. It supports two modes:
- **Quick mode** (`trading_quick`) — 8 LLM calls: 7 analysts → portfolio manager
- **Full mode** (`trading_full`) — 15+ LLM calls: 7 analysts → Bull/Bear debate → Research Manager → Trader → 3-way Risk Debate → Risk Manager

## Commands

```bash
npm install            # Install Node.js dependencies
npm run build          # Compile TypeScript (tsc) → dist/
npm test               # Run all tests (vitest run)
npm run test:watch     # Run tests in watch mode
```

Run a single test file:
```bash
npx vitest run tests/ts/integration.test.ts
```

## Architecture

### Data Flow (Quick Mode)

```
User → trading_quick → src/orchestrator.ts → runQuickAnalysis()
  → exec-python.ts → kline.py + 6 other data scripts (parallel)
  → prompt-loader.ts → render analyst prompts from templates
  → llm-client.ts → 7 analyst LLM calls (parallel) → parseVerdict()
  → llm-client.ts → portfolio manager LLM call → parseVerdict()
  → report-store.ts → save report JSON
  → trace-logger.ts → write per-call LLM traces
```

### Data Flow (Full Mode)

```
User → trading_full → src/orchestrator.ts → runFullAnalysis()
  → runAnalystPhase() → same as Quick Mode Phase 1 (7 analysts)
  → debate.ts → runBullBearDebate() → N rounds Bull↔Bear debate
  → research-manager.ts → runResearchManager() → 5-tier direction + scores
  → trader.ts → runTrader() → A-share execution plan (T+1, 涨跌停板)
  → risk.ts → runRiskDebate() → 3-way parallel risk debate
  → risk.ts → runRiskManager() → pass/revise/reject (with retry loop)
  → report-store.ts → saveFull() → structured directory layout
```

### Key Source Files

- **src/index.ts** — Plugin entry point. Registers `trading_quick`, `trading_full`, `trading_report` tools.
- **src/orchestrator.ts** — `runQuickAnalysis()` (8 LLM calls) and `runFullAnalysis()` (15+ LLM calls). `runAnalystPhase()` is shared Phase 1 logic.
- **src/llm-client.ts** — `callLLM()` wraps OpenAI chat completions. Tracks token usage and cost per model. `parseVerdict()` extracts `<!-- VERDICT: {...} -->` HTML comments from LLM output.
- **src/exec-python.ts** — Spawns `python3` child processes for data scripts with 30s timeout. Returns `ScriptResult` (JSON parsed stdout or error).
- **src/prompt-loader.ts** — Loads `.md` template files and replaces `{{key}}` placeholders.
- **src/debate.ts** — `runBullBearDebate()` — multi-round Bull↔Bear adversarial debate. Parses BULL-N/BEAR-N claims from LLM output.
- **src/research-manager.ts** — `runResearchManager()` — scores debate (0-100 each side), outputs 5-tier direction (Strong Buy / Buy / Hold / Sell / Strong Sell).
- **src/trader.ts** — `runTrader()` — generates A-share execution plan with target price, stop loss, position size. Maps Overweight→Buy, Underweight→Sell.
- **src/risk.ts** — `runRiskDebate()` (3-way: aggressive/conservative/neutral) + `runRiskManager()` (pass/revise/reject). Revise loop retries Trader→Risk up to `max_risk_retries`.
- **src/report-store.ts** — `saveQuick()` and `saveFull()` persist JSON reports. Full mode uses directory layout: `01_analysts/*.json`, `02_debate/round_N.json`, `03_research.json`, `04_trading_plan.json`, `05_risk/*.json`.
- **src/trace-logger.ts** — Writes per-call LLM traces (phase, role, tokens, cost, raw output) for auditing.

### Skills Directory

- **skills/trading-kline/** — `kline.py` fetching A-share K-line data (mootdx primary, akshare fallback).
- **skills/trading-fundamentals/** — `fundamentals.py` fetching financial data (mootdx).
- **skills/trading-news/** — `news.py` fetching stock news.
- **skills/trading-sentiment/** — `sentiment.py` market sentiment analysis.
- **skills/trading-policy/** — `policy.py` policy event analysis.
- **skills/trading-hot-money/** — `hot_money.py` tracking institutional/retail fund flows.
- **skills/trading-lockup/** — `lockup.py` lock-up expiry and insider trading data.
- **skills/trading-analysis/prompts/** — Prompt templates:
  - `analysts/market.md` through `analysts/lockup.md` — 7 analyst prompts
  - `portfolio_manager.md` — Portfolio manager decision prompt
  - `debate/bull_researcher.md`, `bear_researcher.md` — Debate prompts
  - `debate/research_manager.md` — Research manager prompt
  - `debate/trader.md` — Trader execution plan prompt
  - `debate/risk_debater.md`, `risk_manager.md` — Risk debate prompts

### Config

Plugin config lives at `~/.openclaw/plugins/trading-agents/config.json` (schema in `openclaw.plugin.json`). Key fields: `models` (analyst/debater/decision/risk), `debate_rounds`, `risk_debate_rounds`, `max_risk_retries`, `report_dir`. Defaults are in `src/index.ts`.

### Types

All interfaces are in `src/types.ts`: `TradingAgentsConfig`, `AnalystReport`, `FinalDecision`, `QuickAnalysisResult`, `FullAnalysisResult`, `AnalysisReport`, `LLMCallTrace`, `ScriptResult`, `DebateResult`, `ResearchDecision`, `TradingPlan`, `RiskAssessment`.

### Verdict Protocol

LLM outputs embed `<!-- VERDICT: {"direction": "Buy|Hold|Sell", "reason": "..."} -->` HTML comments. `parseVerdict()` in llm-client.ts extracts these. `parseDirection()` in orchestrator.ts maps Chinese/English direction names to canonical `Buy`/`Hold`/`Sell`.

## Development Notes

- **TypeScript**: strict mode, ES2020 target, CommonJS modules, declaration + source maps enabled.
- **Testing**: Vitest with globals enabled, node environment. Tests in `tests/ts/**/*.test.ts`. Tests mock external deps (LLM calls, file system, Python processes).
- **Python**: Data scripts require `mootdx>=0.5.7` and `akshare>=1.15`. Python dependencies installed via `scripts/setup-python.sh`.
- **No linter** is configured — there is no ESLint or Prettier setup.
