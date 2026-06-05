# Roadmap — 实施路线图

## 当前进度：Phase 1 ✅ 完成

### Phase 1: MVP — 快速分析（已完成）

**目标**：端到端跑通一个分析师 + 最终决策。`/quick 600519` 能返回分析结果。

**已完成的内容**：

| 文件 | 说明 |
|------|------|
| `src/types.ts` | 所有 TypeScript 接口定义 |
| `src/exec-python.ts` | Python 脚本执行工具 |
| `src/prompt-loader.ts` | Prompt 模板加载器 ({{placeholder}} 渲染) |
| `src/llm-client.ts` | OpenAI-compatible LLM API 封装 |
| `src/trace-logger.ts` | LLM 调用溯源记录 |
| `src/report-store.ts` | 报告持久化存储 |
| `src/orchestrator.ts` | 快速分析编排 (K线→分析师→PM) |
| `src/index.ts` | Plugin 入口 (trading_quick + trading_report) |
| `skills/trading-kline/` | K 线数据技能 (mootdx/akshare fallback) |
| `skills/trading-analysis/` | 分析编排技能 (市场分析师 + PM prompt) |
| `scripts/setup-python.sh` | Python 环境安装脚本 |
| `config/openclaw.example.json` | 配置示例 |
| `README.md` | 项目文档 |
| 测试文件 x6 | 25 个 TS 测试 + 19 个 Python 测试, 全部通过 |

**14 个 commits** (0d06e6b → 6404b1e)

**测试**：
```bash
npx vitest run          # 25 个 TypeScript 测试, 全部通过
python3 -m pytest tests/scripts/ -v   # 19 个 Python 测试, 全部通过
npx tsc                 # 编译无错误
```

---

## Phase 2: 补全分析师

**目标**：`/quick` 返回 7 个分析师的完整报告。

### Task 列表

| # | 任务 | 文件 |
|---|------|------|
| 1 | trading-fundamentals Skill | `skills/trading-fundamentals/scripts/fundamentals.py`, `financials.py`, `profit_forecast.py` |
| 2 | trading-news Skill | `skills/trading-news/scripts/news.py`, `global_news.py` |
| 3 | trading-hot-money Skill | `skills/trading-hot-money/scripts/northbound.py`, `fund_flow.py`, `dragon_tiger.py` |
| 4 | trading-sentiment Skill | `skills/trading-sentiment/scripts/hot_stocks.py` |
| 5 | trading-policy Skill | `skills/trading-policy/scripts/global_news.py` (复用 news 的宏观新闻) |
| 6 | trading-lockup Skill | `skills/trading-lockup/scripts/lockup.py`, `insider.py` |
| 7 | trading-sector Skill | `skills/trading-sector/scripts/industry_rank.py`, `concept_blocks.py` |
| 8 | 补全 6 个分析师 Prompt | `skills/trading-analysis/prompts/analysts/news.md`, `sentiment.md`, `fundamentals.md`, `policy.md`, `hot_money.md`, `lockup.md` |
| 9 | 更新 orchestrator | 并行调用 7 个分析师 (Promise.all) |
| 10 | 更新 prompt 模板变量 | 每个分析师注入对应数据 |
| 11 | 更新 Plugin manifest | 添加新 skills 到 openclaw.plugin.json |
| 12 | 补充测试 | 每个 Python 脚本的单元测试 |

### 新增目录结构

```
skills/
├── trading-fundamentals/
│   ├── SKILL.md
│   └── scripts/
│       ├── fundamentals.py      PE/PB/市值/季报 (腾讯→mootdx)
│       ├── financials.py        三大报表 (新浪→mootdx)
│       ├── profit_forecast.py   机构一致预期 (同花顺, 无fallback)
│       └── requirements.txt
├── trading-news/
│   ├── SKILL.md
│   └── scripts/
│       ├── news.py              个股新闻 (财联社→东方财富)
│       ├── global_news.py       宏观新闻 (财联社→东方财富)
│       └── requirements.txt
├── trading-hot-money/
│   ├── SKILL.md
│   └── scripts/
│       ├── northbound.py        北向资金 (东方财富→akshare)
│       ├── fund_flow.py         资金流向 (东方财富→akshare)
│       ├── dragon_tiger.py      龙虎榜 (东方财富→akshare)
│       └── requirements.txt
├── trading-sentiment/
│   ├── SKILL.md
│   └── scripts/
│       ├── hot_stocks.py        涨停股+题材 (同花顺→东方财富)
│       └── requirements.txt
├── trading-policy/
│   ├── SKILL.md
│   └── scripts/
│       └── global_news.py       复用 trading-news 的宏观新闻
├── trading-lockup/
│   ├── SKILL.md
│   └── scripts/
│       ├── lockup.py            解禁日历 (东方财富→akshare)
│       ├── insider.py           内部人交易 (mootdx→东方财富)
│       └── requirements.txt
└── trading-sector/
    ├── SKILL.md
    └── scripts/
        ├── industry_rank.py     行业排名 (东方财富→akshare)
        ├── concept_blocks.py    概念板块 (百度→东方财富)
        └── requirements.txt
```

