# 外部项目设计参考

> 对比项目：
> - `D:\workspace\github\TradingAgents-AShare` — A 股 fork，侧重反思记忆 + 结构化辩论
> - `D:\workspace\github\TradingAgents-astock` — 原版 TradingAgents (65K⭐) 的 A 股深度 fork，7 周改造，47 文件
>
> 记录时间：2026-06-07
> 更新时间：2026-06-07
> 目的：记录值得借鉴的所有设计，供未来统一规划实现

---

## 已完成的借鉴

| 特性 | 来源 | 完成时间 |
|------|------|---------|
| 信号提取增强 (parseVerdict 3 层 fallback) | AShare | 2026-06-07 |
| VPA 量价预计算 | AShare | 2026-06-07 |
| 数据质量门控 (Quality Gate) | astock | 2026-06-07 |

---

## 一、交易日历（P0 · 很简单）

### 来源

两个项目都有。astock 使用 `trade_calendar.py`，AShare 也内嵌了日历逻辑。

### 问题

不检查交易日 → 周末/节假日跑分析 → 拿到旧数据 → 7 个 LLM 调用全部浪费。

### 设计

```
用户请求分析(ticker, date)
       │
  ┌────▼────┐
  │交易日历  │
  │检查     │
  └────┬────┘
       │
  非交易日 → 报错 "2026-06-07 是周日，最近交易日为 2026-06-06"
  交易日   → 继续分析
```

### 实现思路

1. **数据**：硬编码 A 股年度节假日列表（每年证监会公布），周末自动排除。可存为 JSON 文件 `skills/trading-calendar/holidays.json`
2. **函数**：`isTradingDay(date) → boolean`，`lastTradingDay(date) → string`，`nextTradingDay(date) → string`
3. **接入位置**：`orchestrator.ts` 的 `runQuickAnalysis()` 和 `runFullAnalysis()` 入口处，在 `runAnalystPhase()` 之前检查
4. **自动修正**：如果用户传入非交易日，自动改为最近的交易日并提示
5. **维护**：每年 12 月证监会公布次年节假日，需手动更新 JSON

### 参考

astock 的 `tradingagents/dataflows/trade_calendar.py`：

```python
class TradeCalendar:
    """A 股交易日历，含市场阶段判断"""

    def is_trading_day(self, date: str) -> bool:
        """判断是否为交易日（排除周末和节假日）"""

    def get_market_phase(self, date: str, time: str) -> str:
        """
        返回当前市场阶段：
        - pre_open: 09:15-09:25 集合竞价
        - in_session: 09:30-11:30 / 13:00-15:00 连续竞价
        - lunch_break: 11:30-13:00 午休
        - post_close: 15:00+ 盘后
        - closed: 非交易日
        """

    def last_trading_day(self, date: str) -> str:
        """返回指定日期之前的最近交易日"""

    def next_trading_day(self, date: str) -> str:
        """返回指定日期之后的最近交易日"""
```

### 改动范围

- 新增 `skills/trading-calendar/` 目录 + 脚本
- `orchestrator.ts` 入口处加检查（~5 行）
- 无需改动现有 LLM 调用逻辑

---

## 二、反思与记忆系统（P1 · 中等）

### 来源

AShare 项目。原版 TradingAgents 的核心设计之一。

### 现状对比

| | 我们 | AShare |
|---|------|--------|
| 记忆能力 | 无。每次分析完全独立，不记得历史决策 | 5 个角色各有独立记忆，从历史对错中学习 |
| 复盘方式 | 人工查看报告 | 自动：T+N 后对比实际收益 → LLM 反思 → 存入记忆 |
| 下次分析 | 无历史参考 | BM25 检索相关记忆注入 prompt |

### 架构

```
                    ┌──────────────┐
                    │  做决策 (T)   │
                    │  Buy 600519  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  等待 T+5 天  │
                    │  实际收益 -3% │
                    └──────┬───────┘
                           │
            ┌──────────────▼──────────────┐
            │     Reflector 反思 (LLM)     │
            │  输入: 市场数据 + 决策 + 收益  │
            │  输出: 反思结论文本             │
            └──────────────┬──────────────┘
                           │
            ┌──────────────▼──────────────┐
            │  FinancialSituationMemory    │
            │  存储: { 情况描述 → 反思结论 } │
            │  索引: BM25 (rank_bm25)      │
            └──────────────┬──────────────┘
                           │
                    ┌──────▼───────┐
                    │  下次分析 (T') │
                    │  BM25 检索    │
                    │  相似历史记忆  │
                    │  注入 prompt  │
                    └──────────────┘
```

