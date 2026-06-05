# OpenClaw + TradingAgents A股交易分析系统集成设计

## 目标

构建一个独立的、可分享的 GitHub 项目（`openclaw-trading-agents`），通过 OpenClaw 的 Plugin + Skill 机制集成多角色 A 股分析能力。用户 clone 后一条命令安装，不修改 OpenClaw 源码。

## 核心原则

- **独立项目**：单独 Git 仓库，可提交 GitHub，其他人可 clone 使用
- **不修改 OpenClaw 源码**：利用 Plugin、Skill、配置三种扩展机制
- **数据脚本用 Python**（mootdx/akshare/东方财富等免费源），通过 shell 调用
- **每个 Skill 是原子的**——一个数据领域一个 Skill
- **数据脚本内置 fallback**（主源挂了自动切备源），实在没有 fallback 也可以接受
- **Prompt 从 TradingAgents 项目群提取**（astock 为主，AShare 补充）
- **Plugin 只做编排和注册工具**，不实现数据获取逻辑

---

## 项目结构

独立仓库 `openclaw-trading-agents/`，结构如下：

```
openclaw-trading-agents/
│
├── README.md                        ← 安装说明、使用方法、配置示例
├── LICENSE                          ← MIT
│
├── package.json                     ← OpenClaw Plugin 入口（npm 包）
├── openclaw.plugin.json             ← Plugin manifest（声明 skills、tools）
├── tsconfig.json
├── src/
│   └── index.ts                     ← Plugin 入口: definePluginEntry + register tools
│       ├── trading_analyze          ← 完整分析编排
│       ├── trading_quick            ← 快速分析编排
│       ├── llm-client.ts           ← LLM API 调用封装
│       ├── orchestrator.ts         ← 5 阶段流程编排
│       ├── prompt-loader.ts        ← 加载和渲染 prompt 模板
│       ├── trace-logger.ts         ← LLM 调用溯源记录
│       └── report-store.ts         ← 报告持久化
│
├── skills/                          ← 打包进 Plugin 的 Skills
│   ├── trading-kline/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       └── kline.py             主源: mootdx → 备源: 新浪
│   ├── trading-fundamentals/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       ├── fundamentals.py      主源: 腾讯 → 备源: mootdx F10
│   │       ├── financials.py        主源: 新浪 → 备源: mootdx
│   │       └── profit_forecast.py   主源: 同花顺 (无免费替代)
│   ├── trading-news/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       ├── news.py              主源: 财联社 → 备源: 东方财富
│   │       └── global_news.py       主源: 财联社 → 备源: 东方财富
│   ├── trading-hot-money/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       ├── northbound.py        主源: 东方财富 → 备源: akshare
│   │       ├── fund_flow.py         主源: 东方财富 → 备源: akshare
│   │       └── dragon_tiger.py      主源: 东方财富 → 备源: akshare
│   ├── trading-sentiment/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       └── hot_stocks.py        主源: 同花顺 → 备源: 东方财富
│   ├── trading-policy/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       └── global_news.py       主源: 财联社 → 备源: 东方财富
│   ├── trading-lockup/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       ├── lockup.py            主源: 东方财富 → 备源: akshare
│   │       └── insider.py           主源: mootdx F10 → 备源: 东方财富
│   ├── trading-sector/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       ├── industry_rank.py     主源: 东方财富 → 备源: akshare
│   │       └── concept_blocks.py    主源: 百度股市通 → 备源: 东方财富
│   └── trading-analysis/            ← 编排层 Skill
│       ├── SKILL.md                 ← 分析流程、角色、何时用哪个数据 Skill
│       └── prompts/                 ← 16 个角色的 prompt 模板
│           ├── analysts/
│           │   ├── market.md
│           │   ├── news.md
│           │   ├── sentiment.md
│           │   ├── fundamentals.md
│           │   ├── policy.md
│           │   ├── hot_money.md
│           │   └── lockup.md
│           ├── researchers/
│           │   ├── bull.md
│           │   ├── bear.md
│           │   └── research_manager.md
│           ├── trader.md
│           ├── risk/
│           │   ├── aggressive.md
│           │   ├── conservative.md
│           │   ├── neutral.md
│           │   └── risk_manager.md
│           └── portfolio_manager.md
│
├── scripts/                         ← 安装和辅助脚本
│   ├── setup-python.sh              ← 安装 Python 依赖（mootdx, akshare 等）
│   └── check-env.py                 ← 检查 Python 环境和数据源可用性
│
├── config/                          ← 配置示例
│   ├── openclaw.example.json        ← openclaw.json 配置片段（Plugin 配置 + Agent 配置）
│   └── watchlist.example.yaml       ← 自选股列表示例
│
├── docs/                            ← 项目文档
│   ├── architecture.md              ← 架构说明
│   ├── data-sources.md              ← 数据源文档（各源 + fallback）
│   ├── prompts-reference.md         ← Prompt 来源和设计说明
│   └── deployment.md                ← 部署指南
│
└── tests/                           ← 测试
    ├── scripts/                     ← Python 数据脚本单元测试
    └── prompts/                     ← Prompt 模板测试
```

