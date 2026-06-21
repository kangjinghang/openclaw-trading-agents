# 股票池自动调仓模块设计（portfolio-rebalancer）

> 日期：2026-06-21
> 状态：设计中
> 依赖：[`2026-06-17-watchlist-stock-pool-design.md`](./2026-06-17-watchlist-stock-pool-design.md)、[`2026-06-18-llm-ranking-design.md`](./2026-06-18-llm-ranking-design.md)
> 范围：ranker 输出 → 用户可执行的调仓方案（取代现有 `trading_full` 在股票池场景下的角色）

## 1. 背景与目标

### 1.1 现状

股票池管道（layer 0-3 + ranker）已上线，每日产出 `scan.json`（top-15 候选股 + thesis）。
现有单股分析管道 `trading_quick` / `trading_full` 设计为**深度优先**：1 股 → 7 分析师 → 辩论 → 研究经理 → 交易员 → 风控辩论，每股 15+ LLM 调用。

### 1.2 核心问题：流程逻辑错配

股票池场景需要**广度优先 + 时间维度 + 直接可执行**：

| 维度 | trading_full（现有） | 股票池场景需要 |
|---|---|---|
| 触发 | 用户指定 ticker | ranker 自动驱动 |
| 视角 | 单股深度 | 跨股组合 + 持仓状态 |
| 产物 | Buy/Sell + 目标价（猜测） | 调仓 actions（BUY/SELL/ADD/REDUCE） |
| 时间 | 单次快照 | 跨日 anti-churn + 持仓跟踪 |
| 决策 | 单股 pass/revise | 组合约束（单仓/行业/换手/现金） |

`trading_full` 输出的目标价/止损是 LLM 猜的不可信；调仓是组合决策不是单股决策；用户拿到 15 份独立 Buy 报告仍不知如何分配资金。

### 1.3 目标

直接输出**今日调仓方案**：`[{action: BUY/SELL/ADD/REDUCE/HOLD, ticker, target_weight, reason}, ...]`，约束硬性满足，anti-churn 防过度交易，用户拿到就能执行。

不做：观察名单模式、triggers 监控、自动下单（仅出方案，用户手动执行）。

## 2. 架构总览

### 2.1 数据流

```
[输入]
holdings.json (用户手动维护)
scan.json (ranker 产物, top-N)
last_rebalance.json (上次调仓, 防反向)

   │
   ▼ ① holdings-loader
   │
   ▼ ② candidate-selector (ranker top-N + 持仓合并, anti-churn 标记)
   │
   ▼ ③ shallow-analyzer (并行 2 calls/stock: analyst + risk)
   │     ↓ 复用 kline/news/hot_money/fundamentals scripts
   │   → per-stock report: {thesis, fitness, risks, ...}
   │
   ▼ ④ rebalancer (1 call, decision_deep 模型)
   │     ↓ REBALANCE_PLAN JSON
   │
   ▼ ⑤ constraint-validator (10 条规则, 纯代码)
   │     ↓ 违反 → 回 ④ revise (max 2)
   │
   ▼ ⑥ execution-planner (排序 + cash 累计, 纯代码)
   │
   ▼
[输出]
~/.openclaw/watchlist/rebalance/{date}/plan.json + plan.md
~/.openclaw/watchlist/last_rebalance.json (覆盖)
```

### 2.2 复用 / Drop / Add

| 类别 | 项 | 说明 |
|---|---|---|
| **复用** | 数据 scripts (kline/news/hot_money/fundamentals) | 按需调 4 个不是 7 个 |
| | LLM client + trace-logger | 跟 ranker 同套 |
| | `<!-- VERDICT -->` JSON 块解析 | rebalancer 输出格式 |
| | decision_deep 模型配置 | 同 research/risk gatekeeper |
| | `src/watchlist/atomic-json.ts` | 原子写 |
| | `src/prompt-loader.ts` | 模板渲染 |
| **Drop** | 7 分析师并行批跑 | 改单综合分析师 |
| | Bull/Bear 多轮辩论 | 留给"详情深度分析"（按需触发） |
| | trader 目标价/止损 | 改 `target_weight` |
| | Risk 3-way 辩论 | 改轻量 risk-role + validator |
| | Per-report quality-gate | 改 batch-level（后续 P2） |
| **Add** | holdings.json schema | 用户手动维护 |
| | last_rebalance.json | anti-churn 状态 |
| | shallow-analyzer prompt + report schema | analyst + risk 双 call |
| | rebalancer prompt + REBALANCE_PLAN | 核心 LLM 决策 |
| | constraint-validator (10 规则) | 纯代码 |
| | execution-planner | 纯代码 |
| | revise loop | 仿 risk.ts，max 2 |

