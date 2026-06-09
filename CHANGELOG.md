# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

**结构化输出协议**
- DEBATE_STATE 辩论状态追踪（`src/debate.ts`）：Bull/Bear 显式标记 resolved/unresolved claims，跨轮次累积，收敛辩论（§2.1）
- RISK_JUDGE 风控结构化约束（`src/risk.ts`）：4 类约束（硬约束 / 软建议 / 进场前提 / 降风险触发器），revise 回路注入 trader 修复盲重试（§2.2）
- TRADER_PLAN 交易信号 JSON 块（`src/trader.ts`）：entry/exit/invalidations/key_risks 结构化解析，解耦 markdown 标题格式（§2.4 sibling）
- QUALITY_REVIEW 数据可信度复核 JSON 块（`src/quality-review.ts`）：可信度 高/中/低 + stale/fabrication 名单，驱动 §4 Layer-2

**双层数据质量门（§4）**
- Layer-1 字段引用检查（`src/quality-gate.ts`）：每角色关键词表 + ≥3 数值引用兜底，零 LLM 成本抓"无视数据写水文"
- Layer-2 LLM 数据可信度复核（`src/quality-review.ts`）：+1 调用抓 fabrication / 陈旧数据 / 报告间矛盾，≥4 硬失败跳过、抛错降级，绝不阻塞管道
- 分析师数据缺失哨兵（7 个 `analysts/*.md`）：任一必采项确无数据必须标 `[数据缺失: 指标名]`，与 Layer-1 FAILURE_MARKERS 对齐

**数据层**
- 涨停情绪池 `zt_pool`（`sentiment.py`）：涨停家数 + 连板梯队分布 + 龙头高度 + 标的命中检测，A 股短线情绪温度计（§3.3）
- 板块资金流排名（`hot_money.py`）：行业板块主力净流入 inflow/outflow top8，板块轮动信号（§3.6）
- 一致预期 EPS / forward PE / PEG（`fundamentals.py`）：远期估值 Python 侧预计算（§3.2）
- 龙虎榜字段补齐（`hot_money.py`）：4→8 字段，与 ASHare 持平（§3.1）
- trader triggers / invalidations（`trader.md`）：入场信号 + 失效条件，区分正常退出与判断证伪（§2.4）
- 威科夫 / 量价理论框架塞入 `market.md`（§2.3）
- lockup 结构化公告事件（`lockup.py`）：东财 ann API 抓业绩预告/停牌/回购/增发/分红等，importance 0-3 分级，过滤解禁重复
- financial_health 派生比率（`fundamentals.py`）：商誉占比 / OCF 质量 / 杠杆与流动性趋势，~4 期预计算避免 LLM 算错

**Prompt 纪律（借鉴 TradingAgents-astock）**
- `decision_deep` 双层模型（`src/types.ts`）：research/risk 两个守门员角色可选走深推理模型，分析师/辩论/交易员留快档
- HOLD 反懒散闸门 + trader 方向锚定（`research_manager.md` / `trader.md`）：HOLD 需"无趋势/无资金/无催化剂"三条件全满足；trader 方向必须与研究经理一致
- 跨维度 TI 覆盖要求（`market.md`）：技术指标需跨 ≥3 of {趋势/动量/量能/波动}，防 cherry-pick 同维度指标
- 风险辩论三角色 A 股对称重述（`src/risk.ts`）：aggressive/conservative/neutral 每角色从一句话扩写为带反述/阈值/例子的整段框架

**工程稳健性**
- 数据抓取 retry/backoff（`http_helpers.py`）：`_with_retry` 指数退避（默认只重试 ConnectionError，不重试 Timeout，防撞爆 30s 脚本预算）+ `http_get` drop-in 替换裸 requests.get
- market 数据完整性检查（`src/orchestrator.ts`）：K 线 ≥50 行下限 + 日期新鲜度（gap>7 天），仅 market role，抓"看起来有数据实际是坏数据"

### Fixed

- `_fetch_consensus_eps` 三个 bug：无效 `sortColumns` 致 `success=False` / `"result": null` 崩溃 / 字段名错误（§3.2）
- `_fetch_quarterly_financials` 同族三个 bug（sibling to §3.2）
- trader entry/exit/invalidations/key_risks 静默为空（`src/trader.ts`）：`parseListSection` 匹配 bare heading，但 LLM 实际输出编号 + 括号标题（`### 3. 入场信号（triggers — …）`），测试 fixtures 给假信心。改用 TRADER_PLAN JSON 块作主路径
- trader Buy/Sell 价格镜像（`trader.md`）：Sell 方向时目标价/止损价措辞是 Buy 视角，LLM 填 0，risk.ts 误触发一轮 revise。三方向都强制填具体数值

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
