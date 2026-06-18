# 路线图

[English](roadmap.md) | 中文

## 当前进度：Phase 1-4 已完成

### Phase 1：MVP

插件入口 + K 线数据技能 + 市场分析师 + 投资组合经理 Prompt + 报告持久化 + LLM 溯源。

### Phase 2：多分析师

7 个数据技能 + 7 个分析师 Prompt + 并行执行。

| 技能 | 数据内容 |
|------|---------|
| `trading-kline` | K 线 OHLCV（mootdx → akshare） |
| `trading-fundamentals` | PE/PB/ROE/财务数据（腾讯 + mootdx + 东方财富） |
| `trading-news` | 个股新闻 + 宏观新闻（东方财富 + 财联社） |
| `trading-sentiment` | 市场情绪（东方财富） |
| `trading-policy` | 政策事件（东方财富 + 财联社） |
| `trading-hot-money` | 北向资金/主力资金/龙虎榜（东方财富 + 同花顺） |
| `trading-lockup` | 解禁/减持（东方财富 + mootdx） |
| `trading-sector` | 行业排名 + 概念板块（东方财富 + 百度） |

### Phase 3：辩论管道

| 模块 | 文件 | 说明 |
|------|------|------|
| 多空辩论 | `src/debate.ts` | N 轮多空对抗辩论 |
| 研究经理 | `src/research-manager.ts` | 辩论评分 + 5 级方向决策 |
| 交易员 | `src/trader.ts` | A 股交易执行计划（T+1、涨跌停） |
| 风控辩论 | `src/risk.ts` | 三方风险辩论（激进/保守/中性） |
| 风控经理 | `src/risk.ts` | pass/revise/reject + revise 回路 |
| 完整管道 | `src/orchestrator.ts` | `runFullAnalysis()` — 15+ 次 LLM 调用 |
| 报告存储 | `src/report-store.ts` | `saveFull()` 目录结构存储 |

### Phase 4：Prompt 修复 + 数据补齐

- 修复 14 个 Prompt 模板的 VERDICT 格式 — 明确单值指令
- 新建 `policy.py` 数据脚本
- 健壮的 LLM 输出解析（管道分隔符 fallback、灵活正则）
- 50 个测试通过，端到端验证通过（glm-4-flash）

---

## 股票池自动维护（已实现）

独立于单股分析的子系统，每日扫描雪球异动维护候选股池：

| 阶段 | 内容 | 状态 |
|------|------|------|
| 第一期 | 分层管道（universe/raw/diff/derived）+ 雪球异动全扫 + diff + 候选排序 | ✅ 已完成 |
| 交易日处理 | data_date 驱动（解决节假日/盘中跑错数据）+ 幂等 + raw 不可变 | ✅ 已完成（2026-06-18） |
| 保留策略 | raw 膨胀（32M/天≈8GB/年）→ 留 N 天 + gzip | ⏳ 未来（暂不处理，当前 64M） |
| 第二期 | LLM 行业归类、板块共振聚合、全自动 cron 调度 | ⏳ 待规划 |

设计：[`superpowers/specs/2026-06-17-watchlist-stock-pool-design.md`](superpowers/specs/2026-06-17-watchlist-stock-pool-design.md) + [`superpowers/specs/2026-06-18-trading-day-handling-design.md`](superpowers/specs/2026-06-18-trading-day-handling-design.md)

---

## Phase 5：待规划

| # | 方向 | 说明 |
|---|------|------|
| 1 | 多标的组合分析 | 同时分析多只股票，输出组合配置建议 |
| 2 | 历史回测 | 用历史数据验证分析质量，优化参数 |
| 3 | OpenClaw 集成增强 | 定时任务、通知推送、对话式交互 |
| 4 | 数据源增强 | Level2 行情、融资融券、ETF 资金流 |
| 5 | 多模型策略 | 不同阶段用不同质量模型，优化成本 |

---

## 延期深度设计（待规划，已落档）

以下两项为架构性改动，**已写实现级深度设计文档**，后期立项时直接参考：

| 项 | 说明 | 深度设计 |
|---|------|---------|
| **跨次 per-agent 记忆（P3）** | 每次"情境→决策→结果"存档，下次检索相关历史经验注入 prompt，形成跨次学习闭环 | [design/deferred-memory-and-reflection.zh.md](design/deferred-memory-and-reflection.zh.md) §3 |
| **自我反思（P2-a）** | 两种形态：in-run 决策一致性校验（可先做，不依赖记忆）+ cross-run 复盘（依赖 P3 记忆） | [design/deferred-memory-and-reflection.zh.md](design/deferred-memory-and-reflection.zh.md) §4 |

> 这两项与上面 Phase 5 的"历史回测""多模型策略"互补：记忆需要 outcome 回录（≈历史回测），反思的跨次复盘以记忆为落点。

---

## 快速参考

| 变什么 | 改哪里 |
|-------|--------|
| 数据 API 变了 | `skills/trading-*/scripts/*.py` |
| 新增数据源 | 新建 Skill + 更新 manifest |
| 调整分析师 prompt | `skills/trading-analysis/prompts/analysts/*.md` |
| 调整辩论 prompt | `skills/trading-analysis/prompts/debate/*.md` |
| 编排流程调整 | `src/orchestrator.ts` |
| 新增工具 | `src/index.ts` 注册新 tool |
| 调换 LLM 模型 | config.json 配置 |