## 3. 输入与状态文件

### 3.1 `~/.openclaw/watchlist/holdings.json`

用户手动维护的当前持仓快照。schema：

```typescript
interface Holdings {
  updated_at: string;              // ISO 时间，用户上次手动改的时间
  cash_pct: number;                // 现金比例 (0-1)
  positions: Position[];
}

interface Position {
  ticker: string;                  // 如 "SH600519"
  name: string;                    // 如 "贵州茅台"
  weight: number;                  // 0-1，所有 positions 加 cash_pct = 1.0
  entry_price: number;             // 入场价
  entry_date: string;              // "YYYY-MM-DD"，用于 anti-churn
  shares: number;                  // 持仓股数
  sector: string;                  // 行业，必填（约束检查用），首次填后系统不动
}
```

校验：`sum(positions.weight) + cash_pct ≈ 1.0 (±0.001)`。不满足 abort，提示用户修正。

### 3.2 `~/.openclaw/watchlist/last_rebalance.json`

每次跑后系统覆盖写。下次跑用作 anti-churn "买锁"（7 天内 SELL 的不重 BUY）。

```typescript
interface LastRebalance {
  date: string;                    // "YYYY-MM-DD"
  actions: Array<{
    action: "BUY" | "SELL" | "ADD" | "REDUCE";
    ticker: string;
    weight: number;                // target_weight
  }>;
}
```

### 3.3 scan.json 引用

直接读 `~/.openclaw/watchlist/scan/{date}/scan.json`（ranker 产物）。取 `top_picks` 前 N 支（默认 10）作为候选。

## 4. shallow-analyzer

### 4.1 候选选择（candidate-selector）

合并去重：
- ranker `top_picks` 前 N 支（默认 10）
- holdings.json 里所有 positions（避免漏检持仓）

去重后约 12-16 只。每只附加状态：
- `is_held`: bool
- `current_weight`: 持仓的才有
- `days_held`: 持仓的才有，从 entry_date 计算
- `locked`: `days_held < anti_churn_days`（默认 7）

### 4.2 数据 script 调用策略

| Script | 必跑 | 用途 |
|---|---|---|
| kline.py | ✅ | K 线摘要：涨幅、换手、支撑/压力位 |
| news.py | ✅ | 7 天新闻 top-5：风险信号 |
| hot_money.py | ✅ | 5 日资金流向：fitness 关键 |
| fundamentals.py | ✅ | PE/PB/营收/净利：估值风险 |
| sentiment.py | 按需（默认关） | config 开启才跑 |
| policy.py | 按需（默认关） | 同上 |
| lockup.py | 按需（默认关） | 同上 |

12-16 只 × 4 scripts = 48-64 调用。Python subprocess 并行（复用 `exec-python.ts` 批量模式），预计 30-60 秒。

### 4.3 Call 1: analyst-role（评估 thesis + fitness）

**输入**：ticker + kline/news/hot_money/fundamentals 摘要 + ranker thesis（候选股才有）

**输出 JSON**：
```typescript
interface AnalystReport {
  thesis: string;                  // 必须 含具体词，禁模糊词（继承 ranker 规则）
  fitness_score: number;           // 0-10，组合视角的吸引力
  data_freshness: string;          // "YYYY-MM-DD"
  key_signals: string[];           // 3-5 条关键信号，每条要具体
  data_gaps: string[];             // 哪些数据缺失/失败
}
```

**Prompt 来源**：改自 `skills/trading-analysis/prompts/analysts/market.md`，合并多源数据，精简为单 prompt 输出综合评估。

### 4.4 Call 2: risk-role（识别风险）

**输入**：同 Call 1 数据 + Call 1 的 thesis