### 安装方式

```bash
# 方式 1: Git clone + 本地安装（推荐开发阶段）
git clone https://github.com/user/openclaw-trading-agents.git
cd openclaw-trading-agents
npm install                          ← 安装 Plugin 依赖
./scripts/setup-python.sh            ← 安装 Python 数据源依赖
openclaw plugins install --link .    ← 链接到 OpenClaw

# 方式 2: 直接从 Git 安装（用户使用）
openclaw plugins install git:github.com/user/openclaw-trading-agents

# 方式 3: 发布到 ClawHub 后（后期）
openclaw plugins install clawhub:trading-agents
```

安装后 OpenClaw 自动发现：
- Plugin 注册的 `trading_analyze` + `trading_quick` 工具
- Skills 目录下的所有 SKILL.md（通过 Plugin manifest 声明）

### Plugin Manifest

```json
// openclaw.plugin.json
{
  "id": "trading-agents",
  "name": "Trading Agents - A股多角色分析",
  "version": "0.1.0",
  "description": "Multi-agent A-share stock analysis with debate-driven decision making",
  "main": "dist/index.js",
  "skills": [
    "./skills/trading-kline",
    "./skills/trading-fundamentals",
    "./skills/trading-news",
    "./skills/trading-hot-money",
    "./skills/trading-sentiment",
    "./skills/trading-policy",
    "./skills/trading-lockup",
    "./skills/trading-sector",
    "./skills/trading-analysis"
  ],
  "configSchema": {
    "models": { "type": "object" },
    "debate_rounds": { "type": "number", "default": 2 },
    "risk_debate_rounds": { "type": "number", "default": 1 },
    "max_risk_retries": { "type": "number", "default": 1 },
    "report_dir": { "type": "string", "default": "~/.openclaw/trading-reports" }
  }
}
```

### 用户配置片段

安装后用户只需在 `openclaw.json` 中添加：

```json5
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "trading-agents": {
        "enabled": true,
        "config": {
          "models": {
            "analyst": "gpt-4o",
            "debater": "claude-sonnet-4-6",
            "decision": "claude-sonnet-4-6",
            "risk": "gpt-4o"
          },
          "debate_rounds": 2,
          "risk_debate_rounds": 1,
          "max_risk_retries": 1
        }
      }
    }
  },
  // 后期: 多 Agent 路由
  "multiAgent": {
    "enabled": true,
    "bindings": [
      { "channel": "telegram", "agent": "a_stock_default", "accountId": "my-bot" }
    ]
  },
  // 后期: Cron
  "cron": [
    {
      "id": "post-market",
      "schedule": { "kind": "cron", "expr": "10 15 * * 1-5", "tz": "Asia/Shanghai" },
      "target": { "agent": "a_stock_default" },
      "payload": { "kind": "agentTurn", "text": "/analyze 600519,000858,300750" },
      "delivery": { "channel": "telegram", "accountId": "my-bot", "chatId": "..." }
    }
  ]
}
```

