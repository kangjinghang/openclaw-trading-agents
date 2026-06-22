# 股票池自动调仓模块（Portfolio Rebalancer）

> 最后更新：2026-06-22
> 状态：已实现，端到端跑通
> 关联：
> - 设计文档：[`superpowers/specs/2026-06-21-stockpool-rebalancer-design.md`](./superpowers/specs/2026-06-21-stockpool-rebalancer-design.md)
> - 实施计划：[`superpowers/plans/2026-06-21-stockpool-rebalancer.md`](./superpowers/plans/2026-06-21-stockpool-rebalancer.md)
> - 上游：[ranker 精排模块](./superpowers/specs/2026-06-18-llm-ranking-design.md)、[股票池基础管道](./superpowers/specs/2026-06-17-watchlist-stock-pool-design.md)

## 1. 概述

Portfolio Rebalancer 是 watchlist 管道的第 5 层，把 ranker 的 top-N 候选股 + 用户当前持仓 → 输出**今日调仓方案**（`BUY/SELL/ADD/REDUCE/HOLD` actions + 目标仓位 + 执行顺序），约束硬性满足，防短期反向交易，用户拿到就能执行。

**位置**：

```
universe → snapshot → diff → candidates → ranker (top-N)
                                                ↓
                                         portfolio-rebalancer  ← 本文档
                                                ↓
                                          plan.json + plan.md
                                                ↓
                                          用户手动执行
```

**核心特点**：

- **直接出方案**：不是观察名单、不是 Buy/Sell 二元判断，是带 target_weight 的 actions 序列
- **组合视角**：知道你已持什么、行业集中度、现金比例，单股分析服务组合决策
- **硬约束保证**：单仓/单行业/换手/现金/anti-churn 全部代码强制，LLM 拗不过来
- **反老好人**：强制分布、reason 写作规则、action 数量下限，治 LLM"全都好"的毛病

## 2. 为什么需要这个模块（不直接用 trading_quick/full）

现有的 `trading_quick` / `trading_full` 是**深度优先单股分析**：1 股 → 7 分析师 → 辩论 → 研究经理 → 交易员 → 风控辩论。股票池场景需要的是**广度优先组合决策**，两者错配：

| 维度 | trading_full | 股票池场景需要 |
|---|---|---|
| 触发 | 用户指定 ticker | ranker 自动驱动 |
| 视角 | 单股深度 | 跨股组合 + 持仓状态 |
| 产物 | Buy/Sell + 目标价（LLM 猜的） | 调仓 actions（基于组合约束） |
| 时间 | 单次快照 | 跨日 anti-churn + 持仓跟踪 |
| 决策 | 单股 pass/revise | 组合约束（单仓/行业/换手/现金） |

**LLM 给的目标价/止损基本不可信**（LLM 没有 DCF 模型，数字是猜的）。`trading_full` 输出 15 份独立 Buy 报告，用户仍不知如何分配资金。

Rebalancer 模块直接出调仓方案，把"15 股综合判断 + 组合约束"这个困难问题用一次 LLM 调用解决。

## 3. 架构总览

### 3.1 Pipeline 数据流

```
[输入]
holdings.json (用户手动维护)
scan.json (ranker 产物, top-N)
last_rebalance.json (上次调仓, 防反向)

   │
   ▼ ① holdings-loader
   │   （读 holdings.json, schema 校验, 计算 locked 状态）
   │
   ▼ ② candidate-selector
   │   （合并 ranker top-N + 持仓, 按 ticker 去重, 标 is_held/locked）
   │
   ▼ ③ data-fetcher (真实 Python scripts 并行)
   │   （kline + news + hot_money + fundamentals, 每股 4 个并行, 跨股 5 个 worker）
   │
   ▼ ④ shallow-analyzer (每股 2 LLM calls, 跨股 concurrency=3)
   │   ├─ Call 1: analyst-role → {thesis, fitness_score 0-10, key_signals, data_gaps}
   │   └─ Call 2: risk-role  → {risk_flags, overall_risk, deal_breaker}
   │   输出 per-stock StockReport
   │
   ▼ ⑤ rebalancer (1 LLM call, decision_deep 模型, temperature=0)
   │   （跨股决策: 输入 N 份 reports + holdings + 约束 + last_rebalance
   │    输出 REBALANCE_PLAN: evaluations + actions + summary
   │    ⚠️ LLM 只出**方向**（BUY/SELL/ADD/REDUCE/HOLD），不出数字）
   │
   ▼ ⑤b position-calculator (纯代码，确定性仓位计算器)
   │   （改写 LLM 的 actions：target_weight/delta/portfolio_after 全部由公式算
   │    公式：基础仓位(fitness查表) × 波动率折扣 × 风险因子
   │    再经：现金排队 + 单仓上限钳制
   │    deal_breaker 强制改 SELL）
   │
   ▼ ⑥ constraint-validator (10 条规则, 纯代码)
   │   （违反 → 回 ⑤ revise, max 2 次重试。校验的是改写后的 plan）
   │
   ▼ ⑦ execution-planner (纯代码)
   │   （排序 SELL→REDUCE→BUY→ADD, cash 累计, HOLD 过滤）
   │
   ▼
[输出]
~/.openclaw/watchlist/rebalance/{date}/plan.json + holdings_snapshot.json + traces/
~/.openclaw/watchlist/last_rebalance.json (覆盖写)
```

### 3.2 LLM 调用预算

| 阶段 | 模型 | 调用数 | 备注 |
|---|---|---|---|
| shallow-analyzer analyst-role | analyst-tier（glm-5.1） | 2 × N（N=10 默认）= 20 | 每股 1 次 |
| shallow-analyzer risk-role | 同上 | 2 × N = 20 | 每股 1 次 |
| rebalancer | decision-tier（glm-4.7+） | 1 + revise ≤2 | 整批 1 次 |
| **总（无 revise）** | — | **41** | — |
| **总（revise 满）** | — | **43** | — |

**实际运行时间**：8-12 分钟（含数据 fetch 30-60 秒、shallow-analyzer 跨股 worker pool concurrency=3）。

### 3.3 复用 vs Drop vs Add