### 5 个角色的独立记忆

| 角色 | 存什么 |
|------|--------|
| Bull Researcher | 做多判断在什么情况下出错 |
| Bear Researcher | 做空判断在什么情况下出错 |
| Trader | 执行计划在什么情况下失败 |
| Invest Judge / Research Manager | 辩论裁决在什么情况下误判 |
| Risk Manager | 风控评估在什么情况下遗漏 |

### 关键源码

**反射器** (AShare `tradingagents/graph/reflection.py`):
```python
class Reflector:
    def reflect_bull_researcher(self, current_state, returns_losses, bull_memory):
        situation = extract_current_situation(current_state)  # 分析师报告拼接
        bull_debate_history = current_state["investment_debate_state"]["bull_history"]
        result = self._reflect_on_component("BULL", bull_debate_history, situation, returns_losses)
        bull_memory.add_situations([(situation, result)])

    def _reflect_on_component(self, component_type, report, situation, returns_losses):
        messages = [
            ("system", self.reflection_system_prompt),
            ("human", f"Returns: {returns_losses}\n\nAnalysis/Decision: {report}\n\nObjective Market Reports: {situation}"),
        ]
        return self.quick_thinking_llm.invoke(messages).content
```

**记忆系统** (AShare `tradingagents/agents/utils/memory.py`):
```python
class FinancialSituationMemory:
    """BM25 检索，无 API 调用，离线可用"""

    def __init__(self, name, config=None):
        self.documents = []       # 市场情况描述列表
        self.recommendations = []  # 反思结论列表
        self.bm25 = None          # BM25Okapi 索引

    def add_situations(self, situations_and_advice):
        """存储 (情况, 结论) 对，重建 BM25 索引"""

    def get_memories(self, current_situation, n_matches=1):
        """检索与当前情况最相似的历史反思"""
```

**astock 版本** (`tradingagents/graph/reflection.py`)：
- Alpha 基准从 SPY 改为 CSI 300（沪深300）
- 反思输出精简为 2-4 句话，避免占用过多 token
- 聚焦三个维度：方向正确性、论点验证、经验教训

### 在 Node.js 中的实现思路

1. **存储层**：JSON 文件 `~/.openclaw/memory/{role}.json`，每个角色一个文件
2. **检索层**：简单 TF-IDF 或关键词匹配（无需 BM25 库），或调用 LLM 做相似度判断
3. **触发时机**：需要外部价格数据源，可做成 CLI 命令 `trading-agents reflect --ticker 600519 --date 2026-06-05 --actual-return -3.2`
4. **注入方式**：在 `loadAndRender()` 时加 `{{memories}}` 占位符，从文件读取后注入

### 改动范围

- 新增 `src/memory.ts` — 记忆存储与检索
- 新增 `src/reflector.ts` — 反思逻辑
- 修改 5 个 prompt 模板 — 加入 `{{memories}}` 占位符
- 修改 `orchestrator.ts` — 注入记忆到各阶段
- 新增 CLI 入口 — 手动触发反思

---

## 三、结构化 Claim 辩论（P1 · 较难）

### 来源

AShare 项目。完整 claim 状态机 + 每轮目标。

### 现状对比

| | 我们 | AShare |
|---|------|--------|
| 论点格式 | 自由文本 + 正则提取 BULL-N/BEAR-N | 结构化 JSON：`<!-- DEBATE: {...} -->` |
| 论点生命周期 | 提出后无状态追踪 | open → addressed → resolved/unresolved |
| 辩论方向 | 每轮自由发挥 | 每轮有明确 round_goal |
| 对方回应 | 不追踪 | 追踪：responded_claim_ids, resolved_claim_ids |
| 下游接收 | bull_summary + bear_summary（文字） | 结构化 claim 列表 + 状态 |

### 论点状态流转

```
提出论点 ──→ open
              │
     对方回应 ├──→ addressed（对方回应了但未解决）
              │
     对方承认 ├──→ resolved（论点被确认/接受）
              │
   对方无法反驳 ├──→ unresolved（持续有分歧）
              │
   下一轮聚焦 ├──→ focus_claim_ids（本轮要重点讨论的）
```

### 辩论状态结构