---

## 整体架构

```
OpenClaw Gateway
│
├── Agent: a_stock_default (默认 A 股综合策略)
│   └── Plugin: trading-agents (通过 openclaw plugins install 安装)
│       ├── Tool: trading_analyze(ticker, date, strategy?)
│       │     → 编排 5 阶段分析流程，直接调 LLM API
│       └── Tool: trading_quick(ticker, date)
│             → 快速分析，跳过辩论和风控
│       └── Skills: 9 个 (通过 Plugin manifest 声明，自动发现)
│
├── Agent: a_stock_short_term (后期扩展，A 股短线策略)
│   └── Plugin: trading-agents (复用，配置不同角色组合)
│
├── Cron Jobs (后期配置)
│   ├── 盘前 08:50 → quick 分析自选股
│   └── 盘后 15:10 → 完整分析自选股
│
└── Telegram / 钉钉 / Slack
    ├── /analyze 600519    → 完整分析
    └── /quick 600519      → 快速分析
```

---

## 分层结构

### Plugin 层（极少变动）

TypeScript 实现，注册工具 + 编排流程 + 直接调 LLM API。打包为 npm 包，通过 `openclaw plugins install` 安装。

注册工具：
- `trading_analyze`：完整 5 阶段分析
- `trading_quick`：快速分析（Phase 1 + Phase 5，跳过辩论和风控）
- `trading_report`：查询历史分析报告
- `trading_compare`：对比同一只股票不同日期的分析结果

### Skill 层（中等变动）

9 个 Skill 打包在 Plugin 目录内，通过 Plugin manifest 的 `skills` 字段声明，OpenClaw 自动发现。

每个数据 Skill 包含 SKILL.md（调用说明）+ scripts/（Python 数据获取脚本 + fallback）。

---

## 数据脚本 Fallback 策略

每个脚本统一结构：

```python
SOURCES = [
    {"name": "eastmoney", "fetch": fetch_from_eastmoney, "priority": 1},
    {"name": "akshare",   "fetch": fetch_from_akshare,   "priority": 2},
]

async def fetch(ticker, **params):
    last_error = None
    for source in sorted(SOURCES, key=lambda s: s["priority"]):
        try:
            result = await source["fetch"](ticker, **params)
            result["_source"] = source["name"]
            return result
        except Exception as e:
            logger.warning(f"{source['name']} failed: {e}")
            last_error = e
    raise DataFetchError(f"all sources failed: {last_error}")
```

### 各数据域的 fallback 对应表

| Skill | 主源 | 备源 | 无 fallback |
|-------|------|------|-------------|
| trading-kline | mootdx (TCP 7709) | 新浪财经 | — |
| trading-fundamentals | 腾讯财经 | mootdx F10 | — |
| trading-fundamentals (financials) | 新浪财经 | mootdx | — |
| trading-fundamentals (profit_forecast) | 同花顺 | — | ✅ 无免费替代 |
| trading-news | 财联社 | 东方财富 | — |
| trading-hot-money (northbound) | 东方财富 push2 | akshare | — |
| trading-hot-money (fund_flow) | 东方财富 push2 | akshare | — |
| trading-hot-money (dragon_tiger) | 东方财富 | akshare | — |
| trading-sentiment (hot_stocks) | 同花顺 | 东方财富 | — |
| trading-policy | 财联社 | 东方财富 | — |
| trading-lockup (lockup) | 东方财富 | akshare | — |
| trading-lockup (insider) | mootdx F10 | 东方财富 | — |
| trading-sector (industry_rank) | 东方财富 | akshare | — |
| trading-sector (concept_blocks) | 百度股市通 | 东方财富 | — |

注：akshare 本身聚合了多个数据源（包括东方财富），可作为通用备源，但不是完全独立的。

---

## 编排流程

### trading_analyze 完整流程