| 类别 | 项 | 说明 |
|---|---|---|
| **复用** | `src/exec-python.ts` | 调 4 个 Python scripts |
| | `src/llm-client.ts` + `src/trace-logger.ts` | LLM 调用 + 审计 trace |
| | `src/watchlist/atomic-json.ts` | 原子写 JSON |
| | `src/prompt-loader.ts` | 模板渲染 |
| | 数据 scripts（kline/news/hot_money/fundamentals） | 按需调，不全跑 7 个 |
| | analyst / risk-debater prompt 模板 | 改造复用 |
| **Drop** | 7 分析师并行批跑 | 改单综合分析师 |
| | Bull/Bear 多轮辩论 | 留给"详情深度分析" |
| | trader 目标价/止损 | 改 `target_weight` |
| | Risk 3-way 辩论 | 改轻量 risk-role + validator |
| | Per-report quality-gate | 改 batch-level（后续 P2） |
| **Add** | holdings.json schema + loader | 用户手动维护 |
| | candidate-selector | ranker + 持仓合并 |
| | shallow-analyzer | 2 LLM call/股 |
| | rebalancer + REBALANCE_PLAN | 核心 LLM 决策 |
| | constraint-validator（10 规则） | 纯代码 |
| | execution-planner | 纯代码排序 |
| | data-fetcher | 跨股并行 Python |
| | revise loop | 仿 risk.ts，max 2 |

## 4. 输入与状态文件

### 4.1 `~/.openclaw/watchlist/holdings.json`（用户手动维护）

```json
{
  "updated_at": "2026-06-21T20:00:00+08:00",
  "cash_pct": 0.15,
  "positions": [
    {
      "ticker": "SH600519",
      "name": "贵州茅台",
      "weight": 0.20,
      "entry_price": 1700.0,
      "entry_date": "2026-05-20",
      "shares": 100,
      "sector": "白酒"
    }
  ]
}
```

**字段说明**：

- `weight` 是 0-1 小数（0.20 = 20%），`sum(positions.weight) + cash_pct = 1.0`
- `sector` 必填（约束检查要用），首次填后系统不动
- `entry_date` 用于 anti-churn（7 天锁定）

**校验**（`src/watchlist/holdings-loader.ts:validateHoldings`）：
- positions 必须是数组
- cash_pct 在 [0, 1]
- 每个 position 必须有非空 sector
- entry_date 格式 `YYYY-MM-DD`
- `sum(weights) + cash_pct = 1.0`（±0.001 容差）

不通过则 abort，提示用户修正。系统不修复用户数据（避免悄悄改）。

### 4.2 `~/.openclaw/watchlist/last_rebalance.json`（系统覆盖写）

```json
{
  "date": "2026-06-21",
  "actions": [
    { "action": "BUY", "ticker": "SH600183", "weight": 0.10 },
    { "action": "SELL", "ticker": "SZ000002", "weight": 0.05 }
  ]
}
```

**作用**：下次跑时检查"7 天内买入的不卖 / 7 天内卖出过的不重买"。

### 4.3 `scan.json` 引用

直接读 ranker 产物 `~/.openclaw/watchlist/scan/{date}/scan.json`，取 `top_picks` 前 N 支（默认 10）作为候选。

## 5. 组件详解

### 5.1 holdings-loader（`src/watchlist/holdings-loader.ts`）

**核心函数**：

- `loadHoldings(filePath)`：读 JSON + schema 校验，失败抛错
- `validateHoldings(h)`：返回 `{ok, error}`
- `computeLocked(entryDate, currentDate, antiChurnDays)`：算某 entry 是否在锁定窗口

**computeLocked 边界处理**：

- `antiChurnDays=0` → 永不锁定（用户禁用 anti-churn）
- entry_date 格式错误 → false（防御性，不阻塞 pipeline）
- entry_date 在未来 → false（防御性）

### 5.2 candidate-selector（`src/watchlist/candidate-selector.ts`）

**`selectCandidates(scan, holdings, opts)`**：

1. 取 `scan.top_picks.slice(0, topN)`（默认 10）
2. 合并 `holdings.positions`（去重：若 ticker 已在候选，覆盖持仓信息）
3. 对每个 ticker 计算 `is_held / current_weight / days_held / locked`
4. 返回 `CandidateMeta[]`（约 12-16 只）

**输出示例**：

```typescript
[
  { ticker: "SZ300319", name: "麦捷科技", is_held: true, current_weight: 0.05, days_held: 6, locked: true, ranker_score: 9.2 },
  { ticker: "SH600183", name: "生益科技", is_held: false, current_weight: 0, days_held: 0, locked: false, ranker_score: 9.0 },
  // ...
]
```

### 5.3 data-fetcher（`src/watchlist/data-fetcher.ts`）

**`fetchAllStockData(metas, concurrency=5)`**：

跨股 worker pool（concurrency=5），每股并行跑 4 个 Python scripts：

| Script | 路径 | 输出字段 |
|---|---|---|
| kline.py | `skills/trading-kline/kline.py` | `closes` → `pct_5d, pct_20d, support, resistance` |
| news.py | `skills/trading-news/news.py` | `news[].title` → top 5 |
| hot_money.py | `skills/trading-hot-money/hot_money.py` | `net_5d` |
| fundamentals.py | `skills/trading-fundamentals/fundamentals.py` | `pe_ttm, pb, revenue_q1, net_profit_q1` |

**容错**：单 script 失败（任何原因）→ 该字段填 0/[]，**不阻塞该股的 shallow-analyzer**。LLM 会看到 `data_gaps` 标注。

**parseKline 算法**：
- `pct_5d` = (last - closes[-6]) / closes[-6] × 100
- `pct_20d` = (last - closes[-21]) / closes[-21] × 100（不够 21 用 closes[0]）
- `support` = min(最近 5 日收盘)
- `resistance` = max(最近 5 日收盘)

### 5.4 shallow-analyzer（`src/watchlist/shallow-analyzer.ts`）

**每股 2 次 LLM call**（单股内串行，跨股 concurrency=3）：

#### Call 1: analyst-role（评估 thesis + fitness）

输入：ticker + name + sector + kline/news/hot_money/fundamentals 摘要 + ranker thesis（候选股才有）

输出 JSON：
```typescript
{
  thesis: string,                    // 必须 含具体词，禁模糊词
  fitness_score: number,             // 0-10，组合视角的吸引力
  data_freshness: string,            // "YYYY-MM-DD"
  key_signals: string[],             // 3-5 条关键信号
  data_gaps: string[]                // 哪些数据缺失/失败
}
```