```typescript
interface DebateState {
  claims: DebateClaim[];           // 所有论点
  claimCounter: number;
  focusClaimIds: string[];         // 本轮要聚焦的论点
  openClaimIds: string[];          // 待处理的论点
  resolvedClaimIds: string[];      // 已解决的论点
  unresolvedClaimIds: string[];    // 持续有分歧的论点
  roundGoal: string;               // 本轮目标
}

interface DebateClaim {
  claimId: string;                 // "BULL-1"
  speaker: "bull" | "bear";
  claim: string;                   // 论点内容
  evidence: string[];              // 支撑证据
  confidence: number;              // 0-1
  status: "open" | "addressed" | "resolved" | "unresolved";
  targetClaimIds: string[];        // 针对哪些对方论点
  roundIndex: number;
}
```

### 每轮目标 (round_goal)

```typescript
const INVESTMENT_GOALS = [
  "建立最核心的正反两方 claim，并明确为何是现在。",
  "优先攻击对手最脆弱的假设，不要扩散议题。",
  "围绕时间窗口与触发条件，判断交易时机是否成立。",
  "围绕失败路径与失效条件，判断谁低估了回撤风险。",
  "检查剩余分歧是否仍有信息增量，否则准备收口。",
];

const RISK_GOALS = [
  "建立最关键的执行风险 claim，明确风险预算冲突点。",
  "围绕仓位、止损、流动性约束，攻击对手最薄弱一环。",
  "判断哪些风险是可接受波动，哪些风险是硬性红线。",
  "逼迫双方给出可执行替代方案，而不是抽象立场。",
  "检查是否还存在未解决的高影响执行风险，否则准备收口。",
];
```

### LLM 输出格式

```
<!-- DEBATE: {
    "round_summary": "BULL-1 被部分反驳，但 BEAR-2 证据不足",
    "round_goal": "围绕时间窗口与触发条件，判断交易时机是否成立",
    "new_claims": [
        {
            "claim": "成交量突破 20 日均量 2 倍，资金积极入场",
            "evidence": ["量比 2.1", "OBV 上升趋势"],
            "confidence": 0.75,
            "target_claim_ids": ["BEAR-2"]
        }
    ],
    "responded_claim_ids": ["BEAR-1"],
    "resolved_claim_ids": [],
    "unresolved_claim_ids": ["BEAR-2"],
    "next_focus_claim_ids": ["BEAR-2"]
} -->
```

### 在 Node.js 中的实现思路

1. **类型扩展**：`DebateClaim` 加 `status`, `evidence: string[]`, `confidence: number`, `targetClaimIds: string[]`
2. **新增 `DebateState`**：跟踪 `openClaims`, `resolvedClaims`, `unresolvedClaims`, `focusClaims`, `roundGoal`
3. **prompt 改造**：要求 LLM 输出 `<!-- DEBATE: {...} -->` 格式
4. **debate.ts 改造**：每轮结束后 `updateDebateState()`，下轮把 focus claims 和 round goal 注入 prompt
5. **research-manager 改造**：接收结构化 claim 列表而非纯文字 summary
6. **风险辩论同理**：`risk_debate_state` 也用同样的 claim 追踪机制

### 改动范围

- `src/types.ts` — 新增/扩展 `DebateClaim`、`DebateState`
- `src/debate.ts` — 核心改造，加入状态追踪逻辑
- `src/risk.ts` — 风险辩论同理
- 6 个 prompt 模板 — bull/bear/research_manager/risk_debater×3

---

## 四、结构化输出 Schema（P1 · 中等）

### 来源

astock 项目。用 Pydantic schema 约束 LLM 输出格式。

### 问题

当前 Trader 和 Portfolio Manager 的输出依赖正则提取（parseNumericField、parseListSection），如果 LLM 不按格式输出就解析失败。

### 他们的做法

astock 用 Pydantic 定义结构化 schema，让 LLM 输出严格符合类型约束：

```python
# Portfolio Manager 结构化输出
class PortfolioDecision(BaseModel):
    """Portfolio Manager 的最终决策"""
    rating: PortfolioRating       # Buy/Overweight/Hold/Underweight/Sell
    summary: str                  # 投资摘要
    thesis: str                   # 核心论点
    target_price: Optional[float] # 目标价
    investment_horizon: str       # 投资期限

# Trader 结构化输出
class TraderProposal(BaseModel):
    """Trader 的交易提案"""
    action: TraderAction          # Buy/Hold/Sell
    reasoning: str                # 推理过程
    entry_price: Optional[float]  # 入场价
    stop_loss: Optional[float]    # 止损价
    position_size: Optional[float]# 仓位比例

# Research Manager 结构化输出
class ResearchPlan(BaseModel):
    """Research Manager 的投资计划"""
    recommendation: PortfolioRating
    rationale: str
    strategic_actions: list[str]
```