```
输入: { ticker, date }
      │
      ▼ 预处理: 并行执行所有 Python 脚本，收集原始数据（~3-5 秒）
      │
      ▼
┌─ Phase 1: 分析师报告（7 次 LLM 调用，可并行）────────────────┐
│  每个分析师: 原始数据注入 prompt → 1 次 LLM 调用 → 报告       │
│  输出: AnalystReport[] { role, content, verdict, data_sources } │
└──────────────────────────────────────────────────────────────┘
      │ reports: AnalystReport[]
      ▼
┌─ Phase 2: 研究辩论（4-5 次 LLM 调用）────────────────────────┐
│  Bull ↔ Bear 多轮辩论 (默认 2 轮)                              │
│  Claim 追踪: ID + evidence + confidence + resolved status       │
│  Research Manager 裁决 → 投资方案                              │
│  输出: DebateResult { bull_final, bear_final, claims,           │
│         manager_decision: { direction, position, stop_loss }}  │
└──────────────────────────────────────────────────────────────┘
      │ reports + DebateResult
      ▼
┌─ Phase 3: 交易员（1 次 LLM 调用）─────────────────────────────┐
│  基于 Research Manager 方案 + A 股交易约束                      │
│  输出: TradePlan { direction, entry, stop_loss, take_profit,    │
│         position_pct, lots, constraints }                      │
└──────────────────────────────────────────────────────────────┘
      │ reports + DebateResult + TradePlan
      ▼
┌─ Phase 4: 风险辩论（3-4 次 LLM 调用）─────────────────────────┐
│  Aggressive ↔ Conservative ↔ Neutral 三方辩论 (默认 1 轮)      │
│  Risk Manager 裁决 → pass / revise / reject                    │
│  如果 revise → 回到 Phase 3 重跑（最多 1 次）                   │
│  如果 reject → 输出 "不建议操作"                                │
│  输出: RiskResult { verdict, hard_constraints, soft_constraints,│
│         execution_preconditions, derisk_triggers }             │
└──────────────────────────────────────────────────────────────┘
      │ 全部上下文
      ▼
┌─ Phase 5: 投资组合经理（1 次 LLM 调用）───────────────────────┐
│  综合所有信息 → 最终交易信号                                    │
│  输出: FinalDecision { ticker, direction, confidence,           │
│         target_price, stop_loss, position_pct, reasoning,      │
│         key_risks, analyst_verdicts, execution_plan }           │
└──────────────────────────────────────────────────────────────┘
```

### LLM 调用次数

| 模式 | 调用次数 | 预估耗时 |
|------|---------|---------|
| 完整分析 (trading_analyze) | 18 次 | ~2 分钟 |
| 快速分析 (trading_quick) | 8 次 | ~40 秒 |

### 数据预处理

Plugin 在 Phase 1 之前，并行执行所有 Python 脚本获取原始数据。数据按角色注入对应 prompt 模板，分析师不再需要自己调工具。

```typescript
async function prepareAllData(ticker, date) {
  return Promise.all([
    execPython("trading-kline/scripts/kline.py", { ticker, count: 60 }),
    execPython("trading-fundamentals/scripts/fundamentals.py", { ticker }),
    execPython("trading-fundamentals/scripts/financials.py", { ticker }),
    execPython("trading-fundamentals/scripts/profit_forecast.py", { ticker }),
    execPython("trading-news/scripts/news.py", { ticker, date }),
    execPython("trading-news/scripts/global_news.py", { date }),
    execPython("trading-hot-money/scripts/northbound.py", { date }),
    execPython("trading-hot-money/scripts/fund_flow.py", { ticker, date }),
    execPython("trading-hot-money/scripts/dragon_tiger.py", { ticker, date }),
    execPython("trading-sentiment/scripts/hot_stocks.py", { date }),
    execPython("trading-lockup/scripts/lockup.py", { ticker, date }),
    execPython("trading-lockup/scripts/insider.py", { ticker }),
    execPython("trading-sector/scripts/industry_rank.py", { date }),
    execPython("trading-sector/scripts/concept_blocks.py", { ticker }),
  ]);
}
```

