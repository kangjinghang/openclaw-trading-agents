# Roadmap — 实施路线图

## 当前进度：Phase 1-4 ✅ 全部完成

### Phase 1: MVP — 快速分析 ✅

**目标**：端到端跑通一个分析师 + 最终决策。

**已实现**：Plugin 入口 + K线数据技能 + 市场分析师/PM Prompt + 报告持久化 + LLM 溯源

---

### Phase 2: 补全分析师 ✅

**目标**：7 个分析师并行分析。

**已实现**：

| 文件 | 说明 |
|------|------|
| `skills/trading-kline/` | K 线 OHLCV (mootdx → akshare) |
| `skills/trading-fundamentals/` | PE/PB/ROE/财务数据 (腾讯 + mootdx + 东方财富) |
| `skills/trading-news/` | 个股新闻 + 宏观新闻 (东方财富 + 财联社) |
| `skills/trading-sentiment/` | 市场情绪 (东方财富) |
| `skills/trading-policy/` | 政策事件 (东方财富 + 财联社) |
| `skills/trading-hot-money/` | 北向资金/主力资金/龙虎榜 (东方财富 + 同花顺) |
| `skills/trading-lockup/` | 解禁/减持 (东方财富 + mootdx) |
| `skills/trading-sector/` | 行业排名 + 概念板块 (东方财富 + 百度) |
| 7 个分析师 Prompt | `skills/trading-analysis/prompts/analysts/*.md` |

---

### Phase 3: 辩论管道 ✅

**目标**：完整的多空辩论 + 研究 + 交易 + 风控管道。

**已实现**：

| 模块 | 文件 | 说明 |
|------|------|------|
| Bull/Bear 辩论 | `src/debate.ts` | N 轮多空对抗辩论 |
| Research Manager | `src/research-manager.ts` | 辩论评分 + 5 级方向决策 |
| Trader | `src/trader.ts` | A 股交易执行计划 (T+1, 涨跌停) |
| Risk Debate | `src/risk.ts` | 3 方风险辩论 (激进/保守/中性) |
| Risk Manager | `src/risk.ts` | pass/revise/reject + revise 回路 |
| Full 编排 | `src/orchestrator.ts` | `runFullAnalysis()` 15+ LLM 调用 |
| 报告存储 | `src/report-store.ts` | `saveFull()` 目录结构存储 |
| Prompt 模板 | `skills/trading-analysis/prompts/debate/*.md` | 6 个辩论/研究/交易/风控 Prompt |

**LLM 调用链**：7 分析师 → 2N 辩论 → 1 研究 → 1 交易 → 3 风险辩论 → 1 风控经理 = 15+ 次

---

### Phase 4: Prompt 修复 + policy.py ✅

**目标**：修复 VERDICT 格式 + 补齐缺失数据脚本。

**已实现**：

- 14 个 Prompt 模板的 VERDICT 格式从 `"看多|看空|中性"` 修复为明确单值指令 + 正确/错误示例
- 新增 `skills/trading-policy/scripts/policy.py`（东方财富搜索 + 财联社宏观快讯）
- 端到端验证通过（600519 茅台，glm-4-flash，0 个管道分隔错误）

---

## Phase 5: 待规划

可能的后续方向：

| # | 方向 | 说明 |
|---|------|------|
| 1 | 多标的组合分析 | 同时分析多只股票，输出组合配置建议 |
| 2 | 历史回测 | 用历史数据验证分析质量，优化参数 |
| 3 | OpenClaw 集成增强 | 定时任务、通知推送、对话式交互 |
| 4 | 数据源增强 | Level2 行情、融资融券、ETF 资金流 |
| 5 | 多模型策略 | 不同阶段用不同质量模型，优化成本 |

---

## 变更场景速查

| 变什么 | 改哪里 |
|--------|--------|
| 数据 API 变了 | `skills/trading-*/scripts/*.py` |
| 新增数据源 | 新建 Skill + 更新 manifest |
| 调整分析师 prompt | `skills/trading-analysis/prompts/analysts/*.md` |
| 调整辩论 prompt | `skills/trading-analysis/prompts/debate/*.md` |
| 编排流程调整 | `src/orchestrator.ts` |
| 新增工具 | `src/index.ts` 注册新 tool |
| 调换 LLM 模型 | config.json 配置 |

---

## 如何继续工作

### 换电脑后

```bash
git clone <repo-url> openclaw-trading-agents
cd openclaw-trading-agents
npm install
pip install mootdx akshare requests
npm run build && npm test
```

### 关键参考文档

| 文档 | 位置 | 用途 |
|------|------|------|
| 项目指引 | `CLAUDE.md` | 架构、命令、关键文件 |
| 本文件 | `docs/roadmap.md` | 了解进度和下一步 |
| 快速恢复 | `docs/quick-resume.md` | 换电脑后第一个看的文件 |
| 项目概述 | `docs/project-overview.md` | 架构决策、平台选择背景 |
| 数据源参考 | `docs/data-sources-reference.md` | 所有数据源函数签名和 fallback |
| Prompt 参考 | `docs/prompts-reference.md` | 所有角色 Prompt 设计 |
| 设计文档 | `docs/design-spec.md` | 完整系统设计 |
| Phase 2 Spec | `docs/superpowers/specs/2026-06-05-phase2-multi-analyst-design.md` | 7 分析师设计 |
| Phase 3 Spec | `docs/superpowers/specs/2026-06-06-phase3-debate-design.md` | 辩论管道设计 |
| Phase 4 Spec | `docs/superpowers/specs/2026-06-06-phase4-prompt-datafix-design.md` | VERDICT 修复设计 |