当 LLM 支持结构化输出（如 OpenAI 的 JSON mode / function calling）时，强制输出符合 schema 的 JSON；不支持时回退到文本模式 + 正则解析。

### 在 Node.js 中的实现思路

1. **OpenAI structured output**：使用 `response_format: { type: "json_object" }` 或 `response_format: { type: "json_schema", json_schema: {...} }` 约束输出
2. **定义 TypeScript 接口**作为 JSON schema：`TraderOutput`、`PortfolioOutput`、`ResearchOutput`
3. **改造 `callLLM()`**：新增 `structuredOutput` 选项，传入 JSON schema
4. **改造下游解析**：先尝试 JSON.parse，失败则回退到现有正则解析
5. **保留 `<!-- VERDICT: -->` 标签**：作为验证/后备层，不立即移除

### 改动范围

- `src/llm-client.ts` — 新增结构化输出选项
- `src/types.ts` — 新增 `TraderOutput`、`PortfolioOutput` 等 schema
- `src/trader.ts` — 先 JSON.parse，失败回退正则
- `src/orchestrator.ts` — Portfolio Manager 同理
- `src/research-manager.ts` — Research Manager 同理
- prompt 模板可能微调（告诉 LLM 输出 JSON 而非 Markdown）

---

## 五、断点续跑（P1 · 难）

### 来源

astock 项目。基于 LangGraph 的 SQLite per-ticker checkpoint。

### 问题

一次完整分析需要 15-30 分钟（15+ LLM 调用）。如果 LLM API 超时或网络中断，所有中间结果丢失，需要从头开始。

### 他们的做法

```python
# tradingagents/graph/checkpointer.py
class Checkpointer:
    """Per-ticker SQLite 断点续跑"""

    def _db_path(self, ticker: str) -> Path:
        """每个 ticker 独立 SQLite 文件，避免并发冲突"""
        return CACHE_DIR / f"checkpoint_{safe_ticker}.db"

    def thread_id(self, ticker: str, date: str) -> str:
        """确定性的线程 ID（ticker+date 的哈希）"""
        return hashlib.sha256(f"{ticker}_{date}".encode()).hexdigest()[:16]

    def has_checkpoint(self, ticker: str, date: str) -> bool:
        """检查是否有可恢复的断点"""

    def checkpoint_step(self, ticker: str, date: str) -> Optional[int]:
        """返回最新完成的步骤编号"""
```

使用方式：
```python
# 在 trading_graph.py 中
if checkpoint_enabled:
    checkpointer = get_checkpointer(ticker)
    if has_checkpoint(ticker, date):
        step = checkpoint_step(ticker, date)
        # 从上次步骤继续执行
    else:
        # 从头开始
```

### 在 Node.js 中的实现思路

**核心难点**：我们是顺序管道（analysts → debate → research → trader → risk），不是状态机。需要改造执行模型。

**方案 A — 简单版（管道检查点）**：
1. 每个阶段完成后，将中间结果写入 `~/.openclaw/checkpoints/{ticker}_{date}.json`
2. 重新启动时检查 checkpoint 文件，从最后完成的阶段继续
3. 不需要 SQLite，一个 JSON 文件即可

```
checkpoint.json:
{
  "ticker": "600519",
  "date": "2026-06-05",
  "completed_phases": ["analysts", "debate", "research"],
  "analyst_reports": [...],
  "debate_result": {...},
  "research_decision": {...},
  "updated_at": "2026-06-07T15:30:00Z"
}
```

**方案 B — 完整版（LangGraph 式状态机）**：
1. 将 orchestrator 改为状态机（每个 phase 是一个 state）
2. 每次状态转移后保存 checkpoint
3. 支持从任意中间状态恢复
4. 架构变动大，建议后期考虑

### 改动范围

- 新增 `src/checkpoint.ts` — 检查点读写
- 修改 `orchestrator.ts` — 每个阶段完成后保存，启动时检查
- 修改 `src/index.ts` — 新增恢复参数

---

## 六、更多免费数据源（P2 · 简单）