---

## Phase 间数据交换

### 数据结构

```typescript
// Phase 1 输出
interface AnalystReport {
  role: string;                     // "market_analyst" | "policy_analyst" | ...
  content: string;                  // 完整报告文本
  verdict: { direction: string, reason: string };  // 解析 <!-- VERDICT: ... -->
  data_sources_used: string[];      // ["kline.py", "industry_rank.py"]
}

// Phase 2 内部状态
interface DebateState {
  round: number;
  maxRounds: number;                // 默认 2
  bullHistory: string[];
  bearHistory: string[];
  claims: Claim[];
}

interface Claim {
  id: string;                       // "INV-1", "INV-2", ...
  claim: string;                    // 不超过 28 字
  evidence: string[];
  confidence: number;               // 0-1
  status: "resolved" | "unresolved";
  raisedBy: "bull" | "bear";
}

// Phase 2 输出
interface DebateResult {
  bull_final: string;
  bear_final: string;
  claims: Claim[];
  manager_decision: {
    direction: "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
    plan: string;
    position_pct: number;
    entry_range: [number, number];
    stop_loss: number;
    take_profit: number;
    invalidation: string;
  };
}

// Phase 3 输出
interface TradePlan {
  direction: "Buy" | "Sell" | "Hold";
  entry_price: number;
  stop_loss: number;
  take_profit: number[];            // 分批止盈
  position_pct: number;
  lots: number;
  constraints: string;              // "T+1, 主板±10%"
  execution_notes: string;
}

// Phase 4 内部状态
interface RiskDebateState {
  round: number;
  maxRounds: number;                // 默认 1
  aggressive_history: string[];
  conservative_history: string[];
  neutral_history: string[];
  risk_claims: Claim[];
  latest_speaker: "aggressive" | "conservative" | "neutral";
}

// Phase 4 输出
interface RiskResult {
  verdict: "pass" | "revise" | "reject";
  hard_constraints: string[];       // ["止损不超过5%"]
  soft_constraints: string[];       // ["建议分两笔建仓"]
  execution_preconditions: string[];// ["开盘后观察15分钟"]
  derisk_triggers: string[];        // ["北向资金转为净流出"]
  revised_plan: TradePlan | null;   // verdict=revise 时非空
}

// Phase 5 输出（最终返回给用户）
interface FinalDecision {
  ticker: string;
  company_name: string;
  date: string;
  direction: "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
  confidence: number;               // 0-1
  target_price: number;
  stop_loss: number;
  position_pct: number;
  reasoning: string;
  key_risks: string[];
  analyst_verdicts: Record<string, string>;  // { market: "看多", policy: "利好", ... }
  bull_bear_summary: string;
  risk_assessment: "pass" | "revise" | "reject";
  execution_plan: string;
  next_review_trigger: string;
}
```

### Revise 回路

Phase 4 风控经理如果输出 `revise`，带上硬约束回到 Phase 3 重跑交易员，最多重试 1 次防止死循环。如果输出 `reject`，直接跳到 Phase 5 输出"不建议操作"。

---

## Prompt 管理

### 来源映射

| 角色 | 来源项目 | 选择理由 |
|------|----------|---------|
| 技术分析师 | astock | A 股规则最全（涨跌停/T+1/北向/换手率） |
| 新闻分析师 | astock | 政策敏感度 + 消息来源权重 |
| 情绪分析师 | astock | 散户情绪权重 + 反向指标 |
| 基本面分析师 | astock | CAS 会计准则 + A 股估值参照系 |
| 政策分析师 | astock 独有 | A 股"政策市"核心因子 |
| 游资追踪器 | astock 独有 | 龙虎榜/北向/主力资金 |
| 解禁观察员 | astock 独有 | 限售股/减持/质押 |
| 多头研究员 | AShare | Claim-based 结构化辩论更精细 |
| 空头研究员 | AShare | 同上 |
| 研究经理 | AShare | 含预期差分析 + Claim 裁决 |
| 交易员 | astock | A 股交易约束最完整（T+1/涨跌停/最小手数） |
| 激进风控 | astock | 涨停板效应/政策底/PE扩张 |
| 保守风控 | astock | T+1锁定/涨跌停陷阱/政策反转 |
| 中性风控 | astock | T+1双刃剑/估值区间法/仓位管理优先 |
| 风控经理 | AShare 独有 | pass/revise/reject 路由 + 硬/软约束 |
| 投资组合经理 | astock | A 股交易约束 + ST 规则 + 评级体系 |