**输出 JSON**：
```typescript
interface RiskReport {
  risk_flags: Array<{
    flag: string;                  // 如"估值过高"、"股东减持预告"
    severity: "低" | "中" | "高";
    detail: string;                // 具体描述，含数据
  }>;
  overall_risk: "low" | "medium" | "high";
  deal_breaker: boolean;           // true = 建议直接拒绝（财务造假、退市风险等）
}
```

**Prompt 来源**：改自 `skills/trading-analysis/prompts/debate/risk_manager.md`，只输出风险清单，不下 pass/revise/reject（那留给 rebalancer）。

### 4.5 综合 per-stock report schema

Call 1 + Call 2 + 持仓状态合并：

```typescript
interface StockReport {
  ticker: string;
  name: string;
  sector: string;
  // 来自 shallow-analyzer
  thesis: string;
  fitness_score: number;
  key_signals: string[];
  data_gaps: string[];
  risk_flags: RiskReport["risk_flags"];
  overall_risk: "low" | "medium" | "high";
  deal_breaker: boolean;
  // 来自 holdings
  is_held: boolean;
  current_weight: number;          // is_held=false 时为 0
  days_held: number;               // is_held=false 时为 0
  locked: boolean;                 // is_held=false 时为 false（不持仓无所谓锁定）
  // 来自 ranker
  ranker_score?: number;           // 候选股才有
}
```

12-16 份 report 是 rebalancer LLM 的输入。

### 4.6 失败回退

- 单股 script 失败：`data_gaps` 标注，仍送 LLM（LLM 看得到 gap）
- 单股 LLM call 失败：该股标 `analyzed: false`，rebalancer 看不到它（相当于跳过）
- 全部股都失败：abort（数据层问题，让用户检查 scripts）

## 5. rebalancer 核心

### 5.1 LLM 配置

- **模型**: `decision_deep`（用户 config 中 `models.rebalancer` 或 fallback 到 `models.decision`，再 fallback `glm-4.7`）
- **Temperature**: 0.0（调仓必须确定性，同输入同输出，便于复盘）
- **Phase**: `"rebalance"`
- **Role**: `"portfolio-rebalancer"`

### 5.2 Prompt 结构（5 段）

```markdown
# 角色
你是 A 股投资组合管理者，管理一个 5-10 只持仓的中等换手组合。
基于今日候选 + 当前持仓，输出最优调仓方案。

# 任务流程（必须按此顺序思考）
1. 对每只候选/持仓股独立评估：值得入组 / 继续持有 / 应该退出
2. 在硬约束下选择最优组合配置
3. 排序 actions（SELL 优先释放资金，BUY/ADD 用释放的资金）
4. 自检约束 + 自检 anti-churn 锁定

# 评估框架（每股独立判断）

## 候选股（未持仓）
- fitness ≥8 且 risk=low：BUY（target_weight 5-10%）
- fitness ≥8 且 risk=medium：BUY（target_weight ≤5%）或跳过
- fitness 6-7：跳过
- fitness ≤5 或 deal_breaker=true：跳过

## 持仓股
- fitness ≥8 且 risk=low：HOLD 或 ADD（小幅加 2-3%）
- fitness 6-7 且 risk 可控：HOLD（默认）
- fitness ≤5 或 risk=high 或 deal_breaker=true：REDUCE（减半）或 SELL（清仓）
- locked=true（持仓<7天）：只能 HOLD 或 ADD，禁止 SELL/REDUCE

# 硬约束（违反则方案作废，validator 会强制 revise）
- 单仓 ≤ {single_name}
- 单行业 ≤ {single_sector}（按 sector 字段聚合）
- 日换手 = sum(|delta|) ≤ {daily_turnover}
- 现金保留 = 1 - sum(target_weight) ≥ {cash_reserve}
- 7 天内买入的 locked 股禁止 SELL/REDUCE
- 7 天内卖出过的 ticker 禁止 BUY

# 软偏好（非硬约束，但请考虑）
- 优先 fitness ≥7 的标的
- 单日 actions 数量 ≤ 5（避免过度交易）
- 同行业新增要谨慎

# 反"老好人"硬规则
- fitness ≤5 的持仓必须 REDUCE 或 SELL（不准 HOLD 蒙混）
- actions 不能全是 HOLD，**除非**：所有持仓 fitness ≥7 + 所有候选 fitness <6 + 无 deal_breaker
  （"今日低 activity"是合法状态，但 summary 必须明示）
- fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限

# reason 写作规则（严格）
继承 ranker 白/黑名单：
- 必须含至少 1 个具体词（产品/客户/数据/业务节点）
- 禁止模糊词（共振/资金追捧/活跃/爆发力强...）

# 输出格式（严格 JSON）
{
  "evaluations": [
    { "ticker": "...", "judgment": "BUY|HOLD|REDUCE|SELL|SKIP", "brief": "1 句评估" }
  ],
  "actions": [
    {
      "action": "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD",
      "ticker": "...",
      "name": "...",
      "current_weight": 0.0,
      "target_weight": 0.0,
      "delta": -0.10,
      "reason": "...",
      "priority": 1
    }
  ],
  "portfolio_after": {
    "positions": [{"ticker": "...", "weight": 0.0}],
    "cash_pct": 0.0
  },
  "summary": "一句话总结今日调仓逻辑"
}

# 当前持仓
{holdings_json}

# 上次调仓（防反向）
{last_rebalance_json}

# 候选股报告（N 只）
{per_stock_reports}
```