### 来源

astock 项目。他们使用了多个零鉴权 HTTP 数据源：

| 来源 | 协议 | 数据内容 | 我们是否已有 |
|------|------|---------|------------|
| mootdx | TCP 7709 | OHLCV K 线、财务快照、F10 | ✅ 已有 |
| 腾讯财经 | HTTP (`qt.gtimg.cn`) | PE / PB / 市值 / 换手率（实时） | ❌ 无 |
| 东方财富 | HTTP (datacenter) | 龙虎榜、限售解禁、板块行情 | ❌ 无 |
| 新浪财经 | HTTP | K 线历史、财报三表 | ✅ 部分（akshare 内含） |
| 同花顺 | HTTP (10jqka) | EPS 一致预期、强势股 | ❌ 无 |
| 财联社 | HTTP (cls.cn) | 全球财经快讯 | ❌ 无 |
| 百度股市通 | HTTP (finance.pae.baidu) | 概念板块分类、资金流向 | ❌ 无 |

### 可新增的高价值数据

**1. 腾讯财经 PE/PB/市值/换手率**（零鉴权，最快 73ms）：
```python
# astock 的实现
def get_tencent_fundamentals(ticker):
    """腾讯财经实时指标，GBK 编码"""
    market = "sh" if ticker.startswith("6") else "sz"
    url = f"https://qt.gtimg.cn/q={market}{ticker}"
    resp = requests.get(url, timeout=10)
    fields = resp.content.decode("gbk").split("~")
    return {
        "pe": float(fields[39]),
        "pb": float(fields[46]),
        "market_cap": float(fields[45]),  # 亿
        "turnover_rate": float(fields[38]),
    }
```

**2. 同花顺 EPS 一致预期**（机构预测数据）：
```python
def get_profit_forecast(ticker):
    """同花顺机构一致预期 EPS"""
    df = ak.stock_profit_forecast_ths(symbol=ticker)
    # 返回：预测年份、机构数、预测EPS、预测PE
```

**3. 百度股市通概念板块**（个股所属板块 + 板块资金流向）：
```python
def get_concept_blocks(ticker):
    """百度股市通概念板块分类"""
    url = f"https://finance.pae.baidu.com/vstock/..."
    # 返回：概念板块列表、行业归属、地域归属
```

### 在 Node.js 中的实现思路

1. **扩展 `fundamentals.py`**：加入腾讯财经 PE/PB 接口
2. **扩展 `hot_money.py`**：加入同花顺强势股、百度资金流向
3. **新增数据脚本**（可选）：`trading-forecast/scripts/forecast.py` — 一致预期数据
4. **风险**：这些是未公开 API，随时可能变更。需要 fallback 机制

### 东财防封限流

astock 的经验：东方财富 HTTP API 的封禁阈值实测为每秒 >5 / 并发 ≥10 / 1 分钟 ≥200。他们用 `_em_get()` 统一限流：

```python
_em_session = requests.Session()  # Keep-Alive 复用
_em_min_interval = float(os.environ.get("EM_MIN_INTERVAL", "1.0"))

def _em_get(url, **kwargs):
    """东方财富限流入口：串行 + 随机抖动"""
    _em_lock.acquire()
    try:
        elapsed = time.time() - _em_last_call
        wait = max(0, _em_min_interval - elapsed + random.uniform(0.1, 0.5))
        if wait > 0:
            time.sleep(wait)
        resp = _em_session.get(url, **kwargs)
        return resp
    finally:
        _em_last_call = time.time()
        _em_lock.release()
```

如果我们未来使用东方财富数据，需要类似的限流机制。

---

## 七、北向资金自缓存（P2 · 简单）

### 来源

astock 项目。因上游 API 全面断供而创建的本地缓存方案。

### 问题

astock 发现：东方财富全系北向资金接口（含 akshare `stock_hsgt_hist_em`）自 2024-08-16 后净买额字段全部返回 NaN/None/0。同花顺 `hsgtData` 也是旧缓存。属行业性数据断供。

### 他们的解决方案

```
实时快照（可用） ──→ 追加到本地 CSV
                         │
本地 CSV 累积  ◄──────────┘
     │
历史查询 ←── 读取本地 CSV（数据越跑越丰富）
```