### 模板机制

Prompt 文件是模板，包含 `{{placeholder}}` 占位符，Plugin 运行时注入实际数据：

```markdown
<!-- prompts/analysts/market.md -->
你是一位专注于 A 股市场的技术分析师。

## 标的
- 股票代码: {{ticker}}
- 分析日期: {{date}}

## K 线与行情数据
{{kline}}

## 行业排名数据
{{industry_rank}}

⚠️ A 股市场特殊规则...
<!-- VERDICT: {"direction": "看多", "reason": "..."} -->
```

辩论角色模板注入分析师报告 + 对方论点 + Claim 状态：

```markdown
<!-- prompts/researchers/bull.md -->
你是多头研究员...
## 可用材料
市场报告：{{market_report}}
...
辩论历史：{{debate_history}}
上轮空头观点：{{bear_last_response}}
当前全部 claim：{{claims_text}}
本轮焦点 claim：{{focus_claims_text}}
...
```

### 模型配置

```json5
// openclaw.json
{
  "plugins": {
    "entries": {
      "trading-agents": {
        "enabled": true,
        "config": {
          "models": {
            "analyst": "gpt-4o",
            "debater": "claude-sonnet-4-6",
            "decision": "claude-sonnet-4-6",
            "risk": "gpt-4o"
          },
          "debate_rounds": 2,
          "risk_debate_rounds": 1,
          "max_risk_retries": 1
        }
      }
    }
  }
}
```

---

## 报告持久化

### 存储位置

每次分析产出一份完整报告，持久化到本地文件系统：

```
~/.openclaw/trading-reports/
├── 600519/
│   ├── 2026-06-05_full.json        ← 完整分析摘要（最终决策 + 各阶段 verdict）
│   ├── 2026-06-05_full/
│   │   ├── 00_raw_data.json        ← 预处理阶段所有脚本返回的原始数据
│   │   ├── 01_analysts/
│   │   │   ├── market.json         ← 解析后: { content, verdict, data_sources_used }
│   │   │   ├── news.json
│   │   │   ├── sentiment.json
│   │   │   ├── fundamentals.json
│   │   │   ├── policy.json
│   │   │   ├── hot_money.json
│   │   │   └── lockup.json
│   │   ├── 02_debate.json          ← { bull_final, bear_final, claims, manager_decision }
│   │   ├── 03_trade_plan.json      ← TradePlan
│   │   ├── 04_risk.json            ← { risk_debate_history, risk_result }
│   │   ├── 05_final.json           ← FinalDecision
│   │   └── traces/                 ← LLM 调用溯源（每次调用的完整输入输出）
│   │       ├── trace_001.json      ← 第 1 次 LLM 调用（market_analyst）
│   │       ├── trace_002.json      ← 第 2 次 LLM 调用（news_analyst）
│   │       ├── ...
│   │       └── trace_018.json      ← 第 18 次 LLM 调用（portfolio_manager）
│   ├── 2026-06-05_quick.json       ← 快速分析摘要
│   └── 2026-06-04_full.json        ← 历史报告
└── 000001/
    └── ...
```

### LLM 调用溯源（Trace）

每次 LLM 调用都记录完整的输入输出，存入 `traces/` 目录：