### 5.3 Action 类型语义（严格定义）

| Action | current_weight | target_weight | delta | priority | 用途 |
|---|---|---|---|---|---|
| BUY | 0 | >0 | + | 3 | 新建仓位 |
| SELL | >0 | 0 | - | 1 | 清仓退出 |
| ADD | >0 | >current | + | 4 | 加仓（不新建） |
| REDUCE | >0 | (0, current) | - | 2 | 减仓（不清仓） |
| HOLD | >0 | =current | 0 | 5 | 维持不变 |

Priority 决定 execution-planner 排序：SELL → REDUCE → BUY → ADD → HOLD。

### 5.4 evaluations 字段的作用

强制 LLM **先逐股独立评估**再下 action（chain-of-thought 强制化）：
- 每只候选/持仓必须有一条 evaluation
- `judgment` 必须跟 `actions` 里的 `action` 对齐（SKIP 对应无 action）
- 防止 LLM 跳过思考直接出 actions

### 5.5 portfolio_after 字段的作用

让 LLM **主动验证自己方案的合理性**：
- `sum(positions.weight) + cash_pct` 必须 = 1.0（±0.001）
- validator 会校验，不等于 1 直接打回
- LLM 自己算总账，减少算术错误

### 5.6 输入规模估算

- 候选 reports: 15 × ~400 tokens = 6K tokens
- holdings JSON: 5 positions × ~50 tokens = 250 tokens
- last_rebalance: ~100 tokens
- prompt 模板: ~2K tokens
- **总输入: ~8.5K tokens**

输出预估: ~2-3K tokens（evaluations + actions + portfolio_after）。

### 5.7 边界情况

| 情况 | 处理 |
|---|---|
| 候选全 fitness <6 | 允许输出全 HOLD + summary "今日无机会" |
| 持仓全 fitness ≥8 + 高 cash | 输出 BUY 用掉部分 cash |
| cash_pct <10% | 必须先 SELL/REDUCE 释放 cash，再 BUY |
| 7 天 anti-churn 锁死所有持仓 | 只能 BUY 新候选，不能动现有持仓 |
| LLM 输出 sum(weight) ≠ 1 | validator 打回，revise loop |
| LLM 给 locked 股出 SELL | validator 打回，要求改 HOLD/ADD |

### 5.8 失败回退

- LLM 调用失败（网络/超时）：复用 callLLM 内部 retry，失败后**整个 rebalancer 失败**（核心决策不能降级），用户重跑
- JSON 解析失败：revise loop 重试 1 次
- 校验失败：revise loop max 2 次（见 §6.2）
- 都失败：保留 last_attempt + `status: "constraint_violation"` + 违反清单，给用户人工裁决

## 6. constraint-validator

### 6.1 10 条规则（纯代码）

