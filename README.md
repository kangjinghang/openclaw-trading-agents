# OpenClaw Trading Agents

多智能体辩论式 A 股分析系统 —— 基于 OpenClaw 插件框架

[![CI](https://github.com/kangjinghang/openclaw-trading-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/kangjinghang/openclaw-trading-agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-8A2BE2)](https://github.com/openclaw/openclaw)

[English](#english) | [中文](#中文)

---

## 中文

### 项目简介

OpenClaw Trading Agents 是一个 OpenClaw 插件，通过多个 AI Agent 协作分析 A 股市场。系统模拟真实投资团队的分析决策流程：7 位专业分析师并行分析 → 多空辩论 → 研究经理评分 → 交易员制定执行计划 → 三方风控辩论，最终产出结构化的交易决策。

### 核心特性

- **7 位分析师并行分析**：技术面、基本面、新闻、情绪、政策、资金面、解禁 — 覆盖 A 股主要分析维度
- **多空辩论机制**：Bull↔Bear 多轮对抗辩论，通过正反方论证提高决策质量
- **三方风控辩论**：激进/保守/中性三方独立评估，风控经理最终裁定
- **8 个数据源**：K 线、财务、新闻、情绪、政策、资金流向、解禁、行业排名
- **两种分析模式**：Quick（8 次 LLM 调用）和 Full（15+ 次 LLM 调用）
- **A 股特化**：T+1 约束、涨跌停限制、北向资金跟踪
- **完整溯源**：每次 LLM 调用均有 trace 记录，支持审计

### 系统架构

```
用户输入 → OpenClaw Tool Call
  ↓
┌─ 7 个数据脚本并行获取 ─────────────────────────────┐
│  kline.py  fundamentals.py  news.py  sentiment.py   │
│  policy.py  hot_money.py  lockup.py  sector.py      │
└──────────────────────────────────────────────────────┘
  ↓
┌─ Quick 模式 (8 LLM calls) ──────────────────────────┐
│  7 分析师并行分析 → 投资组合经理综合决策               │
└──────────────────────────────────────────────────────┘
  ↓ (或)
┌─ Full 模式 (15+ LLM calls) ─────────────────────────┐
│  7 分析师 → Bull↔Bear 辩论(N轮) → 研究经理评分       │
│  → 交易员执行计划 → 三方风控辩论 → 风控经理裁定       │
└──────────────────────────────────────────────────────┘
  ↓
结构化报告 + LLM Trace 持久化
```

### 安装

**方式一：OpenClaw 插件安装（推荐）**

```bash
# 从 GitHub 仓库安装
openclaw plugins install git:github.com/kangjinghang/openclaw-trading-agents

# 安装 Python 依赖（数据采集脚本需要）
pip install -r requirements.txt
```

**方式二：本地开发安装**

```bash
git clone https://github.com/kangjinghang/openclaw-trading-agents.git
cd openclaw-trading-agents

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖
pip install -r requirements.txt

# 构建 & 测试
npm run build
npm test

# 注册到 OpenClaw（link 模式，修改源码后自动生效）
openclaw plugins install --link .
```

> **说明**：`dist/` 目录已包含在 git 仓库中，`openclaw plugins install` 无需额外编译步骤。开发者修改 TypeScript 源码后需运行 `npm run build` 并提交更新后的 `dist/`。

### 配置 Trading Agent

安装插件后，建议创建专用的 trading agent 并配置权限：

```bash
# 1. 创建 agent
openclaw agents add trading --model zai/glm-5.1

# 2. 编辑配置（添加插件工具可见性 + 关闭执行审批）
openclaw config edit
```

在打开的配置文件中，找到 trading agent 条目，添加 `tools` 配置：

```json
{
  "id": "trading",
  "model": "zai/glm-5.1",
  "tools": {
    "alsoAllow": ["group:plugins"],
    "exec": { "host": "gateway", "security": "full", "ask": "off" }
  }
}
```

> **`alsoAllow: ["group:plugins"]`** — 让 agent 能看到插件注册的工具（`trading_quick`/`trading_full`/`trading_report`）
>
> **`exec.security: "full", ask: "off"`** — 关闭执行审批弹窗（可选，不设则每次命令需手动审批）

重启 gateway 使配置生效：`openclaw gateway restart`

> **Python 环境**：数据脚本需要 `requests`、`mootdx`、`akshare`、`pandas`。插件会**自动探测**已安装这些依赖的 Python（支持系统 Python、Homebrew、pyenv 等）。你也可以通过 `TRADING_PYTHON` 环境变量显式指定 Python 路径。
>
> **⚠️ 注意**：`openclaw agents delete` 会移除 agent 的 workspace 目录，请勿将 workspace 指向项目源码目录。

### 快速开始

```bash
# 设置 API Key
export OPENAI_API_KEY=your-api-key
# 可选：使用 OpenAI 兼容 API（智谱、DeepSeek 等）
# export OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/

# 独立 CLI 运行（无需 OpenClaw）
node dist/cli.js quick 600519
node dist/cli.js full 600519
```

### 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 是 | LLM API Key |
| `OPENAI_BASE_URL` | 否 | OpenAI 兼容 API 地址（智谱、DeepSeek、Moonshot 等） |

支持的 API 提供商：OpenAI、智谱 AI、DeepSeek、Moonshot、任何 OpenAI 兼容 API。

### 使用方法

**方式一：独立 CLI（推荐新手）**

```bash
# Quick 分析（8 次 LLM 调用）
node dist/cli.js quick 600519

# Full 分析（15+ 次 LLM 调用，含辩论 + 风控）
node dist/cli.js full 600519

# 指定日期
node dist/cli.js full 600519 2026-06-05

# 输出 Markdown 格式（适合阅读）
node dist/cli.js quick 600519 --format md

# 输出 HTML 格式（适合浏览器查看）
node dist/cli.js full 600519 --format html > report.html

# 指定模型和辩论轮次
node dist/cli.js full 600519 --model gpt-4o-mini --debate-rounds 3

# 保存报告到指定目录
node dist/cli.js quick 600519 --report-dir ./my-reports
```

**方式二：作为 OpenClaw 插件**

```bash
# 安装到 OpenClaw
openclaw plugins install --link .

# 配置
cp config/openclaw.example.json ~/.openclaw/plugins/trading-agents/config.json
```

通过 OpenClaw 调用三个工具：

| 工具 | LLM 调用数 | 说明 |
|------|-----------|------|
| `trading_quick` | 8 | 7 分析师并行 → PM 综合 |
| `trading_full` | 15+ | 完整辩论管道 |
| `trading_report` | 0 | 查询已保存的报告 |

```
# Quick 分析
trading_quick(ticker="600519")

# Full 分析（含辩论 + 风控）
trading_full(ticker="600519")

# 查询历史报告
trading_report(ticker="600519", date="2026-06-05")
```

### 项目结构

```
openclaw-trading-agents/
├── src/                          # TypeScript 源码
│   ├── index.ts                  # 插件入口，注册 3 个工具
│   ├── orchestrator.ts           # Quick/Full 管道编排
│   ├── llm-client.ts             # OpenAI 兼容 LLM 客户端
│   ├── exec-python.ts            # Python 脚本执行器（30s 超时）
│   ├── prompt-loader.ts          # Markdown 模板引擎
│   ├── report-store.ts           # 报告持久化
│   ├── trace-logger.ts           # LLM 调用溯源
│   ├── debate.ts                 # Bull↔Bear 多轮辩论
│   ├── research-manager.ts       # 辩论评分 + 5 级方向决策
│   ├── trader.ts                 # A 股交易执行计划
│   ├── risk.ts                   # 三方风控辩论 + 风控经理
│   └── types.ts                  # 类型定义
├── skills/                       # 数据技能（每个技能 = 一个数据领域）
│   ├── trading-kline/            # K 线 OHLCV
│   ├── trading-fundamentals/     # PE/PB/ROE/财务数据
│   ├── trading-news/             # 个股新闻 + 宏观新闻
│   ├── trading-sentiment/        # 市场情绪指标
│   ├── trading-policy/           # 政策事件
│   ├── trading-hot-money/        # 北向资金/主力资金/龙虎榜
│   ├── trading-lockup/           # 解禁/减持
│   ├── trading-sector/           # 行业排名 + 概念板块
│   └── trading-analysis/         # Prompt 模板
│       └── prompts/
│           ├── analysts/         # 7 个分析师 Prompt
│           ├── portfolio_manager.md
│           └── debate/           # 6 个辩论/研究/交易/风控 Prompt
├── tests/ts/                     # TypeScript 测试（vitest）
├── docs/                         # 设计文档
├── config/                       # 配置示例
└── scripts/                      # 构建脚本
```

### 数据源

| 技能 | 数据内容 | 数据来源 | Python 依赖 |
|------|---------|----------|------------|
| trading-kline | K 线 OHLCV | mootdx / akshare | `mootdx`, `akshare` |
| trading-fundamentals | PE/PB/ROE/财报 | 腾讯证券 / 东方财富 | `mootdx`, `akshare` |
| trading-news | 个股新闻 + 宏观新闻 | 东方财富 / 财联社 | `requests`, `akshare` |
| trading-sentiment | 市场情绪指标 | 东方财富 | `akshare` |
| trading-policy | 政策事件 | 东方财富 / 财联社 | `requests` |
| trading-hot-money | 北向/主力资金/龙虎榜 | 东方财富 / 同花顺 | `akshare`, `requests` |
| trading-lockup | 解禁/减持计划 | 东方财富 / mootdx | `mootdx`, `akshare` |
| trading-sector | 行业排名/概念板块 | 东方财富 / 百度 | `akshare`, `requests` |

### 配置

插件配置文件：`~/.openclaw/plugins/trading-agents/config.json`

```json
{
  "models": {
    "analyst": "gpt-4o",
    "debater": "gpt-4o",
    "decision": "gpt-4o",
    "risk": "gpt-4o"
  },
  "debate_rounds": 2,
  "risk_debate_rounds": 1,
  "max_risk_retries": 1,
  "report_dir": "~/.openclaw/trading-reports"
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `models.analyst` | string | `gpt-4o` | 分析师使用的模型 |
| `models.debater` | string | `gpt-4o` | 辩论使用的模型 |
| `models.decision` | string | `gpt-4o` | 研究/交易决策使用的模型 |
| `models.risk` | string | `gpt-4o` | 风控使用的模型 |
| `debate_rounds` | number | `2` | Bull↔Bear 辩论轮次 |
| `risk_debate_rounds` | number | `1` | 风控辩论轮次 |
| `max_risk_retries` | number | `1` | 风控修订最大重试次数 |
| `report_dir` | string | `~/.openclaw/trading-reports` | 报告保存目录 |

### VERDICT 协议

所有 LLM 输出通过 HTML 注释嵌入结构化结论：

```html
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->
```

不同阶段使用不同的 direction 值：
- 分析师：`看多` / `看空` / `中性`
- 辩论：`看多` / `看空`
- 研究经理：`Buy` / `Overweight` / `Hold` / `Underweight` / `Sell`
- 交易员：`Buy` / `Hold` / `Sell`
- 风控：`pass` / `revise` / `reject`

### 示例输出

查看分析报告示例：

| 文件 | 说明 |
|------|------|
| [report_quick_600519.md](examples/report_quick_600519.md) | Quick 模式 — Markdown 格式 |
| [report_full_600519.md](examples/report_full_600519.md) | Full 模式 — Markdown 格式（推荐先看这个） |
| [report_full_600519.html](examples/report_full_600519.html) | Full 模式 — HTML 格式 |
| [report_quick_600519.json](examples/report_quick_600519.json) | Quick 模式 — JSON 原始输出 |
| [report_full_600519.json](examples/report_full_600519.json) | Full 模式 — JSON 原始输出 |

Full 模式比 Quick 多出的内容：
- **多空辩论**：Bull↔Bear 2 轮对抗，每轮生成带置信度的 claim
- **研究经理**：对辩论评分（Bull 72 vs Bear 48），输出 5 级方向决策
- **交易员**：A 股执行计划（T+1、涨跌停、分批建仓）
- **三方风控**：激进/保守/中性独立评估 → 风控经理 pass/revise/reject

所有 LLM 输出通过 HTML 注释嵌入结构化结论：

```html
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->
```

不同阶段使用不同的 direction 值：
- 分析师：`看多` / `看空` / `中性`
- 辩论：`看多` / `看空`
- 研究经理：`Buy` / `Overweight` / `Hold` / `Underweight` / `Sell`
- 交易员：`Buy` / `Hold` / `Sell`
- 风控：`pass` / `revise` / `reject`

### 开发

```bash
npm run build          # TypeScript 编译
npm test               # 运行 50 个测试
npm run test:watch     # 监听模式
```

### 文档

| 文档 | 中文 | English |
|------|------|---------|
| 架构 | [docs/architecture.zh.md](docs/architecture.zh.md) | [docs/architecture.md](docs/architecture.md) |
| 数据源 | [docs/data-sources.zh.md](docs/data-sources.zh.md) | [docs/data-sources.md](docs/data-sources.md) |
| Prompt 设计 | [docs/prompts.zh.md](docs/prompts.zh.md) | [docs/prompts.md](docs/prompts.md) |
| 路线图 | [docs/roadmap.zh.md](docs/roadmap.zh.md) | [docs/roadmap.md](docs/roadmap.md) |
| 更新日志 | — | [CHANGELOG.md](CHANGELOG.md) |

### 致谢

本项目 Prompt 和数据脚本提炼自以下开源项目：
- [TradingAgents](https://github.com/TaurionResearch/TradingAgents) — 多智能体辩论架构
- [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) — 金融 AI Agent
- [AutoQuant](https://github.com/AI4Finance-Foundation/FinRobot) — 量化分析

### 许可证

[MIT License](LICENSE)

---

<a id="english"></a>

## English

### Overview

OpenClaw Trading Agents is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that uses multiple AI agents to collaboratively analyze China A-share stocks. The system simulates a real investment team's analysis workflow: 7 specialized analysts run in parallel → Bull↔Bear debate → Research Manager scoring → Trader execution plan → 3-way risk debate, producing structured trading decisions.

### Key Features

- **7 Analysts in Parallel**: Technical, fundamentals, news, sentiment, policy, capital flow, lockup — covering major A-share analysis dimensions
- **Bull↔Bear Debate**: Multi-round adversarial debate to improve decision quality through structured argumentation
- **3-Way Risk Debate**: Aggressive/conservative/neutral risk assessment with independent evaluation
- **8 Data Sources**: K-line, financials, news, sentiment, policy, capital flow, lockup, sector rankings
- **Two Analysis Modes**: Quick (8 LLM calls) and Full (15+ LLM calls)
- **A-Share Specific**: T+1 constraints, price limits, northbound capital tracking
- **Full Traceability**: Every LLM call is traced and persisted for auditing

### Installation

**Option 1: OpenClaw Plugin Install (Recommended)**

```bash
# Install from GitHub
openclaw plugins install git:github.com/kangjinghang/openclaw-trading-agents

# Install Python dependencies (required for data scripts)
pip install -r requirements.txt
```

**Option 2: Local Development**

```bash
git clone https://github.com/kangjinghang/openclaw-trading-agents.git
cd openclaw-trading-agents

npm install
pip install -r requirements.txt

npm run build
npm test

# Register as linked plugin (auto-reloads on source changes)
openclaw plugins install --link .
```

> **Note**: The `dist/` directory is included in the git repository, so `openclaw plugins install` works without an additional build step. Developers should run `npm run build` and commit updated `dist/` after changing TypeScript source.

### Configure Trading Agent

After installing the plugin, create a dedicated trading agent and configure permissions:

```bash
# 1. Create agent
openclaw agents add trading --model zai/glm-5.1

# 2. Edit config (add plugin tool visibility + disable exec approval)
openclaw config edit
```

In the config file, find the trading agent entry and add `tools` configuration:

```json
{
  "id": "trading",
  "model": "zai/glm-5.1",
  "tools": {
    "alsoAllow": ["group:plugins"],
    "exec": { "host": "gateway", "security": "full", "ask": "off" }
  }
}
```

> **`alsoAllow: ["group:plugins"]`** — Makes plugin tools (`trading_quick`/`trading_full`/`trading_report`) visible to the agent
>
> **`exec.security: "full", ask: "off"`** — Disables exec approval prompts (optional, without this every command requires manual approval)

Restart the gateway to apply: `openclaw gateway restart`

> **Python Environment**: Data scripts require `requests`, `mootdx`, `akshare`, `pandas`. The plugin **auto-detects** a Python with these dependencies installed (supports system Python, Homebrew, pyenv, etc.). You can also set `TRADING_PYTHON` env var to specify an explicit path.
>
> **⚠️ Warning**: `openclaw agents delete` removes the agent's workspace directory. Do not point workspace to your project source directory.

### Quick Start

```bash
# Set API key
export OPENAI_API_KEY=your-api-key
# Optional: use OpenAI-compatible API (ZhiPu, DeepSeek, etc.)
# export OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/

# Run analysis (no OpenClaw required)
node dist/cli.js quick 600519
node dist/cli.js full 600519
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | LLM API Key |
| `OPENAI_BASE_URL` | No | OpenAI-compatible API URL (ZhiPu, DeepSeek, Moonshot, etc.) |

### Usage

**Option 1: Standalone CLI (recommended for first-time users)**

```bash
# Quick analysis (8 LLM calls)
node dist/cli.js quick 600519

# Full analysis (15+ LLM calls, with debate + risk)
node dist/cli.js full 600519

# Specify date
node dist/cli.js full 600519 2026-06-05

# Specify model and debate rounds
node dist/cli.js full 600519 --model gpt-4o-mini --debate-rounds 3
```

**Option 2: As OpenClaw plugin**

```bash
openclaw plugins install --link .
cp config/openclaw.example.json ~/.openclaw/plugins/trading-agents/config.json
```

### Example Output

See real analysis report examples:

| File | Description |
|------|-------------|
| [examples/report_quick_600519.json](examples/report_quick_600519.json) | Quick mode — 7 analyst reports for Moutai |
| [examples/report_full_600519.json](examples/report_full_600519.json) | Full mode — complete report with debate and risk |

| Tool | LLM Calls | Description |
|------|-----------|-------------|
| `trading_quick` | 8 | 7 analysts → Portfolio Manager synthesis |
| `trading_full` | 15+ | Full debate pipeline with risk assessment |
| `trading_report` | 0 | Query saved reports |

### Architecture

```
User Input → OpenClaw Tool Call
  ↓
┌─ 7 Data Scripts (parallel) ──────────────────────────┐
│  kline · fundamentals · news · sentiment · policy     │
│  hot_money · lockup · sector                          │
└───────────────────────────────────────────────────────┘
  ↓
┌─ Quick Mode (8 LLM calls) ──────────────────────────┐
│  7 Analysts (parallel) → Portfolio Manager decision   │
└──────────────────────────────────────────────────────┘
  ↓ (or)
┌─ Full Mode (15+ LLM calls) ─────────────────────────┐
│  7 Analysts → Bull↔Bear Debate (N rounds)            │
│  → Research Manager → Trader → Risk Debate → Risk Mgr│
└──────────────────────────────────────────────────────┘
  ↓
Structured Report + LLM Trace Persistence
```

### Configuration

`~/.openclaw/plugins/trading-agents/config.json`:

```json
{
  "models": {
    "analyst": "gpt-4o",
    "debater": "gpt-4o",
    "decision": "gpt-4o",
    "risk": "gpt-4o"
  },
  "debate_rounds": 2,
  "risk_debate_rounds": 1,
  "max_risk_retries": 1,
  "report_dir": "~/.openclaw/trading-reports"
}
```

### Development

```bash
npm run build          # Compile TypeScript
npm test               # Run 50 tests (vitest)
npm run test:watch     # Watch mode
```

### License

[MIT License](LICENSE)