```typescript
interface LLMCallTrace {
  // 调用标识
  trace_id: string;                 // "trace_001"
  call_index: number;               // 1-18，调用顺序
  phase: string;                    // "analyst" | "debate" | "trader" | "risk" | "portfolio"
  role: string;                     // "market_analyst" | "bull_researcher" | ...

  // LLM 输入（完整）
  request: {
    model: string;                  // 实际使用的模型 "gpt-4o"
    system_prompt: string;          // 渲染后的完整 system prompt（含注入的数据）
    user_message: string;           // 用户消息（对于辩论角色，是前序论点）
    messages_history?: any[];       // 辩论角色的历史消息（如有）
    tools?: any[];                  // 暴露给 LLM 的工具定义（Phase 1 分析师有，其他无）
    temperature?: number;
    max_tokens?: number;
  };

  // LLM 输出（原始）
  response: {
    raw_content: string;            // LLM 返回的原始文本（解析前）
    parsed_content?: any;           // 解析后的结构化数据（如 AnalystReport、DebateState）
    parsed_verdict?: {              // 解析出的 VERDICT 机读块
      direction: string;
      reason: string;
    };
    tool_calls?: any[];             // 如果 LLM 请求了工具调用（Phase 1 分析师可能）
  };

  // 元数据
  meta: {
    timestamp: string;              // ISO timestamp
    duration_ms: number;            // 本次调用耗时
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    cost_usd?: number;             // 估算费用（按模型定价计算）
    data_sources_used?: string[];  // 实际使用了哪些数据脚本
  };
}
```

### 存储内容（摘要文件）

顶层的 `_full.json` / `_quick.json` 是摘要，包含最终决策 + 各阶段 verdict：

```typescript
interface AnalysisReport {
  id: string;                       // "600519_2026-06-05_full"
  ticker: string;
  company_name: string;
  date: string;
  mode: "full" | "quick";
  created_at: string;               // ISO timestamp
  duration_ms: number;              // 总耗时
  total_tokens: number;             // 所有 LLM 调用 token 总和
  total_cost_usd: number;           // 估算总费用

  // 最终决策（始终存在）
  final: FinalDecision;

  // 各阶段摘要
  analyst_verdicts: Record<string, { direction: string; reason: string }>;
  debate_summary?: string;
  risk_verdict?: "pass" | "revise" | "reject";

  // 指向详细文件的引用
  detail_dir: string;               // "2026-06-05_full/"
  trace_count: number;              // 18
}
```

### 溯源场景

**场景 1：为什么给了"买入"？**

```
打开 2026-06-05_full/05_final.json → 最终决策
打开 traces/trace_018.json         → portfolio_manager 的完整输入输出
  → request.system_prompt          → 看到它收到了什么信息
  → request.messages               → 看到前面的上下文
  → response.raw_content           → 看到它的原始推理过程
```

**场景 2：为什么政策分析师给了"利好"？**

```
打开 traces/trace_005.json          → 政策分析师的调用
  → request.system_prompt          → 看到注入的 prompt + 宏观新闻数据
  → response.raw_content           → 看到它的完整分析
  → meta.data_sources_used         → ["global_news.py"]
  → 打开 00_raw_data.json          → 查看 global_news 脚本返回的原始新闻
```

**场景 3：空头说了什么被反驳了？**

```
打开 traces/trace_009.json          → bear_researcher 的调用
  → response.raw_content           → 空头的完整论点
  → response.parsed_verdict        → 解析出的 claim
打开 traces/trace_010.json          → 下一轮 bull_researcher
  → request.user_message           → 看到多头如何反驳空头的论点
```

**场景 4：这次分析花了多少钱？**

```
打开 2026-06-05_full.json
  → total_cost_usd: 0.087
  → total_tokens: 125000
或查看 traces/ 下每个 trace 的 meta.cost_usd 汇总
```

### 用途

**1. 人类审查**

- 每份报告的 JSON 是完整的决策链条，可追溯"为什么最终给了买入"
- 可通过 Plugin 注册的 `trading_report` 工具查询历史报告
- 也可以直接在文件系统中浏览

**2. 下次分析复用**

