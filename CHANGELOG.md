# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

**结构化输出协议（P1）**
- DEBATE_STATE 辩论状态追踪（`src/debate.ts`）：Bull/Bear 显式标记 resolved/unresolved claims，跨轮次累积，收敛辩论（§2.1）
- RISK_JUDGE 风控结构化约束（`src/risk.ts`）：4 类约束（硬约束 / 软建议 / 进场前提 / 降风险触发器），revise 回路注入 trader 修复盲重试（§2.2）

**数据层**
- 涨停情绪池 `zt_pool`（`sentiment.py`）：涨停家数 + 连板梯队分布 + 龙头高度 + 标的命中检测，A 股短线情绪温度计（§3.3）
- 板块资金流排名（`hot_money.py`）：行业板块主力净流入 inflow/outflow top8，板块轮动信号（§3.6）
- 一致预期 EPS / forward PE / PEG（`fundamentals.py`）：远期估值 Python 侧预计算（§3.2）
- trader triggers / invalidations（`trader.md`）：入场信号 + 失效条件，区分正常退出与判断证伪（§2.4）
- 龙虎榜字段补齐（`hot_money.py`）：4→8 字段，与 ASHare 持平（§3.1）
- 威科夫 / 量价理论框架塞入 `market.md`（§2.3）

### Fixed

- `_fetch_consensus_eps` 三个 bug：无效 `sortColumns` 致 `success=False` / `"result": null` 崩溃 / 字段名错误（§3.2）
- `_fetch_quarterly_financials` 同族三个 bug（sibling to §3.2）

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