| # | 规则 | 校验逻辑 | 失败反馈示例 |
|---|---|---|---|
| 1 | 权重和 = 1 | `abs(sum(所有 actions 的 target_weight, 含 HOLD) + cash_pct - 1.0) ≤ 0.001` | "权重和 0.97，差 0.03" |
| 2 | 单仓 ≤15% | `max(target_weights) ≤ 0.15` | "SZ300319 weight 0.18 超 15%" |
| 3 | 单行业 ≤30% | 按 sector 聚合 sum | "PCB 行业 0.35 超 30%" |
| 4 | 日换手 ≤30% | `sum(abs(delta)) ≤ 0.30` | "换手 0.35 超 30%" |
| 5 | 现金 ≥10% | `1 - sum(target_weight) ≥ 0.10` | "现金 0.08 不足 10%" |
| 6 | Anti-churn 卖锁 | `days_held < 7` 的不能 SELL/REDUCE | "SZ300319 持仓 5 天，locked" |
| 7 | Anti-churn 买锁 | last_rebalance 7 天内 SELL 的不能 BUY | "SH600519 7 天内刚卖过" |
| 8 | Action 一致性 | BUY/SELL/ADD/REDUCE/HOLD 各自的 current/target 关系 | "BUY 但 current>0 矛盾" |
| 9 | Ticker 在候选池 | action 的 ticker 必须在候选/持仓 | "SH000999 不在评估范围（幻觉）" |
| 10 | sector 非空 | target_weight>0 的必须有 sector | "SZ300319 缺 sector 字段" |

### 6.2 Revise loop

```
rebalancer 输出 plan
    ↓
validator.checkAll(plan)
    ↓
violations = [...]
    ↓
if violations.empty → 通过，进 execution-planner
    ↓ 否则
构造 feedback：列出所有 violations（具体哪条 + 实际值 + 期望值）
    ↓
rebalancer.revise(originalInput + plan + feedback)
    ↓
重复 validator.checkAll，max 2 次 revise
    ↓ 用尽后
保留 last_attempt + 标 `status: "constraint_violation"` + violations 清单
输出给用户人工裁决
```

### 6.3 Revise feedback 示例

```
你的上一次方案违反了以下约束，请修正：

1. [规则 2 单仓] SZ300319 target_weight=0.18 超 0.15 上限
2. [规则 3 单行业] PCB 行业 sum=0.35 超 0.30 上限
3. [规则 4 日换手] sum(|delta|)=0.35 超 0.30 上限

请重新输出 REBALANCE_PLAN，确保满足所有硬约束。
```

## 7. execution-planner

### 7.1 排序逻辑

```
1. 从 plan.json 的 actions 里过滤掉 HOLD（HOLD 不产生执行步骤，
   但保留在 plan.json 里作为"维持不变"的记录）
2. 按 priority 排序：SELL(1) → REDUCE(2) → BUY(3) → ADD(4)
3. 同 priority 内按 |delta| desc（大的先）
4. 累计 cash 检查：
   - SELL/REDUCE 后 cash 增加
   - BUY/ADD 前 cash 必须够
   - 不够 → 标 warning，调整后续 BUY 顺序（cash 不够的 BUY 降级或丢弃）
5. 输出 execution_sequence
```

### 7.2 输出 schema

```typescript
interface ExecutionPlan {
  execution_sequence: Array<{
    step: number;                   // 1, 2, 3...
    action: "BUY" | "SELL" | "ADD" | "REDUCE";
    ticker: string;
    name: string;
    weight_delta: number;           // 带符号
    est_cash_after: number;         // 累计现金
    note?: string;                  // 如"释放资金"/"用释放资金"
  }>;
  final_state: {
    positions: Array<{ ticker: string; weight: number }>;
    cash_pct: number;
  };
  warnings: string[];               // 如"BUY X cash 不足，已降级"
}
```

### 7.3 A 股特殊性

- **T+1**：同一 ticker 不能在同 plan 里既 BUY 又 SELL（防 LLM 错乱，validator 规则 #8 已覆盖）
- **涨跌停板**：plan 层不管（broker 那边的事），假设都能执行
- **最少 100 股（1 手）**：plan 层用 weight 不用 shares，broker 下单时再换算

## 8. 输出

### 8.1 文件结构

