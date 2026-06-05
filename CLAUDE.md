# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Trading Agents is an OpenClaw plugin implementing multi-agent debate-driven A-share stock analysis. It uses a two-phase pipeline: market analyst → portfolio manager, with LLM-based decision making and full call tracing.

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

### Data Flow

```
User → OpenClaw tool call → src/index.ts (plugin entry)
  → src/orchestrator.ts (coordinates pipeline)
    → skills/trading-kline/scripts/kline.py (fetches K-line data via mootdx/akshare)
    → src/prompt-loader.ts (renders {{var}} templates from skills/trading-analysis/prompts/)
    → src/llm-client.ts (OpenAI-compatible API calls with cost tracking)
    → src/report-store.ts (persists JSON reports to disk)
    → src/trace-logger.ts (writes per-call LLM traces for auditing)
```

### Key Source Files

- **src/index.ts** — Plugin entry point. Registers `trading_quick` and `trading_report` tools with OpenClaw's `api.registerTool()`. Resolves config with defaults.
- **src/orchestrator.ts** — `runQuickAnalysis()` is the main pipeline: fetch K-line data → analyst prompt → portfolio manager prompt → assemble result → save report.
- **src/llm-client.ts** — `callLLM()` wraps OpenAI chat completions. Tracks token usage and cost per model. `parseVerdict()` extracts `<!-- VERDICT: {...} -->` HTML comments from LLM output.
- **src/exec-python.ts** — Spawns `python3` child processes for data scripts. Returns `ScriptResult` (JSON parsed stdout or error). Has both low-level `execPython()` and convenience `execSkillScript()`.
- **src/prompt-loader.ts** — Loads `.md` template files and replaces `{{key}}` placeholders. Base directory defaults to `skills/trading-analysis/prompts/`.

### Skills Directory

Skills follow OpenClaw's skill convention. Each skill has a `SKILL.md` and a `scripts/` folder:

- **skills/trading-kline/** — Python script (`kline.py`) fetching A-share K-line data. Uses mootdx (TDX TCP protocol) as primary, akshare (Sina HTTP) as fallback.
- **skills/trading-analysis/** — Contains prompt templates in `prompts/`:
  - `analysts/market.md` — Market analyst system prompt
  - `portfolio_manager.md` — Portfolio manager decision prompt

### Config

Plugin config lives at `~/.openclaw/plugins/trading-agents/config.json` (schema in `openclaw.plugin.json`). Key fields: `models` (analyst/debater/decision/risk), `debate_rounds`, `report_dir`. Defaults are in `src/index.ts`.

### Types

All interfaces are in `src/types.ts`: `TradingAgentsConfig`, `AnalystReport`, `FinalDecision`, `QuickAnalysisResult`, `AnalysisReport`, `LLMCallTrace`, `ScriptResult`.

### Verdict Protocol

LLM outputs must embed `<!-- VERDICT: {"direction": "Buy|Hold|Sell", "reason": "..."} -->` for the system to parse decisions. The `parseDirection()` helper in orchestrator.ts maps Chinese/English direction names to the canonical `Buy`/`Hold`/`Sell` enum.

## Development Notes

- **TypeScript**: strict mode, ES2020 target, CommonJS modules, declaration + source maps enabled.
- **Testing**: Vitest with globals enabled, node environment. Tests in `tests/ts/**/*.test.ts`. Tests mock external deps (LLM calls, file system, Python processes).
- **Python**: The K-line data script requires `mootdx>=0.5.7` and `akshare>=1.15`. Python dependencies are installed via `scripts/setup-python.sh`.
- **No linter** is configured — there is no ESLint or Prettier setup.