#### Call 2: risk-role（识别风险）

输入：同 Call 1 数据 + Call 1 的 thesis

输出 JSON：
```typescript
{
  risk_flags: Array<{
    flag: string,                    // 如"估值过高"
    severity: "低" | "中" | "高",
    detail: string                   // 具体描述，含数据
  }>,
  overall_risk: "low" | "medium" | "high",
  deal_breaker: boolean              // true = 建议直接拒绝
}
```

`deal_breaker=true` 仅限：财务造假、退市风险、重大违规、产品/客户重大断裂等灾难性情况。

#### 综合 StockReport

合并 meta + analyst + risk：

```typescript
{
  ticker, name, sector,
  thesis, fitness_score, key_signals, data_gaps,
  risk_flags, overall_risk, deal_breaker,
  is_held, current_weight, days_held, locked,
  ranker_score?
}
```

#### 为什么是 2 calls 不是 1

| 单 call 合并 | 双 call 分离 |
|---|---|
| 1 个 LLM 同时做"看多 + 看空"会偏向乐观 | analyst 专注看多，risk 专注看空 |
| prompt 臃肿（既要 thesis 又要 risks） | 每个 prompt 单一职责 |
| fitness 容易被 risk 弱化或反过来 | 两者独立产出，组合层判断 |

代价：调用量翻倍。但单 call 质量不可靠。

#### 并发限制（concurrency=3）

实测智谱 glm-5.1 free tier 在并发 ≥5 时触发 HTTP 429。worker pool concurrency=3 + 单股内 analyst→risk 串行 = 任意时刻最多 3 个 LLM call。10 股 × 2 calls = 20 calls 顺序约 3-5 分钟跑完。

### 5.5 rebalancer 核心（`src/watchlist/rebalancer.ts`）

#### LLM 配置

- 模型：`decision_deep`（用户 config `models.rebalancer`，fallback `decision`，再 fallback `glm-4.7`）
- Temperature：**0.0**（调仓必须确定性，同输入同输出，便于复盘）
- Phase：`"rebalance"`
- Role：`"portfolio-rebalancer"`

#### Prompt 5 段结构

1. 角色 + 任务流程（必须按顺序思考：先评估 → 后配置 → 排序 → 自检）
2. 评估框架（候选股 vs 持仓股各自规则）
3. 硬约束 + 软偏好
4. 反"老好人"硬规则 + reason 写作规则
5. 输出格式（严格 JSON）

#### 输出 REBALANCE_PLAN

```json
{
  "evaluations": [
    { "ticker": "...", "judgment": "BUY|HOLD|REDUCE|SELL|SKIP", "brief": "1 句评估" }
  ],
  "actions": [
    {
      "action": "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD",
      "ticker": "...", "name": "...",
      "current_weight": 0.0, "target_weight": 0.0, "delta": -0.10,
      "reason": "...", "priority": 1
    }
  ],
  "portfolio_after": {
    "positions": [{"ticker": "...", "weight": 0.0}],
    "cash_pct": 0.0
  },
  "summary": "一句话总结"
}
```

#### Action 类型语义（严格）

| Action | current | target | delta | priority | 何时用 |
|---|---|---|---|---|---|
| BUY | 0 | >0 | + | 3 | 新建仓位 |
| SELL | >0 | 0 | - | 1 | 清仓退出 |
| ADD | >0 | >current | + | 4 | 加仓（不新建） |
| REDUCE | >0 | (0, current) | - | 2 | 减仓（不清仓） |
| HOLD | >0 | =current | 0 | 5 | 维持不变 |

#### evaluations 字段的作用

强制 LLM **先逐股独立评估**再下 action（chain-of-thought 强制化）：
- 每只候选/持仓必须有一条 evaluation
- `judgment` 必须跟 `actions` 里的 `action` 对齐（SKIP 对应无 action）
- 防止 LLM 跳过思考直接出 actions

#### portfolio_after 字段的作用

让 LLM **主动验证自己方案的合理性**：
- `sum(positions.weight) + cash_pct` 必须 = 1.0（±0.001）
- validator 会校验，不等于 1 直接打回
- LLM 自己算总账，减少算术错误

#### 反 LLM 老好人机制

继承 ranker 经验，加 3 条硬约束：

1. **强制动作数量下限**：fitness ≤5 的持仓必须 REDUCE 或 SELL（不准 HOLD 蒙混）
2. **禁止全 HOLD**：actions 不能全是 HOLD，**除非**所有持仓 fitness ≥7 + 所有候选 fitness <6 + 无 deal_breaker（"今日低 activity"是合法状态，summary 必须明示）
3. **强制分布**：fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限

#### 边界情况

| 情况 | 处理 |
|---|---|
| 候选全 fitness <6 | 允许输出全 HOLD + summary "今日无机会" |
| 持仓全 fitness ≥8 + 高 cash | 输出 BUY 用掉部分 cash |
| cash_pct <10% | 必须先 SELL/REDUCE 释放 cash，再 BUY |
| 7 天 anti-churn 锁死所有持仓 | 只能 BUY 新候选，不能动现有持仓 |
| LLM 输出 sum(weight) ≠ 1 | validator 打回，revise loop |
| LLM 给 locked 股出 SELL | validator 打回，要求改 HOLD/ADD |

### 5.6 position-calculator 确定性仓位计算器（`src/watchlist/position-calculator.ts`）

> **2026-06-22 新增**：把 target_weight 的决定权从 LLM 手里拿走，交给可解释、可复盘的公式。LLM 只决定**方向**（BUY/SELL/ADD/REDUCE/HOLD），公式根据 fitness + 波动率 + 风险等级算出**数字**。

#### 设计动机

原设计中 LLM 既出方向又出 target_weight，导致：
- **仓位凭 AI 感觉**：prompt 给区间（"5%-10%"），AI 在区间内拍数字，无量化依据
- **复盘是空话**：temperature=0 本意"同输入同输出便于复盘"，但仓位是黑箱，无法判断"为什么是 7%"
- **分数与仓位脱节**：两只分数相同的股，仓位可能差一倍

