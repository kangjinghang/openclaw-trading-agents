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

## Watchlist Auto-Maintenance (Implemented)

A subsystem independent of single-stock analysis: daily scans of Xueqiu market anomalies to maintain a candidate pool, then LLM ranks and rebalances it into actionable portfolio plans:

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 | Layered pipeline (universe/raw/diff/derived) + Xueqiu anomaly scan + diff + candidate ranking | ✅ Done |
| Trading-day handling | `data_date` driven (handles holidays/intraday), idempotent, raw immutable | ✅ Done (2026-06-18) |
| Phase 2-L4 | LLM precision ranker (LONG/SHORT split + forced distribution + anti-fuzzy-word), 178 candidates → top-15 | ✅ Done (2026-06-21) |
| Phase 2-L5 | Portfolio Rebalancer (ranker top-N + holdings → BUY/SELL/ADD/REDUCE/HOLD, 11 hard constraints + revise loop + formula-driven sizing) | ✅ Done (2026-06-23, see [`rebalancer-pipeline.zh.md`](rebalancer-pipeline.zh.md)) |
| Fitness backtest | Decision-snapshot capture + lazy-settled ex-post returns, validates fitness predictive power | ✅ Done (2026-06-23, scaffolding stage; stats after 1 month) |
| Phase 2-other | LLM industry classification, sector-resonance aggregation, full cron scheduling | ⏳ Planned |
| Retention policy | raw bloat (32M/day ≈ 8GB/year) → keep N days + gzip | ⏳ Future (deferred, currently 64M) |

Design: [`2026-06-17-watchlist-stock-pool-design.md`](superpowers/specs/2026-06-17-watchlist-stock-pool-design.md) + [`2026-06-18-trading-day-handling-design.md`](superpowers/specs/2026-06-18-trading-day-handling-design.md) + [`2026-06-18-llm-ranking-design.md`](superpowers/specs/2026-06-18-llm-ranking-design.md) + [`2026-06-21-stockpool-rebalancer-design.md`](superpowers/specs/2026-06-21-stockpool-rebalancer-design.md)

---

## Phase 5: Planned

| # | Direction | Description |
|---|-----------|-------------|
| 1 | Multi-stock portfolio | ✅ Delivered as watchlist L4-5 (ranker + rebalancer), see "Watchlist Auto-Maintenance" above |
| 2 | Historical backtest | 🟡 Foundation laid (fitness-backtest: decision snapshots + lazy-settled returns); full parameter backtest still pending |
| 3 | OpenClaw integration | Scheduled tasks, notifications, conversational interaction |
| 4 | Data source enhancement | Level-2 quotes, margin trading, ETF fund flow |
| 5 | Multi-model strategy | ✅ Delivered (analyst uses glm-5-turbo, decision/risk/review use glm-5.2), see [`architecture.md`](architecture.md) Config section |

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
