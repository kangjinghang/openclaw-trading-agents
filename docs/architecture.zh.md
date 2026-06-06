# 架构文档

[English](architecture.md) | 中文

OpenClaw Trading Agents 的系统架构与设计。

## 概述

OpenClaw Trading Agents 是一个 [OpenClaw](https://github.com/openclaw/openclaw) 插件，通过多个 AI Agent 协作分析 A 股市场。系统提供两种分析模式：

- **快速模式** (`trading_quick`)：7 分析师 → 投资组合经理。8 次 LLM 调用。
- **完整模式** (`trading_full`)：7 分析师 → 多空辩论 → 研究经理 → 交易员 → 三方风控辩论 → 风控经理。15+ 次 LLM 调用。

## 数据流

```
用户 → OpenClaw Tool Call
  ↓
┌─ 数据准备（7 个 Python 脚本，并行）──────────────────────────────┐
│  kline · fundamentals · news · sentiment · policy                 │
│  hot_money · lockup · sector                                      │
└───────────────────────────────────────────────────────────────────┘
  ↓
┌─ 快速模式（8 次 LLM 调用）───────────────────────────────────────┐
│  7 分析师（并行） → 投资组合经理                                    │
│  输出：QuickAnalysisResult                                         │
└───────────────────────────────────────────────────────────────────┘
  ↓ （或）
┌─ 完整模式（15+ 次 LLM 调用）─────────────────────────────────────┐
│  阶段 1：7 分析师（并行）                                          │
│  阶段 2：多头↔空头辩论（N 轮，默认 2 轮）                          │
│  阶段 3：研究经理（5 级评分）                                      │
│  阶段 4：交易员（A 股执行计划）                                    │
│  阶段 5：三方风控辩论 + 风控经理                                    │
│  输出：FullAnalysisResult                                          │
└───────────────────────────────────────────────────────────────────┘
  ↓
报告持久化 + LLM 调用溯源
```

## 分层设计

| 层级 | 技术 | 变更频率 | 职责 |
|------|------|---------|------|
| 插件层 | TypeScript | 低 | 注册工具、编排管道、调用 LLM API |
| 技能层 | Python | 中 | 数据获取脚本 + fallback 逻辑 |
| Prompt 层 | Markdown | 中 | 角色提示词模板，`{{placeholder}}` 变量 |

## 组件

### 插件层（`src/`）

| 文件 | 职责 |
|------|------|
| `index.ts` | 插件入口。注册 `trading_quick`、`trading_full`、`trading_report` 工具。 |
| `orchestrator.ts` | 管道协调。`runQuickAnalysis()` 和 `runFullAnalysis()`。 |
| `llm-client.ts` | OpenAI 兼容 API 封装，含成本追踪。`parseVerdict()` 从 LLM 输出提取结构化结论。 |
| `exec-python.ts` | 启动 Python 子进程，30 秒超时保护。返回 `ScriptResult`（JSON stdout 或错误）。 |
| `prompt-loader.ts` | 加载 `.md` 模板，替换 `{{key}}` 占位符。 |
| `report-store.ts` | 报告持久化。`save()` 用于快速模式，`saveFull()` 用于完整模式。 |
| `trace-logger.ts` | 记录每次 LLM 调用的完整输入输出，用于审计。 |
| `debate.ts` | 多头↔空头多轮对抗辩论。 |
| `research-manager.ts` | 辩论评分，输出 5 级方向决策。 |
| `trader.ts` | 生成 A 股执行计划（T+1、涨跌停、最小手数）。 |
| `risk.ts` | 三方风控辩论（激进/保守/中性）+ 风控经理 pass/revise/reject 流程。 |
| `types.ts` | 所有 TypeScript 接口定义。 |

### 技能层（`skills/`）

每个技能是一个独立的数据领域，包含 Python 脚本和可选的 fallback：

| 技能 | 数据内容 | 主源 | 备源 |
|------|---------|------|------|
| `trading-kline` | K 线 OHLCV | mootdx (通达信 TCP) | akshare (新浪 HTTP) |
| `trading-fundamentals` | PE/PB/ROE/财务数据 | 腾讯财经 / 东方财富 | mootdx F10 |
| `trading-news` | 个股新闻 + 宏观新闻 | 财联社 / 东方财富 | — |
| `trading-sentiment` | 市场情绪 | 东方财富 | — |
| `trading-policy` | 政策事件 | 东方财富搜索 / 财联社 | — |
| `trading-hot-money` | 北向资金/主力资金/龙虎榜 | 东方财富 | akshare |
| `trading-lockup` | 解禁/内部人交易 | 东方财富 / mootdx F10 | akshare |
| `trading-sector` | 行业排名/概念板块 | 东方财富 / 百度 | akshare |

### Prompt 层（`skills/trading-analysis/prompts/`）

16 个角色提示词模板，分为两个子目录：

```
prompts/
├── analysts/                    # 7 个分析师角色
│   ├── market.md               # 技术分析（A 股规则：T+1、涨跌停）
│   ├── fundamentals.md         # CAS 会计准则、A 股估值
│   ├── news.md                 # 新闻分析（来源权重：财联社 > 东方财富）
│   ├── sentiment.md            # 情绪分析（反向指标）
│   ├── policy.md               # 政策分析（A 股"政策市"特色）
│   ├── hot_money.md            # 游资追踪（龙虎榜/北向/主力资金）
│   └── lockup.md               # 解禁观察（限售股/减持/质押）
├── portfolio_manager.md        # 综合 7 位分析师报告
└── debate/                     # 6 个辩论/研究/交易/风控角色
    ├── bull.md                 # 多头研究员（Claim 结构化论证）
    ├── bear.md                 # 空头研究员
    ├── research_manager.md     # 5 级评分 + 方向决策
    ├── trader.md               # A 股执行计划（T+1、涨跌停、最小手数）
    ├── risk_debate.md          # 三方风控：激进/保守/中性
    └── risk_manager.md         # pass/revise/reject + 硬/软约束
```

模板使用 `{{placeholder}}` 语法。`prompt-loader.ts` 在运行时替换占位符。

## VERDICT 协议

所有 LLM 输出通过 HTML 注释嵌入结构化结论：

```html
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->
```

不同阶段使用不同的 direction 值：

| 阶段 | direction 值 |
|------|-------------|
| 分析师 | `看多` / `看空` / `中性` |
| 多空辩论 | `看多` / `看空` |
| 研究经理 | `Buy` / `Overweight` / `Hold` / `Underweight` / `Sell` |
| 交易员 | `Buy` / `Hold` / `Sell` |
| 风控 | `pass` / `revise` / `reject` |

`orchestrator.ts` 中的 `parseDirection()` 将中文/英文方向名映射为标准 `Buy`/`Hold`/`Sell`。同时防御性处理管道分隔符（如 `看多|看空|中性`）。

## Revise 回路

完整模式中，风控经理可返回：
- **pass**：计划通过，输出最终结果。
- **revise**：带硬约束返回交易员重新生成（最多重试 1 次）。
- **reject**：输出"不建议操作"。

## 报告存储

报告保存在 `report_dir`（默认：`~/.openclaw/trading-reports/`）下：

```
report_dir/
├── 600519/
│   ├── 2026-06-05_quick.json              # 快速模式摘要
│   ├── 2026-06-05_full.json               # 完整模式摘要
│   └── 2026-06-05_full/
│       ├── 01_analysts/
│       │   └── market.json                # 每位分析师的报告
│       ├── 02_debate/
│       │   ├── round_1.json
│       │   └── round_2.json
│       ├── 03_research.json
│       ├── 04_trading_plan.json
│       └── 05_risk/
│           ├── aggressive.json
│           ├── conservative.json
│           ├── neutral.json
│           └── risk_manager.json
```

LLM 调用溯源存储在 `~/.openclaw/traces/<ticker>_<date>/`，每次调用一个 JSON 文件，记录完整输入输出。

## 配置

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

支持任何 OpenAI 兼容 API。不同阶段可指定不同模型（如分析师用便宜模型，辩论用强模型）。

## 自定义指南

| 变什么 | 改哪里 |
|-------|--------|
| 数据 API 变了 | `skills/trading-*/scripts/*.py` |
| 新增数据源 | 新建 Skill + 更新 `openclaw.plugin.json` |
| 调整分析师 prompt | `skills/trading-analysis/prompts/analysts/*.md` |
| 调整辩论 prompt | `skills/trading-analysis/prompts/debate/*.md` |
| 编排流程调整 | `src/orchestrator.ts` |
| 新增工具 | `src/index.ts` 注册新 tool |
| 调换 LLM 模型 | config.json 配置 |
