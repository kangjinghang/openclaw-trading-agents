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
- 质量门输出持久化（`src/report-store.ts`）：`saveQualitySummary` 把 Layer-1 grades + Layer-2 review 落盘到 `{detailDir}/00_quality.json`，在质量门算完立即写（不等后续阶段），mid-run 崩了也留审计。此前这块数据算完只注入 prompt 就丢，post-run 只能去 trace 里翻 prompt 输入
- 格式化报告自动落盘（`src/report-store.ts`）：`save` / `saveFull` 末尾调 `toMarkdown` / `toHtml` 写 `{detailDir}/report.md` + `report.html`，与 JSON 产物并列。此前 `report-formatter.ts` 写得很完整但只在 `cli.ts` 里 stdout，`run-full-analysis.js` 不调它，每次看干净报告得重跑 CLI 重定向
- dashboard 渲染结构化字段（`dashboard/index.html`）：详情 tab 新增数据质量门控卡片（Layer-1 A-F 等级 badge 网格 + Layer-2 可信度 badge + 陈旧/可疑捏造 chip）、风控 RISK_JUDGE 4 类约束（硬约束/软建议/进场前提/降风险触发，颜色区分）、trader invalidations、retries_exhausted 警示 badge。此前这些字段只存 JSON 不显示，dashboard 只 grep 到 entry_signals
- trace 文件名加 role 前缀（`src/trace-logger.ts`，commit `b033907`）：`${trace_id}.json` → `${role}-${trace_id}.json`（如 `trader-*.json`），`06_traces` 目录一眼可辨角色，不必逐个开文件 grep role。唯一性靠 trace_id 而非 call_index——后者 run 内非唯一（并行调用在 `record()` 自增前读 `traceLogger.count`，同 index+role 会撞名覆盖丢数据）

**文档**
- `docs/pipeline-deep-dive.zh.md`：流程深度解读（~1000 行），面向初学者的通俗 + 深度讲解。10 章 + 术语表，覆盖公共底座、数据层、双层质量门、Quick 终点、多空辩论状态机、研究经理、交易员、风控辩论 + revise 循环、设计哲学。每章用生活比喻引入，再讲实现细节与设计权衡

### Fixed

- `_fetch_consensus_eps` 三个 bug：无效 `sortColumns` 致 `success=False` / `"result": null` 崩溃 / 字段名错误（§3.2）
- `_fetch_quarterly_financials` 同族三个 bug（sibling to §3.2）
- trader entry/exit/invalidations/key_risks 静默为空（`src/trader.ts`）：`parseListSection` 匹配 bare heading，但 LLM 实际输出编号 + 括号标题（`### 3. 入场信号（triggers — …）`），测试 fixtures 给假信心。改用 TRADER_PLAN JSON 块作主路径
- trader Buy/Sell 价格镜像（`trader.md`）：Sell 方向时目标价/止损价措辞是 Buy 视角，LLM 填 0，risk.ts 误触发一轮 revise。三方向都强制填具体数值
- revise 重试耗尽的诚实标注（`src/orchestrator.ts`，commit `6b6dc86`）：超过 `max_risk_retries` 仍 revise 时，旧逻辑强制翻转为 pass，但内层 `judge.verdict` 仍是 revise、reasoning 仍是"禁止建仓"，报告自相矛盾。改为保留 `status: "revise"` + 设置 `retries_exhausted: true`，下游消费者（dashboard/report-formatter/`FinalDecision`）本就处理 revise
- 质量门 sentinel 双检查（`src/quality-gate.ts`，commit `0bb2b63`）：Check 4 只数**不同**失败短语的数量，13 个 `[数据缺失: 新闻]` 哨兵只算"1 种"漏网（实跑 600600 拿了 A 级）。加 Check 4b 数哨兵**出现次数** ≥3 触发；`checkFieldCitations` 先 strip 哨兵再查关键词，避免哨兵里的字段名（如"新闻"）被当成"引用了该数据"
- 风控硬约束仓位 cap 未执行（`src/risk.ts` + `src/orchestrator.ts`）：`runRiskManager` 从未填 `max_position_override`（永远 undefined），orchestrator 只在 revise 回路内套 cap，回路外（一次通过 / 回路耗尽后）的最终 judge 不绑定最终计划——600600 看到 judge 说"总仓位≤10%"但 `position_pct` 仍为 15%。新增 `extractPositionCap` 从 `hard_constraints` 文本取最严 cap（跳过 `首批/首笔/分批/加仓` 子批次约束），回路外加一道 cap；零额外 LLM 成本，deterministic
- `extractPositionCap` 正则补 `持仓` 同义词 + `%` 必填（`src/risk.ts`）：复跑 600600 发现 LLM 这次吐的是"最终持仓≤30%"（上次是"总仓位≤10%"），`仓位`-only 正则漏匹配，cap 靠 trader 碰巧填同值才"看上去对"。改为 `(?:仓位|持仓)` 别名 + `%` 必填（必填同时排除"持仓量≤100万手"这类绝对数量约束，不会误当百分比 cap）
- trader position_pct 同义词兜底（`src/trader.ts`，commit `b45659f`）：提示词用 Buy 视角标签「建议仓位」，Sell/Hold 方向 LLM 改写为「减仓总量/减仓比例/总仓位」等，单标签 parser 匹配不到 → position_pct 落 0，同时让仓位 cap 绑定静默失效（cap < 0 永假）。新增 `parsePositionPct` 先试规范标签、为 0 则回退同义词；子批次标签（第一批/分批/加仓）不在表内不被误取。实跑 600600 完整 trader trace 验证 0→30
- saveFull 摘要 token/cost 写死 0（`src/report-store.ts` + `src/orchestrator.ts`，commit `e17f2a8`）：`saveQuick` 用 `totalTokens/totalCostUsd` 真值，`saveFull` 却硬编码 0，每个 full-mode 摘要 JSON 的 token/cost 都是假 0。数据本已算好（`traceLogger.totalTokens/.totalCostUsd` 跨所有 trace 累计，进度日志与 `run_summary.json` 已在用）。saveFull 签名加两参数对齐 saveQuick，调用点传 traceLogger 真值

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
