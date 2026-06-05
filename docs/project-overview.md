# Project Overview — openclaw-trading-agents

## What We're Building

一个独立的、可分享的 GitHub 项目，通过 OpenClaw 的 Plugin + Skill 机制集成多角色 A 股分析能力。用户 clone 后一条命令安装，不修改 OpenClaw 源码。

**核心价值**：多个专业化 AI Agent 协作分析 A 股，通过辩论机制产出结构化交易决策，支持 Telegram/钉钉等渠道交互。

## Background — How We Got Here

### 参考项目研究

深入研究了 4 个 A 股交易 Agent 项目：

| 项目 | 特点 |
|------|------|
| **TradingAgents-astock** | 深度 A 股定制，7 分析师（含政策/游资/解禁独有角色），最全免费数据源 (mootdx/东方财富/新浪/腾讯) |
| **TradingAgents-AShare** | Claim-based 结构化辩论，博弈论经理，风控经理 pass/revise/reject，FastAPI+React |
| **TradingAgents-CN** | 企业级，多租户，MongoDB+Redis，tushare/akshare/baostock 多源可切换 |
| **PanWatch (盯盘侠)** | 实时监控，多模态 K 线分析 (Playwright + VLM)，盘中/盘前/日报 Agent |

**核心洞察**：这几个项目的最大价值 = **Prompt（领域知识）+ 数据源（基础设施）**。其余一切（Web 后端/调度/通知/用户管理）OpenClaw 已有。

### 平台选择：为什么是 OpenClaw 而不是 Hermes Agent

对比了两个 AI Agent 平台后选择了 OpenClaw：

| 对比项 | Hermes Agent (Python) | OpenClaw (TypeScript) |
|--------|----------------------|----------------------|
| 语言 | Python 3.11+ | TypeScript/Node.js |
| 多 Agent 路由 | delegate_task 单次任务 | 更灵活的多 Agent 路由 |
| 扩展机制 | Plugin/Skill/Tool | Plugin/Skill/Tool (类似) |
| 自学习能力 | ✅ 有 | 不需要（投资领域 Prompt 固定） |
| 部署 | 单实例，自带 gateway | 也比较方便 |
| **决定因素** | — | **原生 TS，多 Agent 更灵活，部署差异不大** |

### 用户偏好（从对话中提取）

- 主要关注 A 股市场
- 有自己的数据源（后期决定集成）
- 需要同时支持手动触发和 Cron 定时调度
- 不需要回测功能，只需要实时分析
- 通过 OpenClaw gateway（Telegram 等）交互
- 数据获取脚本和 OpenClaw 部署在同一台机器上
- 不同角色用同一个 Agent（Plugin 内部编排），而非每个角色一个 Agent 实例
- 数据获取脚本放在 Skill 内（方案 A）
- 数据脚本内置 fallback（主源挂了自动切备源）
- 需要报告持久化 + LLM 调用溯源
- 作为独立项目提交 GitHub，不修改 OpenClaw 源码

## Architecture

```
OpenClaw Gateway (Telegram/钉钉/Slack)
│
└── Plugin: trading-agents
    ├── Tool: trading_quick(ticker, date)
    │     → 编排: Python K线数据 → 市场分析师 LLM → 投资组合经理 LLM → 结构化决策
    ├── Tool: trading_report(ticker, date)
    │     → 查询历史分析报告
    └── Skills: 9 个 (通过 Plugin manifest 声明)
        ├── trading-kline       K线数据 (mootdx/akshare)
        ├── trading-fundamentals 基本面 (腾讯/mootdx)
        ├── trading-news        新闻 (财联社/东方财富)
        ├── trading-hot-money   游资/资金流向 (东方财富/akshare)
        ├── trading-sentiment   情绪 (同花顺/东方财富)
        ├── trading-policy      政策 (财联社/东方财富)
        ├── trading-lockup      解禁 (东方财富/akshare)
        ├── trading-sector      行业排名 (东方财富/akshare)
        └── trading-analysis    编排层 (16 个角色的 prompt 模板)
```

### 分层设计

| 层级 | 变更频率 | 说明 |
|------|---------|------|
| **Plugin 层** (TypeScript) | 极少 | 注册工具 + 编排流程 + 调 LLM API |
| **Skill 层** (Python) | 中等 | 数据获取脚本 + fallback，改接口只改 .py 文件 |
| **Prompt 层** (.md) | 中等 | 角色提示词模板，调优只改 .md 文件 |

### 编排流程 (trading_analyze 完整 5 阶段)

```
Phase 1: 分析师报告（7 并行 LLM 调用）
  → 每个分析师: 原始数据注入 prompt → LLM → 报告 + VERDICT

Phase 2: 研究辩论（4-5 次 LLM 调用）
  → Bull ↔ Bear 多轮辩论 (默认 2 轮, Claim-based 追踪)
  → Research Manager 裁决 → 投资方案

Phase 3: 交易员（1 次 LLM 调用）
  → 基于 Research Manager 方案 + A 股交易约束

Phase 4: 风险辩论（3-4 次 LLM 调用）
  → Aggressive ↔ Conservative ↔ Neutral 三方辩论
  → Risk Manager: pass / revise / reject
  → revise → 回到 Phase 3 (最多 1 次)

Phase 5: 投资组合经理（1 次 LLM 调用）
  → 综合所有信息 → 最终交易信号
```

LLM 调用次数: 完整分析 ~18 次, 快速分析 ~2 次

## Tech Stack

- **Plugin**: TypeScript, OpenClaw Plugin SDK
- **Data Scripts**: Python 3.11+, mootdx, akshare, pandas
- **LLM**: OpenAI-compatible API (gpt-4o, claude-sonnet 等)
- **Testing**: vitest (TS), pytest (Python)
- **Build**: tsc → dist/

## Related Projects

| 项目 | 路径 | 说明 |
|------|------|------|
| OpenClaw | `~/workspace/github/openclaw` | 目标平台 |
| TradingAgents-astock | `~/workspace/github/TradingAgents-astock` | A 股定制版，最全数据源 |
| TradingAgents-AShare | `~/workspace/github/TradingAgents-AShare` | Claim-based 辩论 |
| TradingAgents-CN | `~/workspace/github/TradingAgents-CN` | 企业级 |
| PanWatch | `~/workspace/github/PanWatch` | 实时监控 |

## Reference Docs Location

原始调研文档保存在：
- `~/.claude/projects/-Users-kangjinghang-workspace-github-hermes-agent/memory/trading-agents-reference.md`
- `~/.claude/projects/-Users-kangjinghang-workspace-github-hermes-agent/memory/trading-agents-integration-plan.md`
- `~/workspace/github/openclaw/docs/superpowers/specs/2026-06-05-trading-agents-integration-design.md`
- `~/workspace/github/openclaw/docs/superpowers/plans/2026-06-05-trading-agents-phase1.md`
