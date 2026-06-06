# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-06

### Added

**Phase 1: MVP**
- OpenClaw plugin entry point with `trading_quick` and `trading_report` tools
- K-line data fetching via mootdx (primary) and akshare (fallback)
- Market analyst + Portfolio Manager prompt templates
- Report persistence with JSON storage
- LLM call tracing for auditing

**Phase 2: Multi-Analyst**
- 7 specialized analyst prompts (market, fundamentals, news, sentiment, policy, hot_money, lockup)
- 7 data skill scripts covering major A-share analysis dimensions
- Parallel analyst execution in orchestrator
- Sector ranking data skill

**Phase 3: Debate Pipeline**
- Bull↔Bear multi-round adversarial debate module (`src/debate.ts`)
- Research Manager with 5-tier direction scoring (`src/research-manager.ts`)
- Trader module with A-share execution plan (T+1, price limits) (`src/trader.ts`)
- 3-way risk debate (aggressive/conservative/neutral) (`src/risk.ts`)
- Risk Manager with pass/revise/reject flow and revise loop
- Full analysis pipeline orchestration (`runFullAnalysis()`)
- `trading_full` tool registration
- Report storage with directory structure (`ReportStore.saveFull`)
- 6 debate/research/trader/risk prompt templates

**Phase 4: Prompt & Data Fixes**
- Fixed VERDICT format in all 14 prompt templates — explicit single-value direction instructions with correct/incorrect examples
- Created `policy.py` data script (Eastmoney search + CLS macro telegrams)
- Robust LLM output parsing: pipe-separator fallback, flexible markdown regex, Chinese direction aliases
- 30s timeout on Python script execution to prevent hanging
- 50 unit and integration tests (vitest)