详见 [§11.11 为什么仓位用公式不用 LLM](#1111-为什么仓位用公式不用-llm)。

#### 核心公式

```
目标仓位 = 基础仓位(fitness查表) × 波动率折扣 × 风险因子
再经：现金排队（按分数花钱）+ 单仓上限钳制
```

#### 基础仓位档位（平衡档，可调）

| fitness | 基础仓位 | 含义 |
|---------|---------|------|
| ≥9 | 7% | 特别好，给足 |
| 8 | 5% | 好 |
| 8.5 | 6%（线性插值） | — |
| 7 | 3% | 还行，试探 |
| ≤6 | 0%（不买） | 不达标 |

#### 波动率折扣（20 日日收益率标准差）

| 波动率/日 | 折扣 | 典型 |
|-----------|------|------|
| <2% | ×1.0 | 大盘股、白酒 |
| 2-4% | ×0.8 | 普通成长股 |
| >4% | ×0.6 | 题材股、次新 |

#### 风险因子（来自 shallow-analyzer 的 overall_risk）

| 风险等级 | 因子 |
|---------|------|
| low | ×1.0 |
| medium | ×0.6 |
| high | ×0.3 |
| deal_breaker | **强制 SELL（0）** |

#### Action 类型对应的目标仓位

| Action | 目标仓位算法 | 说明 |
|--------|------------|------|
| BUY | 基础仓位 × 波动率 × 风险 | 完整公式 |
| ADD | max(当前仓位, 基础仓位档) | 加到档位为止，不到不动 |
| HOLD | = 当前仓位 | 不动 |
| REDUCE | 当前仓位 × 50% | 减半 |
| SELL | 0 | 清仓 |
| deal_breaker（任何方向） | 0 + 改 action 为 SELL | 致命雷覆盖 AI 判断 |

#### 计算示例

| 股票 | 方向 | fitness | 波动率 | 风险 | 基础 | ×波动 | ×风险 | =目标 |
|------|------|---------|--------|------|------|-------|-------|-------|
| A | BUY | 9 | 1.5%/日 | low | 7% | ×1.0 | ×1.0 | **7.0%** |
| B | BUY | 9 | 2.5%/日 | medium | 7% | ×0.8 | ×0.6 | **3.36%** |
| C | BUY | 8 | 5%/日 | high | 5% | ×0.6 | ×0.3 | **0.9%**（观察仓） |
| D | REDUCE | — | — | — | — | — | — | 当前 10% → **5%** |
| E | deal_breaker | — | — | — | — | — | — | 强制 **0% + SELL** |

每个数字都能往前追溯到原因（"9 分基础 7%，因为波动 2.5% 打 8 折，因为风险 medium 打 6 折 = 3.36%"），这才是真正的**可复盘**。

#### 现金排队

多只股都要 BUY 时，按 fitness 降序排队，现金不够的低分股降级为 HOLD：

```
可用现金 = 初始现金 + SELL/REDUCE 释放 - 现金下限(10%)
→ 高分股先买满，低分股现金不够就 HOLD
```

#### 接入点

在 `runRebalanceWithRevise` 内部，`parseRebalancePlan` 之后、`validateRebalance` 之前调用 `applyPositions`。这让 revise loop 看到的是改写后的 plan，validator 校验的是公式算的仓位（不是 LLM 拍的）。

#### 顺带修复的阻塞 bug

实现波动率折扣时发现 `data-fetcher.ts` 的 `parseKline` 读的是不存在的 `raw.closes` 字段（kline.py 实际输出 `raw.data: [{close}]`），导致线上 `pct_5d/pct_20d/support/resistance` **一直恒为 0**。本次一并修复：从 `raw.data` 抽 close，并新增 `volatility_20d` 字段。

### 5.7 constraint-validator（`src/watchlist/constraint-validator.ts`）

#### 10 条规则（纯代码）

| # | 规则 | 校验逻辑 | 失败反馈示例 |
|---|---|---|---|
| 1 | 权重和 = 1 | `abs(sum(target_weight) + cash_pct - 1.0) ≤ 0.001`（含 HOLD） | "权重和 0.97，差 0.03" |
| 2 | 单仓 ≤15% | `max(target_weights) ≤ single_name` | "SZ300319 weight 0.18 超 0.15" |
| 3 | 单行业 ≤30% | 按 sector 聚合 sum | "PCB 行业 0.35 超 0.30" |
| 4 | 日换手 ≤30% | `sum(abs(delta)) ≤ daily_turnover` | "换手 0.35 超 0.30" |
| 5 | 现金 ≥10% | `1 - sum(target_weight) ≥ cash_reserve` | "现金 0.08 不足 0.10" |
| 6 | Anti-churn 卖锁 | `days_held < 7` 的不能 SELL/REDUCE | "SZ300319 持仓 5 天 locked" |
| 7 | Anti-churn 买锁 | last_rebalance 7 天内 SELL 的不能 BUY | "SH600519 7 天内刚卖过" |
| 8 | Action 一致性 | BUY/SELL/ADD/REDUCE/HOLD 各自的 current/target 关系 | "BUY 但 current>0 矛盾" |
| 9 | Ticker 在候选池 | 不在候选/持仓的幻觉 ticker | "SH000999 不在评估范围" |
| 10 | sector 非空 | `target_weight>0` 的必须有 sector | "SZ300319 缺 sector" |

#### Revise loop

```
rebalancer 输出 plan
    ↓
validator.checkAll(plan)
    ↓
violations = [...]
    ↓
if violations.empty → 通过，进 execution-planner
    ↓ 否则
composeReviseFeedback(violations) 拼反馈字符串
    ↓
回 rebalancer LLM revise（带原 prompt + 反馈）
    ↓
max 2 次重试
    ↓ 用尽后
保留 last_attempt + status: "constraint_violation" + 违反清单
输出给用户人工裁决
```

#### Revise feedback 示例

```
你的上一次方案违反了以下约束，请修正：

1. [2. 单仓上限] SZ300319 target_weight 0.18 超 0.15 上限
2. [3. 单行业上限] PCB 行业 sum 0.35 超 0.30 上限
3. [4. 日换手上限] sum(|delta|) 0.35 超 0.30 上限

请重新输出 REBALANCE_PLAN，确保满足所有硬约束。
```

### 5.8 execution-planner（`src/watchlist/execution-planner.ts`）

**`buildExecutionPlan(plan, initialCash)`**：

```
1. 过滤 HOLD actions（不产生执行步骤，但保留在 plan.json 里）
2. 按 priority 排序：SELL(1) → REDUCE(2) → BUY(3) → ADD(4)
3. 同 priority 内按 |delta| desc（大的先）
4. 累计 cash：
   - SELL/REDUCE 后 cash 增加
   - BUY/ADD 前 cash 必须够
   - 不够 → 标 warning，调整后续 BUY 顺序
5. 输出 execution_sequence
```

**A 股特殊性**：
- T+1：同一 ticker 不能在同 plan 里既 BUY 又 SELL（防 LLM 错乱，validator 规则 #8 覆盖）
- 涨跌停板：plan 层不管（broker 那边的事），假设都能执行
- 最少 100 股（1 手）：plan 层用 weight 不用 shares，broker 下单时再换算

## 6. 输出文件结构

```
~/.openclaw/watchlist/rebalance/{date}/
├── plan.json              # 完整 REBALANCE_PLAN + per-stock reports + constraint_result + execution_plan
├── holdings_snapshot.json # 跑前 holdings 快照（复盘用）
└── traces/                # LLM 调用 traces（同 scan_date 内覆盖写）
```

`~/.openclaw/watchlist/last_rebalance.json`（每次跑后覆盖）。

### 6.1 plan.json schema

```typescript
interface RebalancePlanFile {
  scan_date: string;
  written_at: string;
  status: "ok" | "constraint_violation" | "llm_failed";
  model: string;
  tokens: number;
  // 输入快照
  holdings_before: Holdings;
  candidates: Array<{ ticker: string; ranker_score: number }>;
  last_rebalance: LastRebalance | null;
  // shallow-analyzer 产物
  reports: StockReport[];
  // LLM 原始输出
  rebalancer_output: {
    evaluations: Array<{ ticker, judgment, brief }>;
    actions: Action[];
    portfolio_after: { positions, cash_pct };
    summary: string;
  };
  // 约束校验
  constraint_check: {
    passed: boolean;
    violations: string[];
    revise_count: number;
  };
  // 执行序列
  execution_plan: ExecutionPlan;
}
```

## 7. 实际运行示例（2026-06-18）

### 输入

- 持仓：2 支（SZ300319 麦捷科技 10%、SH600183 生益科技 10% + 80% cash）
- 候选：ranker top-10（含 SZ301377 鼎泰高科 9.5、SZ300522 世名科技 9.5 等）
- last_rebalance：空（首次运行）

### 运行统计

- 数据 fetch：10/10 只股拿到完整数据（4 scripts × 10 stocks 并行 5）
- shallow-analyzer：10/10 reports 完成（concurrency=3，无 429）
- rebalancer：1 次成功，**revise 0 次（一次过 validator）**
- tokens：36K
- status：**ok**

### LLM 决策

**Shallow-analyzer 报告摘要**：

| ticker | 持仓 | fitness | risk | 关键判断 |
|---|---|---|---|---|
| SZ301377 鼎泰高科 | 候选 | 2 | medium | 钻针国产替代早期，港股发行不确定 |
| SZ300522 世名科技 | 候选 | 1 | high | 光刻胶分散液实验室阶段，**零营收** |
| SZ300319 麦捷科技 | **持仓** | 6 | medium | TLVR 电感已批量供货英伟达，传统业务拖累 |
| SZ301630 同宇新材 | 候选 | 3 | medium | PPO 树脂认证刚完成，地缘事件驱动逻辑脆弱 |
| SZ300285 国瓷材料 | 候选 | 2 | medium | 氧化锆断供替代预期尚未兑现为订单 |
| SH600183 生益科技 | **持仓** | 5 | medium | PTFE 国际标准，但 PCB 强周期 + AI 需求集中度风险 |
| SH605589 圣泉集团 | 候选 | 5 | medium | PPE 树脂满产满销，海外复产风险高 |
| SZ300491 通合科技 | 候选 | 4 | high | 台达单一客户集中度过高 |
| SH600392 盛和资源 | 候选 | 3 | medium | 5N 氧化镝量产，主营稀土周期性强 |
| SH600378 昊华科技 | 候选 | 3 | medium | 英伟达 PTFE 供货**为传闻**存证伪风险 |

**调仓方案**：

```
[P1] REDUCE SH600183 生益科技 10%→5% (-5%)
     reason: fitness=5触发硬性减仓规则，PCB行业强周期叠加AI需求集中度风险，
            Q1净利+105%已有反映，先减半释放资金

[P2] HOLD SZ300319 麦捷科技 10%→10% (0%)
     reason: TLVR电感已批量供货并取得英伟达研发权限，
            fitness=6且处于锁定窗口期，维持仓位等待订单放量验证
```

**其他 8 只候选股全 SKIP**：fitness 都 ≤5，未达入组门槛（要求 ≥7）。

**Portfolio after**：SZ300319 10% + SH600183 5% + cash 85%。

**LLM summary**：

> 全部候选fitness≤5不达入组标准，仅对持仓中生益科技执行减半至5%以遵守硬规则，麦捷科技锁定持有，保留85%现金等待高质量标的

### 这个结果好在哪里

1. **shallow-analyzer 是真分析**：
   - 识别"零营收"（世名科技）、"传闻未证实"（昊华科技 PTFE）、"单一客户风险"（通合科技→台达）
   - 每只股给具体的 fitness（1-6），不是统一 8.5 的橡皮图章

2. **rebalancer 决策有纪律**：
   - 持仓里 SH600183 fitness=5 触发硬减仓（没蒙混 HOLD）
   - 10 个候选没一个达 BUY 门槛（≥7），不强买
   - 保留 85% cash：没信号就别动

3. **reason 没有模糊词**：
   - "PCB行业强周期叠加AI需求集中度风险，Q1净利+105%已有反映"
   - "TLVR电感已批量供货并取得英伟达研发权限"
   - "锁定窗口期"
   - 全部含具体词，没"共振/活跃/资金追捧"

4. **一次过 validator**：
   - 权重和 10%+5%+85% = 100% ✓
   - 单仓 max 10% ≤ 15% ✓
   - 单行业 max 10% ≤ 30% ✓
   - 换手 5% ≤ 30% ✓
   - 现金 85% ≥ 10% ✓
   - SH600183 持仓 >7 天（不 locked），可 REDUCE ✓
   - 无 7 天内 SELL 过的，无买锁触发 ✓
   - 所有 action 的 current/target 关系一致 ✓
   - LLM 没幻觉 ticker ✓
   - 所有 target>0 的有 sector ✓

## 8. 配置参数

### 8.1 `openclaw.json` 默认值

```json
{
  "plugins": {
    "entries": {
      "trading-agents": {
        "config": {
          "models": {
            "rebalancer": "glm-4.7"
          },
          "rebalance": {
            "top_n": 10,
            "constraints": {
              "single_name": 0.15,
              "single_sector": 0.30,
              "daily_turnover": 0.30,
              "cash_reserve": 0.10
            },
            "anti_churn_days": 7,
            "max_revise_retries": 2,
            "run_optional_scripts": false
          }
        }
      }
    }
  }
}
```

### 8.2 CLI 参数

```bash
npm run rebalance -- [options]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--date <D>` | 最新 scan | 指定日期 |
| `--top-n <N>` | 10 | 从 ranker top_picks 取前 N |
| `--single-name <F>` | 0.15 | 单仓上限 |
| `--single-sector <F>` | 0.30 | 单行业上限 |
| `--daily-turnover <F>` | 0.30 | 日换手上限 |
| `--cash-reserve <F>` | 0.10 | 现金下限 |
| `--anti-churn-days <N>` | 7 | 锁定天数，0 = 关闭 |
| `--no-anti-churn` | - | 等价 `--anti-churn-days 0` |
| `--max-revise <N>` | 2 | revise 最大次数 |
| `--model <M>` | glm-4.7 | rebalancer 模型 |
| `--api-key <K>` | env | OpenAI 兼容 key |
| `--base-url <U>` | env | OpenAI 兼容 base URL |
| `--help` | - | 显示帮助 |

### 8.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WATCHLIST_DIR` | `~/.openclaw/watchlist` | 存储路径 |
| `OPENAI_API_KEY` | - | API key（fallback） |
| `OPENAI_BASE_URL` | - | base URL（fallback） |
| `TRADING_PYTHON` | `python3` | Python 解释器路径 |

## 9. 错误处理

| 错误 | 处理 |
|---|---|
| holdings.json 缺 | abort + 打印 template 让用户首次创建 |
| holdings.json sum ≠ 1 | abort + 指出哪只权重有误（不自动修复用户数据） |
| scan.json (ranker) 缺 | abort + 提示 `npm run rank` |
| 单股 script 失败 | report 标 `data_gaps`，仍送 LLM |
| 单股 shallow-analyzer LLM 失败 | 该股跳过（rebalancer 看不到） |
| rebalancer LLM 失败 | 整个失败（核心决策不能降级），用户重跑 |
| JSON 解析失败 | revise 1 次 |
| 约束违反 | revise max 2 次 |
| revise 用尽 | 输出 last_attempt + `status: "constraint_violation"` + 违反清单，用户人工裁决 |

## 10. 实现文件清单

```
src/
  rebalance-cli.ts                          # CLI 入口
  watchlist/
    rebalance-types.ts                      # Holdings/Action/Plan/StockReport 类型
    holdings-loader.ts                      # 读 holdings + 校验 + computeLocked
    candidate-selector.ts                   # ranker top-N + 持仓合并 + 标 locked
    data-fetcher.ts                         # 跨股并行 Python (kline/news/hot_money/fundamentals) + volatility_20d
    shallow-analyzer.ts                     # analyst + risk 双 call + analyzeAll 并发池
    position-calculator.ts                  # ⭐ 确定性仓位计算器（公式驱动 target_weight）
    constraint-validator.ts                 # 10 规则 + composeReviseFeedback
    rebalancer.ts                           # prompt + parse + revise loop + applyPositions 接入 + 主入口 pipeline
    execution-planner.ts                    # 排序 + cash 累计
tests/ts/watchlist/
  holdings-loader.test.ts                   # 7 tests
  candidate-selector.test.ts                # 5 tests
  constraint-validator.test.ts              # 16 tests
  execution-planner.test.ts                 # 5 tests
  shallow-analyzer.test.ts                  # 12 tests
  rebalancer.test.ts                        # 13 tests（含 integration：deal_breaker 强制 SELL / 现金不足降级）
  position-calculator.test.ts               # ⭐ 35 tests（基础查表/波动率/风险/现金排队/deal_breaker）
  data-fetcher.test.ts                      # 11 tests（含 volatility_20d + data 对象数组真实结构）
```

**总计**：watchlist 子系统 197 个单测全部通过。整个项目 639 tests。

## 11. 设计权衡与教训

这一节讲选型决策的"为什么"，记下来便于后续调整时参考。

### 11.1 为什么是 Architecture 2（每股 2 calls + 1 rebalancer call）

候选过的 3 个架构：

| 架构 | LLM 调用 | 时间 | 选 / 不选 理由 |
|---|---|---|---|
| **Lite**（每股 1 call 全干） | N+1 ≈ 11 | 3-5 min | ✗ 单 LLM 同时做数据分析+thesis+风险+fitness，prompt 臃肿，糊弄 |
| **Medium**（每股 2 calls 分 analyst+risk） | 2N+1 ≈ 21 | 8-12 min | ✓ 选这个。职责分离，跟现有 analyst+risk 同源 |
| **Heavy**（每股 = trading_quick 8 calls） | 8N+1 ≈ 81 | 30-45 min | ✗ 跟用户初衷"不要 trading_full 那套"冲突 |

Lite 的核心问题：1 个 LLM 调用同时做 4 件事，质量必然差。Medium 把 analyst（看多）和 risk（看空）拆开，各自单一职责。

### 11.2 为什么是 decision_deep 模型 + temperature=0

- **decision_deep**：rebalancer 是跨股综合判断，跟 research-manager / risk-manager 同档（reasoning 密集）
- **temperature=0**：调仓必须确定性。同输入应该出同样方案，便于复盘。如果今天出 BUY 明天出 SELL，无法判断是"模型变化"还是"决策改善"

### 11.3 为什么 reason 写作规则要白/黑名单

实测首轮 LLM 输出（无约束）：
- "板块共振强烈，资金追捧，爆发力强"（全模糊词）
- "PCB链共振，资金涌入"（行业 + 模糊）

加上**白名单**（产品/客户/数据/业务节点）+ **黑名单**（共振/资金追捧/活跃/爆发力强）后：
- 0/15 含模糊词
- 14/15 含具体词

LLM 训练语料里 A 股自媒体常用"板块共振"这类空话，不用黑名单压不住。

### 11.4 为什么强制分布

LLM 老好人综合症——倾向给所有股打高分。实测首轮跑出：
- LONG score 8.3-10.0（跨度 1.7 分）
- SHORT score 8.3-10.0（中位 9.1，还给了 10.0 满分）

下游拿到 15 支并列第一，失去了"top_picks 优先级"的本意。加强制分布硬约束（top-1 ≥9.3、末位 ≤7.5、跨度 ≥2.0）后：
- 跨度从 1.7 → 2.5
- 没有 10.0 满分了
- 末位分数 7.1，符合"末位 ≤7.5"

### 11.5 为什么有反"老好人"硬规则

加强制分布后，LLM 学会了拉低分数，但学会了**另一个偷懒**：所有股都 HOLD，0 actions。

这违背了引入 LLM 的初衷（决策）。加硬规则：
- fitness ≤5 的持仓必须 REDUCE 或 SELL（不准 HOLD 蒙混）
- actions 不能全是 HOLD（除非有合法理由 + summary 明示）
- fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限

实测首轮 2026-06-18：LLM 乖乖给 SH600183 出 REDUCE（fitness=5 触发硬减仓），没蒙混。

### 11.6 为什么约束违反要 revise 而不是直接 abort

LLM 算错权重和、超单仓上限这种事很常见。直接 abort 体验差。revise loop：
- 拼反馈字符串给 LLM
- LLM 调整后重试
- max 2 次
- 用尽后保留 last_attempt + status: "constraint_violation"，用户人工裁决

实测：大多数违规 LLM 一次 revise 就能修。完全用尽的概率低。

### 11.7 为什么 anti-churn 是双向的

- **卖锁**（持仓 <7 天不能 SELL/REDUCE）：避免刚买就卖，给 thesis 兑现时间
- **买锁**（7 天内 SELL 过的不能 BUY）：避免刚卖又买，反复交易手续费 + 滑点

**实测坑**：用户维护 holdings.json 时，entry_date 要写对。如果写错（如把 2026-06-15 写成 2026-06-21），所有持仓都会 locked，rebalancer 只能 BUY 新股不能动现有仓位。

### 11.8 为什么 concurrency=3 不是更高

实测智谱 glm-5.1 free tier：
- concurrency=10（无限制）：5/10 股触发 HTTP 429
- concurrency=5：仍偶发 429
- concurrency=3：10/10 全完成

代价：10 股 × 2 calls = 20 calls，concurrency=3 大约 3-5 分钟跑完。能接受。

如果用付费档（不限 RPM），可以调高 concurrency 缩短到 1-2 分钟。代码里有参数。

### 11.9 为什么 data-fetcher 失败容忍而不是严格失败

数据 script 失败原因多：网络抖动、限流、源站问题、数据缺失（新股没 fundamentals）。

如果 1 个 script 失败就 abort 整批，10 股就跑不起来。容错策略：
- 单 script 失败 → 该字段填 0/[]，标 `data_gaps`
- LLM 看到 data_gaps，会在 evaluations 里说明"数据缺失导致评估盲区"
- 仍能产出有用判断（基于现有数据的部分判断 > 完全不判断）

实测 2026-06-18 跑：SZ300491 通合科技 fundamentals 缺失，LLM 仍能基于 kline/news 判断 fitness=4 + risk=high，理由是"台达单一客户集中度过高"+"输入数据缺失导致的评估盲区"。

### 11.10 为什么 revise loop max 2 而不是 1 或 5

- **1 太少**：rebalancer 比 risk manager 复杂（10 条约束 vs risk 的 3 维），首次违反 1 条 + revise 1 次修另一条很常见
- **5 太多**：token 成本飙升，且如果 LLM 修不好，5 次也修不好，是 prompt 问题
- **2 合适**：跟 `risk.ts` 的 `max_risk_retries=1` 同量级，稍微宽松一点

实测：max 2 已经足够。

### 11.11 为什么仓位用公式不用 LLM

**原设计**：LLM 既出方向（BUY/SELL）又出 target_weight（5%-10% 区间内凭感觉）。

**问题**：
1. **仓位凭 AI 感觉**：prompt 给区间（"5%-10%"），AI 在区间内拍数字，无量化依据。两只分数相同的股，仓位可能差一倍。
2. **复盘是空话**：temperature=0 本意"同输入同输出便于复盘"，但仓位是黑箱——你不知道 7% 是经过算的，还是 AI 随手写的。下次同样的输入，它可能给 8%。
3. **分数与仓位脱节**：validator 只查上限（≤15%），查不了"为什么是 7% 不是 8%"。
4. **看空 AI 的 risk 等级形同虚设**：LLM 标了 "high risk"，但仓位数字还是它拍的，risk 标签不影响最终仓位。

**改法**：把 LLM 的工作从"出方向 + 出数字"收缩为"只出方向"。具体数字交给确定性公式：

```
目标仓位 = 基础仓位(fitness查表) × 波动率折扣 × 风险因子
```

- fitness 9 → 7% 基础（不是 AI 拍）
- 波动率 2.5%/日 → 打 8 折（数据驱动，不是 AI 拍）
- risk medium → 打 6 折（看空 AI 的判断落到仓位上）
- = 3.36%（可追溯到每一步）

**这解决了什么**：
| 原病 | 治法 |
|------|------|
| 仓位凭 AI 感觉，复盘是空话 | 每个数字有公式，改公式能算"如果波动折扣更狠会怎样" |
| 分数和仓位脱节 | 分数相同→基础仓位相同，差异只来自客观数据（波动/风险） |
| temperature=0 的"确定性"被抵消 | 现在真确定了：同输入→同公式→同仓位 |
| 看空 AI 的 risk 等级形同虚设 | risk 直接进公式，high risk 仓位砍到 30% |

**代价**：牺牲了 LLM 对仓位的"灵活性"。如果某只股 AI 觉得该重仓（有 prompt 外的判断），公式不会通融——它严格按 fitness/波动率/风险算。这是**有意的取舍**：确定性 > 灵活性，因为基金经理最核心的能力（定仓位）必须可解释、可复盘。

**ADD 不打折的设计取舍**：ADD 是加仓（已有持仓），波动率/风险在当初 BUY 时已经算过。ADD 只是把仓位加到 fitness 对应的档位为止（max(当前, 基础档)），不重新打折。这避免"加仓时又被砍一刀"的双计问题。

**校准路径**：公式档位（9分→7% / 8分→5% 等）先用经验值。跑一个月后回头看：那些买了的股，事后表现怎么样？分数 9 的普遍比分数 8 的好吗？如果不好，说明分数→仓位映射要调。这才是真正的"复盘"——复盘的对象从"AI 为什么拍 7%"（黑箱，没法复），变成"公式参数对不对"（白盒，能调）。

## 12. 测试策略

沿用 ranker 模式（mock LLM + 假数据 + 不触网）：

### 12.1 Unit tests（每个模块独立）

| 模块 | 重点测试 |
|---|---|
| holdings-loader | 边界（空、sum≠1、缺字段、locked 计算） |
| candidate-selector | 候选+持仓合并、anti-churn 锁定判定、top-N 截取 |
| constraint-validator | 10 条规则各 1 正 1 反例（共 16 tests） |
| execution-planner | 排序、HOLD 过滤、cash 累计、cash 不足时降级 |
| shallow-analyzer | prompt 渲染、JSON 解析、字段补齐、buildStockReport |
| rebalancer | prompt 渲染、JSON 解析、幻觉 ticker 过滤、revise loop、空 plan |
| position-calculator | 基础查表/波动率折扣/风险因子/现金排队/deal_breaker 强制 SELL（共 35 tests） |
| data-fetcher | 4 个解析器（parseKline 含 volatility_20d / parseNews / parseHotMoney / parseFundamentals） |

### 12.2 Integration tests

- 完整 pipeline + mock LLM 跑通（仓位由公式算，不是 LLM 拍）
- 约束违反 → revise loop → 最终通过
- shallow-analyzer 数据缺失 → 候选股跳过
- **deal_breaker 持仓：AI 出 HOLD 但代码强制改 SELL**（防 AI 漏判致命雷）
- **现金不足：BUY 降级为 HOLD**（保留现金下限）

### 12.3 真实数据 smoke test

跑前必做：
```bash
# 1. 准备假 holdings.json（首次手动）
# 2. 跑 ranker 确保 scan.json 存在
npm run rank
# 3. 跑 rebalancer
npm run rebalance -- --api-key xxx --base-url xxx --model glm-5.1
```

验证 plan.json 结构完整、status="ok"（或 "constraint_violation" 但结构完整）。

## 13. 后续扩展方向

| 方向 | 描述 | 优先级 |
|---|---|---|
| 详情深度分析（按需 trading_full） | 用户在 plan.md 里点某只股触发原 trading_full，作为本方案的"详情页" | P1 |
| 接券商 API 同步 holdings | 替代手动 holdings.json | P2（技术风险高） |
| 批量数据 fetch 优化 | 同行业 sentiment/policy 跨股共享一次调用 | P2 |
| Portfolio 风险监控 | 跨日跟踪组合表现，自动 alert | P2 |
| 多策略组合 | 不同风险偏好（保守/平衡/激进）多套约束 | P3 |
| 自动调度 | cron 每日定时跑 | P3 |
| plan.md 渲染 | 当前只输出 plan.json，缺人类可读 markdown | P1（小工作量） |
| 跨日 thesis 跟踪 | 同一只股多次 rebalance 的 thesis 演化对比 | P3 |

## 14. FAQ

**Q: 为什么要手动 holdings.json，不接券商 API？**

A 股券商 API 都是私有的，要逆向/收费。技术风险高。先手动 JSON，schema 严格（sum 校验 + sector 必填 + entry_date 格式），等流程跑通再考虑 API。

**Q: LLM 选不出来（全 SKIP）怎么办？**

合法状态。说明候选股质量都不够。rebalancer 会保留高 cash（如 85%）"等待高质量标的"。比强行 BUY 一个 fitness=5 的股好。

**Q: revise 用尽怎么办？**

输出 last_attempt + `status: "constraint_violation"` + 违反清单。用户人工裁决，可以选择：
- 忽略（不调仓）
- 手动调整 actions 后重新跑
- 放宽约束（如 `--single-name 0.20`）

**Q: 跨日跑同一只股的方案会不会变？**

可能变。LLM 对同输入可能出不同方案（即使 temperature=0，少量随机性存在）。如果方案大变，说明输入数据变了（持仓/候选/last_rebalance），不是 LLM 抽风。

**Q: 如何调整约束？**

CLI 参数：`--single-name 0.20 --daily-turnover 0.50` 等。
长期：改 `openclaw.json` plugin config。

**Q: 如何调试单只股的 fitness？**

看 `plan.json` 的 `reports[]`，每只股有 thesis + fitness_score + risk_flags。如果觉得某只股 fitness 给低了，看 thesis 是否准确、risk_flags 是否合理。

**Q: 7 天 anti-churn 是基于交易日还是自然日？**

自然日。`computeLocked` 用 `Date.getTime()` 算毫秒差，不区分周末/节假日。如果需要按交易日，改 `computeLocked` 加交易日历查询。

**Q: shallow-analyzer 的 fitness 和 ranker 的 score 有什么区别？**

- ranker score（0-10）：基于雪球异动数据的**趋势投资吸引力**评分
- shallow-analyzer fitness（0-10）：基于实时数据（kline/news/资金/基本面）的**当前组合视角**吸引力评分

两者输入不同、维度不同。ranker score 高的股 shallow-analyzer fitness 不一定高（如 SZ301377 鼎泰高科 ranker 9.5 但 shallow-analyzer fitness 2，因为港股发行不确定 + 早期替代）。

## 15. 关联文档

- [设计 spec](./superpowers/specs/2026-06-21-stockpool-rebalancer-design.md) — 完整设计文档（13 节）
- [实施计划](./superpowers/plans/2026-06-21-stockpool-rebalancer.md) — 16 个 TDD task
- [股票池基础管道](./superpowers/specs/2026-06-17-watchlist-stock-pool-design.md) — 上游 universe→snapshot→diff→candidates
- [ranker 精排模块](./superpowers/specs/2026-06-18-llm-ranking-design.md) — 上游 LLM 精排
- [主架构](./architecture.zh.md) — 整体项目架构
- [数据源](./data-sources.zh.md) — 数据 script 来源