```typescript
// 复用逻辑（可选，通过配置开启）
async function prepareAnalystData(ticker, date) {
  const cached = await loadRecentReport(ticker);

  // 基本面数据：如果上次报告在 3 天内，且不是财报披露季，直接复用
  if (cached && isWithinDays(cached.date, date, 3) && !isEarningsSeason(date)) {
    return {
      ...cached.raw_data,
      // 但这些数据始终重新获取（日内变动大）
      kline: await execPython("trading-kline/scripts/kline.py", { ticker }),
      fund_flow: await execPython("trading-hot-money/scripts/fund_flow.py", { ticker, date }),
      northbound: await execPython("trading-hot-money/scripts/northbound.py", { date }),
      news: await execPython("trading-news/scripts/news.py", { ticker, date }),
    };
  }

  // 无缓存或过期，全量获取
  return fetchAllData(ticker, date);
}
```

**数据新鲜度策略：**

| 数据类型 | 缓存有效期 | 理由 |
|----------|-----------|------|
| K 线/行情 | 不缓存 | 日内变动 |
| 资金流向 | 不缓存 | 日内变动 |
| 北向资金 | 不缓存 | 日内变动 |
| 新闻 | 不缓存 | 随时更新 |
| 基本面 (PE/PB/市值) | 1 天 | 日度更新 |
| 三大报表 | 7 天（非财报季）/ 1 天（财报季） | 季度披露 |
| 一致预期 EPS | 3 天 | 机构更新频率较低 |
| 龙虎榜 | 1 天 | 日度更新 |
| 解禁日历 | 7 天 | 变动频率低 |
| 概念板块 | 1 天 | 可能调整 |
| 行业排名 | 1 天 | 日度更新 |

**3. 对比分析**

Plugin 注册 `trading_compare` 工具，对比同一只股票不同日期的分析结果：

```
/trading_compare 600519 2026-06-03 2026-06-05
  → 展示两次分析的 verdict 变化、confidence 变化、direction 变化
  → 哪些分析师改了看法？为什么？
```

---

## 变更场景

| 变什么 | 改哪里 | 需要重启 OpenClaw |
|--------|--------|------------------|
| 东方财富接口变了 | `trading-hot-money/scripts/fund_flow.py` | ❌ |
| 限流策略调整 | 同上 .py 文件 | ❌ |
| 新增一个数据源 | 新建 Skill + 更新 trading-analysis 的 SKILL.md | ❌ |
| 调整分析师 prompt | `trading-analysis/prompts/analysts/xxx.md` | ❌ |
| 编排流程调整（多一轮辩论） | Plugin TS 代码 | ✅ |
| 新增分析策略 | 新建 Agent 实例 + 配置 | 不需要改 Plugin |
| 调换 LLM 模型 | openclaw.json 配置 | ❌ |

---

## 实施路线

```
Phase 1: MVP — 跑通一个分析师 + 最终决策
  ├─ 创建 trading-kline Skill（最简单的数据源）
  ├─ 创建 trading-analysis Skill（1 个 prompt）
  ├─ Plugin 注册 trading_quick 工具
  └─ 验证: /quick 600519 能返回分析结果

Phase 2: 补全分析师
  ├─ 创建其余 7 个数据 Skill
  ├─ 补全 7 个分析师 prompt
  └─ 验证: /quick 返回 7 个分析师的完整报告

Phase 3: 加入辩论机制
  ├─ 添加多/空研究员 prompt（Claim-based）
  ├─ 添加研究经理 prompt
  ├─ 添加交易员 prompt
  ├─ Plugin 实现 Phase 2-3 编排
  └─ 验证: /analyze 返回含辩论的分析

Phase 4: 加入风控
  ├─ 添加风险辩论三方 + 风控经理 prompt
  ├─ 添加投资组合经理 prompt
  ├─ Plugin 实现 Phase 4-5 编排 + revise 回路
  └─ 验证: /analyze 返回完整 5 阶段决策

Phase 5: 生产化
  ├─ Cron 定时任务配置
  ├─ 通知格式优化（Telegram/钉钉消息模板）
  ├─ 错误处理 + 日志
  └─ 后期：多策略 Agent 实例拆分
```
