# Roadmap

English | [中文](roadmap.zh.md)

## Current Status: Phase 1-4 Complete

### Phase 1: MVP

Plugin entry + K-line data skill + Market Analyst + Portfolio Manager prompt + report persistence + LLM tracing.

### Phase 2: Multi-Analyst

7 data skills + 7 analyst prompts + parallel execution.

| Skill | Data |
|-------|------|
| `trading-kline` | K-line OHLCV (mootdx → akshare) |
| `trading-fundamentals` | PE/PB/ROE/Financials (Tencent + mootdx + Eastmoney) |
| `trading-news` | Stock news + Macro news (Eastmoney + CLS) |
| `trading-sentiment` | Market sentiment (Eastmoney) |
| `trading-policy` | Policy events (Eastmoney + CLS) |
| `trading-hot-money` | Northbound/Main force/Dragon-Tiger (Eastmoney + 10jqka) |
| `trading-lockup` | Lockup/Insider (Eastmoney + mootdx) |
| `trading-sector` | Industry ranking + Concept blocks (Eastmoney + Baidu) |

### Phase 3: Debate Pipeline

| Module | File | Description |
|--------|------|-------------|
| Bull/Bear Debate | `src/debate.ts` | N-round adversarial debate |
| Research Manager | `src/research-manager.ts` | Debate scoring + 5-tier direction |
| Trader | `src/trader.ts` | A-share execution plan (T+1, price limits) |
| Risk Debate | `src/risk.ts` | 3-way risk debate (aggressive/conservative/neutral) |
| Risk Manager | `src/risk.ts` | pass/revise/reject with revise loop |
| Full Pipeline | `src/orchestrator.ts` | `runFullAnalysis()` — 15+ LLM calls |
| Report Storage | `src/report-store.ts` | `saveFull()` with directory structure |

### Phase 4: Prompt & Data Fixes

- Fixed VERDICT format in all 14 prompt templates — explicit single-value instructions
- Created `policy.py` data script
- Robust LLM output parsing (pipe-separator fallback, flexible regex)
- 50 tests passing, end-to-end verified with glm-4-flash

---

## Phase 5: Planned

| # | Direction | Description |
|---|-----------|-------------|
| 1 | Multi-stock portfolio | Analyze multiple stocks simultaneously, output portfolio allocation |
| 2 | Historical backtest | Validate analysis quality with historical data |
| 3 | OpenClaw integration | Scheduled tasks, notifications, conversational interaction |
| 4 | Data source enhancement | Level-2 quotes, margin trading, ETF fund flow |
| 5 | Multi-model strategy | Use different quality models at different stages |

---

## Quick Reference

| What to change | Where |
|---------------|-------|
| Data API changed | `skills/trading-*/scripts/*.py` |
| Add new data source | Create new Skill + update manifest |
| Adjust analyst prompt | `skills/trading-analysis/prompts/analysts/*.md` |
| Adjust debate prompt | `skills/trading-analysis/prompts/debate/*.md` |
| Pipeline flow | `src/orchestrator.ts` |
| Add new tool | `src/index.ts` register new tool |
| Change LLM model | config.json |