```
~/.openclaw/watchlist/rebalance/{date}/
├── plan.json              # 完整 REBALANCE_PLAN + per-stock reports + constraint_result + execution_plan
├── plan.md                # 人读版（表格 + LLM 自评估 + 风险提示）
├── traces/                # LLM 调用 traces
└── holdings_snapshot.json # 跑前 holdings 快照（复盘用）
```

`~/.openclaw/watchlist/last_rebalance.json`（每次跑后覆盖）。

### 8.2 plan.json schema

```typescript
interface RebalancePlanFile {
  scan_date: string;
  written_at: string;                // ISO 时间
  status: "ok" | "constraint_violation";
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
    evaluations: Array<{ ticker: string; judgment: string; brief: string }>;
    actions: Action[];
    portfolio_after: { positions: Array<{ticker: string; weight: number}>; cash_pct: number };
    summary: string;
  };
  // 约束校验
  constraint_check: {
    passed: boolean;
    violations: string[];
    revise_count: number;            // 0 = 一次过，>0 = revise 过 N 次
  };
  // 执行序列
  execution_plan: ExecutionPlan;
}
```

### 8.3 plan.md 结构

```markdown
# 调仓方案 {date}

## 当前持仓
| ticker | name | sector | weight | days_held | locked |
|---|---|---|---|---|---|
...

## 调仓建议
| priority | action | ticker | current | target | delta | reason |
|---|---|---|---|---|---|---|
| 1 | SELL | ... | ... | ... | ... | ... |
...

## 约束检查
- 单仓 ≤15%: ✓ (max 12%)
- 单行业 ≤30%: ✓ (PCB 25%)
- 日换手 ≤30%: ✓ (22%)
- 现金 ≥10%: ✓ (12%)
- revise 次数: 1

## 执行序列
1. SELL SH600519 (释放 5% 资金)
2. BUY SH600183 (用 5% 资金)
...

## LLM 自评估
- evaluations: ...
- summary: ...

## 风险提示
- 整体组合 risk 等级: medium
- 高 risk 个股: ...
```

### 8.4 Console 摘要

```
rebalancer 完成: 2026-06-21
  候选: 10 / 持仓: 5 / 综合: 14 只
  actions: 1 SELL, 2 BUY, 1 ADD, 4 HOLD
  约束: 全通过 (revise 1 次)
  换手: 22% / 30%
  输出: ~/.openclaw/watchlist/rebalance/2026-06-21/plan.md
  tokens: 32K
```

## 9. 错误处理

| 错误 | 处理 |
|---|---|
| holdings.json 缺 | abort + 打印 template 让用户首次创建 |
| holdings.json sum ≠ 1 | abort + 指出哪只权重有误（不自动修复用户数据） |
| scan.json (ranker) 缺 | abort + 提示 `npm run rank` |
| 单股 script 失败 | report 标 `data_gaps`，仍送 LLM |
| 单股 shallow-analyzer LLM 失败 | 该股跳过（标 `analyzed: false`），rebalancer 看不到 |
| rebalancer LLM 失败 | 整个失败（核心决策不能降级），用户重跑 |
| JSON 解析失败 | revise 1 次 |
| 约束违反 | revise max 2 次 |
| revise 用尽 | 输出 last_attempt + `status: "constraint_violation"` + 违反清单，用户人工裁决 |

## 10. 配置参数

`openclaw.json` 的 plugin config 增字段：

```json
{
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
```

CLI 参数（覆盖 config，debug 用）：

```bash
npm run rebalance -- --top-n 5 --no-anti-churn --max-revise 3 --date 2026-06-18
```

| CLI 参数 | 默认 | 说明 |
|---|---|---|
| `--top-n <N>` | 10 | 从 ranker top_picks 取前 N |
| `--date <D>` | 最新 scan | 指定日期 |
| `--single-name <F>` | 0.15 | 单仓上限 |
| `--single-sector <F>` | 0.30 | 单行业上限 |
| `--daily-turnover <F>` | 0.30 | 日换手上限 |
| `--cash-reserve <F>` | 0.10 | 现金下限 |
| `--anti-churn-days <N>` | 7 | 锁定天数，0 = 关闭 |
| `--no-anti-churn` | - | 等价 `--anti-churn-days 0` |
| `--max-revise <N>` | 2 | revise 最大次数 |
| `--model <M>` | config 或 glm-4.7 | rebalancer 模型 |
| `--api-key <K>` | env / config | OpenAI 兼容 key |
| `--base-url <U>` | env / config | OpenAI 兼容 base URL |