---

## Phase 3: 加入辩论机制

**目标**：`/analyze` 返回含 Bull ↔ Bear 辩论的分析。

| # | 任务 |
|---|------|
| 1 | 多头研究员 Prompt (`prompts/researchers/bull.md`) |
| 2 | 空头研究员 Prompt (`prompts/researchers/bear.md`) |
| 3 | 研究经理 Prompt (`prompts/researchers/research_manager.md`) |
| 4 | 实现 Claim 追踪机制 (ID + evidence + confidence + resolved) |
| 5 | 实现辩论循环 (Bull ↔ Bear N 轮, 默认 2 轮) |
| 6 | 交易员 Prompt (`prompts/trader.md`) |
| 7 | 实现 `trading_analyze` 完整编排 (Phase 1-3) |
| 8 | 注册 `trading_analyze` tool |

**LLM 调用**：Phase 1 (7次并行) → Phase 2 (4-5次辩论) → Phase 3 (1次交易员) = ~13次

---

## Phase 4: 加入风控

**目标**：完整 5 阶段决策，含 revise 回路。

| # | 任务 |
|---|------|
| 1 | 激进风控 Prompt (`prompts/risk/aggressive.md`) |
| 2 | 保守风控 Prompt (`prompts/risk/conservative.md`) |
| 3 | 中性风控 Prompt (`prompts/risk/neutral.md`) |
| 4 | 风控经理 Prompt (`prompts/risk/risk_manager.md`) |
| 5 | 实现风险辩论循环 (三方, 默认 1 轮) |
| 6 | 实现 revise 回路 (revise → 回 Phase 3, 最多 1 次) |
| 7 | 实现 reject 路径 (直接跳到 Phase 5) |

**LLM 调用**：~18 次 (完整分析)

---

## Phase 5: 生产化

| # | 任务 |
|---|------|
| 1 | Cron 定时任务配置 (盘前 08:50 / 盘后 15:10) |
| 2 | 通知格式优化 (Telegram/钉钉消息模板) |
| 3 | 错误处理 + 重试机制 |
| 4 | 日志系统 (结构化日志) |
| 5 | 数据缓存策略 (基本面缓存 1 天, 三大报表缓存 7 天等) |
| 6 | 对比分析工具 (`trading_compare`) |
| 7 | 多策略 Agent 实例 (默认/短线/价值) |
| 8 | CI/CD 配置 |

---

## 变更场景速查

| 变什么 | 改哪里 | 需要重启 OpenClaw |
|--------|--------|------------------|
| 东方财富接口变了 | `skills/trading-*/scripts/*.py` | ❌ |
| 限流策略调整 | 同上 .py 文件 | ❌ |
| 新增一个数据源 | 新建 Skill + 更新 manifest | ❌ |
| 调整分析师 prompt | `skills/trading-analysis/prompts/*.md` | ❌ |
| 编排流程调整 | `src/orchestrator.ts` 等 TS 代码 | ✅ |
| 新增分析策略 | 新建 Agent 实例 + 配置 | 不需要改 Plugin |
| 调换 LLM 模型 | openclaw.json 配置 | ❌ |

---

## 如何继续工作

### 换电脑后的步骤

```bash
# 1. Clone 项目
git clone <repo-url> openclaw-trading-agents
cd openclaw-trading-agents

# 2. 安装依赖
npm install
./scripts/setup-python.sh

# 3. 验证环境
npx tsc                    # 编译
npx vitest run             # TS 测试
python3 -m pytest tests/scripts/ -v  # Python 测试

# 4. 继续开发 (从 Phase 2 开始)
# 参见本文件 Phase 2 部分
```

### 关键参考文档

| 文档 | 位置 | 用途 |
|------|------|------|
| 本文件 | `docs/roadmap.md` | 了解进度和下一步 |
| 项目概述 | `docs/project-overview.md` | 架构决策、平台选择背景 |
| 数据源参考 | `docs/data-sources-reference.md` | 所有数据源函数签名和 fallback |
| Prompt 参考 | `docs/prompts-reference.md` | 所有角色 Prompt 设计 |
| 设计文档 | `~/workspace/github/openclaw/docs/superpowers/specs/2026-06-05-trading-agents-integration-design.md` | 完整设计 spec |
| Phase 1 计划 | `~/workspace/github/openclaw/docs/superpowers/plans/2026-06-05-trading-agents-phase1.md` | Phase 1 详细实现步骤 (已完成) |
| 原始调研 | `~/.claude/projects/-Users-kangjinghang-workspace-github-hermes-agent/memory/` | 4 个 TradingAgents 项目调研 |

### 开发建议

1. **每个 Skill 用子 agent 并行开发** — 参照 Phase 1 的 subagent-driven-development 模式
2. **先写数据脚本 + 测试，再写 Prompt** — 数据先行
3. **Prompt 参照 `docs/prompts-reference.md`** — 从 TradingAgents 项目提取的完整 Prompt 框架
4. **每个 Phase 提交一个计划文件** — 便于跟踪和回溯