```python
class NorthboundCache:
    """北向资金本地缓存"""

    def _cache_path(self, ticker=None):
        """CSV 路径：~/.tradingagents/cache/northbound_daily.csv"""

    def save_snapshot(self, data):
        """将实时快照追加到 CSV"""

    def load_history(self, days=30):
        """读取本地累积的历史数据"""

    def get_trend(self, today_flow, days=20):
        """今日 vs N日均量 趋势对比"""
```

### 在 Node.js 中的实现思路

1. 如果未来我们的 `hot_money.py` 也遇到北向资金断供问题，可采用同样模式
2. 在 `hot_money.py` 中加入本地 CSV 缓存逻辑
3. 缓存路径：`~/.openclaw/cache/northbound_daily.csv`
4. 新用户首次无历史，但跑得越多数据越丰富

---

## 八、Web UI（P3 · 难）

### 来源

astock 项目。Streamlit 可视化界面，12 个文件。

### 功能

- 侧边栏选 LLM 供应商 + 模型
- 输入股票代码 → 一键分析
- 12 阶段 pipeline 实时进度
- 信号卡片（Buy/Hold/Sell）+ 7 份分析师报告 + 辩论 + 风控
- Markdown / PDF 导出
- 历史记录

### 技术选型

他们选 Streamlit 的理由：
- Python 生态内闭环，无需 Node.js/npm
- 15 分钟长跑分析，Streamlit 的 `session_state` + rerun 轮询模式天然适配
- 新手友好：`pip install -e . && tradingagents-web`

### 对我们的参考

我们已有 HTML 报告生成能力。如果要做 Web UI，有两条路：
1. **Streamlit**（如果 Python 优先）：直接借鉴 astock 的 web/ 目录
2. **Node.js 前端**（如果 TypeScript 优先）：可用 Express + React/Vue，与我们现有 stack 一致

这是低优先级——核心分析能力比 UI 重要。

---

## 附录 A：完整对比总结（AShare + astock）

| 特性 | 我们 | AShare | astock | 优先级 | 难度 |
|------|------|--------|--------|--------|------|
| 信号提取增强 | ✅ 3 层 fallback | 4 层 fallback | 类似 | — | — |
| VPA 量价预计算 | ✅ 已有 | 完整量价预计算 | 类似 | — | — |
| 数据质量门控 | ✅ 已有 | 无 | 两层验证（硬检查+LLM复审） | — | — |
| 交易日历 | ❌ | 完整日历+市场阶段 | 完整日历+市场阶段 | **P0** | 很简单 |
| 反思与记忆 | ❌ | BM25+5 角色记忆 | 简化版反思（CSI300 基准） | **P1** | 中等 |
| 结构化 Claim 辩论 | ❌ | 完整 claim 状态机 | 无 | **P1** | 较难 |
| 结构化输出 Schema | ❌ | 无 | Pydantic schema 约束 LLM | **P1** | 中等 |
| 断点续跑 | ❌ | 无 | SQLite per-ticker checkpoint | **P1** | 难 |
| 更多数据源 | 部分 | 多源 | 7 个免费零鉴权数据源 | **P2** | 简单 |
| 北向资金自缓存 | ❌ | 无 | 实时+本地 CSV 累积 | **P2** | 简单 |
| 意图解析 | ticker+date | 自然语言→结构化意图 | 无 | **P2** | 中等 |
| Context 体系 | 直接注入 | instrument/market/user 三级 | 类似 | **P2** | 中等 |
| 回测服务 | ❌ | 完整回测框架 | 无 | **P3** | 难 |
| 定时调度 | ❌ | DB + scheduler | 无 | **P3** | 难 |
| Web UI | HTML 报告 | 无 | Streamlit 12 文件 | **P3** | 难 |
| 多数据源注册表 | 脚本内 fallback | 抽象 Provider+Registry | interface.py 路由层 | **P3** | 中等 |

## 附录 B：推荐实现顺序

```
Phase 1（基础加固）
  ├── 交易日历（防止非交易日浪费 LLM 调用）
  └── 结构化输出 Schema（减少解析失败率）

Phase 2（智能增强）
  ├── 反思与记忆系统（从历史中学习）
  ├── 结构化 Claim 辩论（提升辩论质量）
  └── 断点续跑（防止长时间分析中断丢失）

Phase 3（数据扩展）
  ├── 腾讯财经 PE/PB 数据
  ├── 同花顺 EPS 一致预期
  └── 北向资金本地缓存

Phase 4（平台化，可选）
  ├── Web UI
  ├── 定时调度
  └── 回测服务
```