## 11. 实现文件清单与测试策略

### 11.1 文件清单

| 文件 | 职责 |
|---|---|
| `src/rebalance-cli.ts` | CLI 入口 |
| `src/watchlist/rebalance-types.ts` | Holdings/Position/Action/StockReport/RebalancePlan/ExecutionPlan 类型 |
| `src/watchlist/rebalancer.ts` | shallow-analyzer + rebalancer LLM 调用 + revise loop |
| `src/watchlist/constraint-validator.ts` | 10 条规则 + revise feedback |
| `src/watchlist/execution-planner.ts` | 排序 + cash 累计 |
| `tests/ts/watchlist/rebalancer.test.ts` | LLM 调用 mock + JSON 解析 + revise loop |
| `tests/ts/watchlist/constraint-validator.test.ts` | 10 条规则各 1 正 1 反例 |
| `tests/ts/watchlist/execution-planner.test.ts` | 排序/HOLD 过滤/cash 累计 |
| `package.json` | 加 `rebalance` script |

### 11.2 测试策略

沿用 ranker 模式（mock LLM + 假数据 + 不触网）：

**Unit tests**（必修）：
- `holdings-loader`：边界（空、sum≠1、缺字段、locked 计算）
- `candidate-selector`：候选+持仓合并、anti-churn 锁定判定
- `constraint-validator`：10 条规则各 1 个正例 + 1 个反例
- `execution-planner`：排序、HOLD 过滤、cash 累计、cash 不足时降级
- `rebalancer.parseRebalancePlan`：JSON 解析 + 幻觉 ticker 防御 + 字段补齐
- `shallow-analyzer.parseAnalystReport` / `parseRiskReport`：JSON 解析

**Integration tests**（必修）：
- 完整 pipeline + mock LLM 跑通
- 约束违反 → revise loop → 最终通过
- 约束违反 → revise loop 用尽 → 输出 last_attempt + status

**Prompt snapshot tests**（可选）：
- rebalancer prompt 渲染结果存 snapshot
- 防止 prompt 改动意外破坏

**真实数据 smoke**（手动）：
- 真实 scan.json + 假 holdings.json 跑一次

### 11.3 LLM 调用预算

- shallow-analyzer: 2 calls × 15 stocks = **30 calls**（analyst-tier 模型）
- rebalancer: **1 call**（decision_deep 模型）
- revise loop: 最多 +2 calls
- **总：31-33 calls**

并行度：每股 2 calls 可并行，15 stocks / concurrency=5 ≈ 3 倍单股时间。

总运行时间预估：**8-12 分钟**（含数据 script 30-60 秒）。

## 12. 后续扩展方向

| 方向 | 描述 | 优先级 |
|---|---|---|
| 详情深度分析（按需 trading_full） | 用户在 plan.md 里点某只股触发原 trading_full，作为本方案的"详情页" | P1 |
| 接券商 API 同步 holdings | 替代手动 holdings.json | P2（技术风险高） |
| 批量数据 fetch 优化 | 同行业 sentiment/policy 跨股共享一次调用 | P2 |
| Portfolio 风险监控 | 跨日跟踪组合表现，自动 alert | P2 |
| 多策略组合 | 不同风险偏好（保守/平衡/激进）多套约束 | P3 |
| 自动调度 | cron 每日定时跑 | P3 |

## 13. 与现有模块的关系

```
[已有] watchlist layer 0-3 + ranker
    ↓ top_picks
[已有] 本设计 = rebalancer 模块
    ↓ plan.json + plan.md
[已有，不动] trading_quick / trading_full
    ↑ 用户按需手动触发，作为单股深度分析

[本设计不动] 现有 dashboard / report-store / source-health
```

- **输入**：ranker 产物 + 用户 holdings
- **输出**：调仓方案（plan.json + plan.md）
- **不动**：现有单股分析管道完全不改，本模块是纯增量
- **不冲突**：trading_full 仍可单独跑，作为"详情页"补充
