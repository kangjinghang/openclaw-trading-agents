# 外部项目设计参考

> 对比项目：
> - `D:\workspace\github\TradingAgents-AShare` — A 股 fork，侧重反思记忆 + 结构化辩论
> - `D:\workspace\github\TradingAgents-astock` — 原版 TradingAgents (65K⭐) 的 A 股深度 fork，7 周改造，47 文件
> - `D:\workspace\github\TradingAgents-CN` — 企业级 fork，FastAPI+Vue3 平台，ChromaDB 向量记忆，多市场支持
> - `D:\workspace\github\PanWatch` — 自托管 AI 盯盘助手，FastAPI+React，实时监控+持仓管理+全渠道推送+模拟交易
>
> 记录时间：2026-06-07
> 更新时间：2026-06-08
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

---

## 九、ChromaDB 向量记忆（P1 · 中等）

### 来源

CN 项目。与 AShare 的 BM25 关键词检索不同，CN 用 ChromaDB 做语义向量检索。

### 现状对比

| | 我们 | AShare | CN |
|---|------|--------|-----|
| 记忆能力 | ❌ 无 | BM25 关键词匹配 | ChromaDB 向量语义检索 |
| 检索质量 | — | 关键词匹配，精确但不灵活 | 语义相似，能找到「意思相近」的历史反思 |
| 依赖 | — | rank_bm25（纯 Python） | chromadb（需安装），但支持多 embedding provider |
| 离线 | — | ✅ 完全离线 | ✅ 本地 ChromaDB，离线可用 |

### 他们的做法

```python
# tradingagents/agents/utils/memory.py

class ChromaDBManager:
    """单例 ChromaDB 管理器，避免并发创建集合的冲突"""
    _instance = None
    _lock = threading.Lock()

    def __init__(self, persist_directory):
        self.client = chromadb.PersistentClient(path=persist_directory)

    @classmethod
    def get_instance(cls, persist_directory=None):
        """线程安全的单例获取"""
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(persist_directory)
        return cls._instance


class FinancialSituationMemory:
    """ChromaDB 向量记忆系统"""

    def __init__(self, name, config=None, llm_provider=None):
        self.chroma_manager = ChromaDBManager.get_instance()
        self.collection = self.chroma_manager.client.get_or_create_collection(name)
        self.llm_provider = llm_provider

    def add_situations(self, situations_and_advice):
        """存储 (情况, 结论) 对，用 embedding 索引"""
        for situation, recommendation in situations_and_advice:
            embedding = self._get_embedding(situation)
            self.collection.add(
                documents=[situation],
                embeddings=[embedding],
                metadatas=[{"recommendation": recommendation}],
                ids=[f"{self.name}_{len(self.collection)}"]
            )

    def get_memories(self, current_situation, n_matches=1):
        """语义检索与当前情况最相似的历史反思"""
        query_embedding = self._get_embedding(current_situation)
        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=n_matches
        )
        # 返回语义最相似的记忆

    def _get_embedding(self, text):
        """多 provider embedding 支持"""
        if self.llm_provider == "dashscope":
            response = TextEmbedding.call(model=self.embedding, input=text)
        elif self.llm_provider in ("deepseek", "openai"):
            response = self.client.embeddings.create(model=self.embedding, input=text)
        return response.data[0].embedding
```

### 关键设计决策

1. **ChromaDB vs BM25**：ChromaDB 能做语义匹配（「换手率异常高」≈「成交量爆量」），BM25 只能精确匹配关键词。但 ChromaDB 需要额外依赖和 embedding 开销
2. **单例 + 线程锁**：避免多 agent 并发写入 ChromaDB 时的冲突
3. **多 embedding provider**：支持 DashScope（阿里百炼）、DeepSeek、OpenAI 的 embedding 服务，根据当前 LLM provider 自动选择
4. **PersistentClient**：数据持久化到本地文件，重启不丢失

### 在 Node.js 中的实现思路

1. **方案 A — 轻量版**：不用 ChromaDB，用简单的 TF-IDF + 余弦相似度（纯 JS 实现，零依赖）
2. **方案 B — 完整版**：用 ChromaDB 的 HTTP API（ChromaDB Server 模式），Node.js 通过 HTTP 调用
3. **方案 C — 混合版**：先实现 BM25（如 AShare 方案），后期可升级为向量检索
4. **存储路径**：`~/.openclaw/memory/` 下每个角色一个 collection

### 改动范围

- 与「二、反思与记忆系统」合并实现
- 如果选方案 A/C：无额外依赖
- 如果选方案 B：需要部署 ChromaDB Server 或嵌入 Python sidecar

---

## 十、反爬虫对抗（P2 · 简单）

### 来源

CN 项目。AKShare 和东方财富的 HTTP 接口有反爬虫机制，普通 `requests` 会被封 IP。

### 问题

我们的数据脚本用 `mootdx`（TCP 协议）作为主数据源，不受影响。但 akshare fallback（HTTP）可能被反爬。

### 他们的做法

```python
# tradingagents/dataflows/providers/china/akshare.py

class AKShareProvider(BaseStockDataProvider):
    """AKShare 数据提供者，带反爬虫对抗"""

    def __init__(self):
        # 使用 curl_cffi 伪造 TLS 指纹，绕过 Cloudflare/东财反爬
        try:
            from curl_cffi import requests as curl_requests
            self._session = curl_requests.Session()
            self._use_curl = True
        except ImportError:
            self._session = requests.Session()
            self._use_curl = False

    def _request_with_retry(self, url, max_retries=3):
        """带反爬虫对抗的请求"""
        for attempt in range(max_retries):
            try:
                # curl_cffi 伪造 Chrome TLS 指纹
                resp = self._session.get(url, impersonate="chrome120")
                if resp.status_code == 200:
                    return resp.json()
            except Exception:
                time.sleep(2 ** attempt + random.uniform(0, 1))
        return None
```

### 关键技术

1. **curl_cffi**：Python 库，能伪造浏览器的 TLS 指纹（JA3），绕过基于 TLS 指纹的反爬检测
2. **impersonate 参数**：模拟 Chrome/Firefox 的完整 HTTP/2 指纹
3. **指数退避**：被封后等待 2^n 秒重试
4. **降级策略**：curl_cffi 装不了就退回普通 requests

### 在我们项目中的适用性

- **mootdx**（TCP 通达信协议）：不受 HTTP 反爬影响 ✅
- **akshare**（HTTP）：如果未来 akshare 加强反爬，可以引入 curl_cffi
- **优先级低**：我们主数据源是 mootdx，akshare 只是 fallback

### 改动范围

- 仅影响 `skills/trading-kline/scripts/kline.py` 的 `fetch_from_akshare()` 函数
- 需要在 `requirements.txt` 加 `curl_cffi`（可选依赖）

---

## 十一、Tool Call 限次保护（P2 · 简单）

### 来源

CN 项目。他们的 analyst 使用 LangGraph ReAct agent，可以循环调用工具。但 LLM 有时会陷入「调用工具 → 得到结果 → 再调用工具」的死循环。

### 问题

CN 项目的 analyst 是 tool-calling agent（LLM 决定何时调用工具），可能无限循环。我们的 analyst 是「一次性注入数据 + 一次性 LLM 调用」，不存在此问题。但如果未来改为 tool-calling 模式，需要此保护。

### 他们的做法

```python
# tradingagents/agents/utils/agent_states.py

class AgentState(MessagesState):
    # 每个 analyst 有独立的工具调用计数器
    market_tool_call_count: int
    news_tool_call_count: int
    fundamentals_tool_call_count: int
    social_media_tool_call_count: int
    # ...

# tradingagents/graph/conditional_logic.py

def should_continue_market(self, state):
    """检查市场分析师是否需要继续调用工具"""
    tool_call_count = state.get("market_tool_call_count", 0)
    max_calls = 3  # 每个 analyst 最多调用 3 次工具

    if tool_call_count >= max_calls:
        logger.info(f"Market analyst tool calls reached limit ({max_calls}), moving to next node")
        return "next_agent"

    messages = state["messages"]
    last_message = messages[-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"  # 继续调用工具
    return "next_agent"  # 没有工具调用，进入下一步
```

### 在我们项目中的适用性

- **当前不适用**：我们的 analyst 不使用 tool-calling，而是预获取数据后一次性调用 LLM
- **未来适用场景**：如果改为 ReAct agent 模式（LLM 自主决定何时获取什么数据），需要加入此保护
- **简单实现**：在 agent state 中加计数器，超过阈值强制退出

### 改动范围

- 仅在改为 tool-calling agent 架构时才需要
- 改动量小：状态加计数器 + 条件路由加判断

---

## 十二、多市场支持（P2 · 中等）

### 来源

CN 项目。支持 A 股、港股、美股三个市场，自动检测并适配。

### 现状对比

| | 我们 | CN |
|---|------|-----|
| 支持市场 | 仅 A 股 | A 股 + 港股 + 美股 |
| 市场检测 | 手动传 ticker | 自动检测（6位=A股，5位=港股，字母=美股） |
| 货币符号 | 固定 ¥ | 自适应（¥ / HK$ / $） |
| 交易规则 | A 股规则（T+1, 涨跌停） | 按市场切换规则 |
| 数据源 | mootdx + akshare | AKShare + Tushare + BaoStock + FinnHub + Yahoo |

### 他们的市场检测

```python
def detect_market(ticker: str) -> str:
    """自动检测市场类型"""
    if ticker.isdigit():
        if len(ticker) == 6:
            return "china"      # A 股：600519
        elif len(ticker) == 5:
            return "hongkong"   # 港股：00700
    elif ticker.isalpha():
        return "us"             # 美股：AAPL
    return "unknown"
```

### 他们的多市场数据路由

```python
# tradingagents/dataflows/__init__.py

def get_stock_data(ticker, *args, **kwargs):
    market = detect_market(ticker)
    if market == "china":
        return china_data.get_stock_data(ticker, *args, **kwargs)
    elif market == "hongkong":
        return hk_data.get_stock_data(ticker, *args, **kwargs)
    elif market == "us":
        return us_data.get_stock_data(ticker, *args, **kwargs)
```

### 他们的港股数据源优先级

```python
def _get_enabled_hk_data_sources() -> list:
    """从数据库读取用户启用的港股数据源配置"""
    # 动态配置：运行时可切换数据源优先级
    # 默认：['akshare', 'yfinance']
    # 可扩展：['akshare', 'yfinance', 'tushare', 'xueqiu']
```

### 在 Node.js 中的实现思路

1. **市场检测函数**：在 `orchestrator.ts` 加 `detectMarket(ticker)` — 3 行代码
2. **数据脚本路由**：每个市场独立的数据脚本目录（如 `skills/trading-kline-hk/`）
3. **Prompt 差异化**：按市场选择不同的 prompt 模板（A 股用 T+1/涨跌停，港股用 T+0，美股用 PDT 规则）
4. **货币符号**：在 `FinalDecision` 中加 `currency` 字段

### 改动范围

- `orchestrator.ts` — 加市场检测 + 路由
- 新增港股/美股数据脚本
- 新增/修改 prompt 模板
- `types.ts` — 加 currency 字段

---

## 十三、多层缓存架构（P3 · 可选）

### 来源

CN 项目。MongoDB + Redis + 文件三层缓存。

### 现状对比

| | 我们 | CN |
|---|------|-----|
| 缓存层 | 文件缓存（SHA256 key, 4h TTL） | MongoDB + Redis + 文件三级 |
| 缓存策略 | 固定 TTL | 自适应：行情 15min，财报 4h，新闻 1h |
| 持久化 | JSON 文件 | MongoDB（可查询） |
| 适用场景 | 单用户、单机 | 多用户、生产环境 |

### 他们的缓存策略

```python
# tradingagents/dataflows/optimized_china_data.py

class OptimizedChinaDataProvider:
    """带缓存和限流的统一 A 股数据接口"""

    CACHE_POLICIES = {
        "realtime_quote": {"ttl": 900, "store": "redis"},     # 实时行情 15 分钟
        "kline_daily": {"ttl": 3600, "store": "redis"},       # 日 K 线 1 小时
        "financial_report": {"ttl": 14400, "store": "mongodb"},# 财报 4 小时
        "company_info": {"ttl": 86400, "store": "mongodb"},    # 公司信息 24 小时
        "news": {"ttl": 1800, "store": "redis"},               # 新闻 30 分钟
    }

    def get_data(self, data_type, ticker, **kwargs):
        # 1. 检查 Redis（快速，但容量小）
        cached = self.redis.get(cache_key)
        if cached:
            return cached

        # 2. 检查 MongoDB（慢，但持久化）
        cached = self.mongodb.find_one({"key": cache_key})
        if cached and not self._is_expired(cached):
            self.redis.set(cache_key, cached, ttl=policy["ttl"])
            return cached

        # 3. 从数据源获取
        data = self._fetch_from_source(data_type, ticker, **kwargs)

        # 4. 写入缓存
        self.redis.set(cache_key, data, ttl=policy["ttl"])
        self.mongodb.update_one({"key": cache_key}, {"$set": data}, upsert=True)

        return data
```

### 在我们项目中的适用性

- **当前不需要**：我们已有文件缓存 + 4h TTL，足够用
- **未来场景**：多用户并发分析时，MongoDB 缓存可避免重复获取相同股票数据
- **建议**：先保持现有文件缓存，仅在并发场景出现性能问题时再升级

---

## 十四、Web 平台架构（P3 · 参考）

### 来源

CN 项目。FastAPI 后端 + Vue 3 前端，商业授权。

### 架构总览

```
                    ┌─────────────────────┐
                    │   Nginx 反向代理     │
                    │   (SSL + 负载均衡)    │
                    └─────┬───────────┬───┘
                          │           │
              ┌───────────▼──┐  ┌─────▼──────────┐
              │  FastAPI 后端 │  │  Vue 3 前端     │
              │  (Python)     │  │  (Element Plus) │
              │               │  │                  │
              │  - REST API   │  │  - 股票分析      │
              │  - WebSocket  │  │  - 实时进度      │
              │  - SSE 推送   │  │  - 报告查看      │
              │  - 用户管理   │  │  - 历史记录      │
              │  - 定时任务   │  │  - PDF 导出      │
              └───────┬───────┘  └──────────────────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
    ┌─────▼───┐ ┌────▼────┐ ┌───▼────┐
    │ MongoDB │ │  Redis  │ │ Chroma │
    │ 数据存储 │ │ 缓存    │ │ 向量库 │
    └─────────┘ └─────────┘ └────────┘
```

### 后端模块结构

```
app/
├── main.py              # FastAPI 入口
├── core/                # 认证、配置、安全
├── middleware/           # 限流、日志、CORS
├── models/              # MongoDB 数据模型
├── routers/             # API 路由定义
│   ├── analysis.py      # 分析相关 API
│   ├── auth.py          # 认证 API
│   ├── config.py        # 配置管理 API
│   ├── stocks.py        # 股票操作 API
│   └── scheduler.py     # 定时任务 API
├── schemas/             # 请求/响应校验
├── services/            # 业务逻辑层
└── worker/              # 后台任务执行
```

### 前端功能

```
frontend/src/
├── api/
│   ├── analysis.ts      # 分析 API 调用
│   ├── auth.ts          # 认证
│   ├── config.ts        # 配置管理
│   ├── favorites.ts     # 自选股
│   ├── scheduler.ts     # 定时任务
│   └── stocks.ts        # 股票数据
├── views/               # 页面组件
├── components/          # UI 组件
└── stores/              # Pinia 状态管理
```

### 对我们的参考价值

如果我们未来要做 Web UI，CN 项目的架构可以作为参考：
1. **不推荐照搬**：FastAPI + Vue + MongoDB + Redis + ChromaDB 依赖太多
2. **推荐简化版**：
   - 后端：用 Node.js（与我们现有 stack 一致），Express 或 Hono
   - 前端：轻量 SPA 或直接用 Streamlit（如 astock 方案）
   - 缓存：保持现有文件缓存
   - 数据库：可选 SQLite（如 astock 的 checkpointer）
3. **最小可行方案**：Streamlit（astock 已验证）+ 文件存储，5 个文件即可

---

---

## 十五、建议池与稳定性逻辑（P0 · 简单）

### 来源

PanWatch。`src/core/suggestion_pool.py`。

### 问题

我们的 analyst 报告是一次性的——分析完就结束，没有持久化、没有过期、没有去重。未来做定时调度时，同一股票可能短时间内被多次分析，产生大量重复建议。

### 他们的做法

```python
# suggestion_pool.py — 统一建议池

# 1. 按 Agent 设过期时间
AGENT_EXPIRY_HOURS = {
    "premarket_outlook": 12,   # 盘前建议当日有效
    "intraday_monitor": 6,     # 盘中建议 6 小时有效
    "daily_report": 16,        # 盘后建议隔夜有效
    "news_digest": 12,         # 新闻速递半天有效
}

# 2. 去重窗口（同一 Agent 对同一股票）
def _dedupe_window_minutes(agent_name):
    if agent_name == "intraday_monitor": return 30
    if agent_name == "news_digest": return 60
    return 180

# 3. 防翻转逻辑
action_rank = {
    "alert": 4, "avoid": 4, "sell": 4,
    "reduce": 3, "buy": 2, "add": 2,
    "hold": 1, "watch": 0,
}
# 新建议比旧的更温和时 → 保留旧的、只延长过期时间
if (now - latest_created) <= change_window and new_r < old_r:
    latest.expires_at = expires_at  # 延长
    return True  # 不创建新建议
```

关键设计：
- **持久化**：所有建议写入 SQLite，有 created_at / expires_at
- **去重**：同一 Agent + 同一股票 + 相同 action+signal，在窗口内不重复
- **防翻转**：建议有严重度排名，新建议更温和时保留旧的，避免 AI 观点反复摇摆
- **过期清理**：定时清理 7 天前的过期记录

### 实现建议

在 `src/` 下新增 `suggestion-pool.ts`：
- `saveSuggestion(report: AnalystReport, verdict: Verdict): void`
- `getSuggestionsForStock(ticker: string): Suggestion[]`
- `cleanupExpiredSuggestions(days: number): number`
- 防翻转逻辑可直接复用 action_rank 思路
- 存储可先用 JSON 文件，后续升级 SQLite

---

## 十六、事件驱动门控（P1 · 简单）

### 来源

PanWatch。`src/core/intraday_event_gate.py`。

### 问题

当前我们是手动触发分析。未来做盘中实时监控时，不能每次 tick 都调 AI（太贵、太慢），需要智能判断何时触发分析。

### 他们的做法

```python
# intraday_event_gate.py — 事件门控

def check_and_update(*, symbol, change_pct, volume_ratio, kline_summary,
                     price_threshold, volume_threshold) -> EventDecision:
    reasons = []

    # 触发条件 1：涨跌幅超过阈值
    if abs(change_pct) >= price_threshold:
        reasons.append("price_threshold")

    # 触发条件 2：量比超过阈值
    if volume_ratio >= volume_threshold:
        reasons.append("volume_threshold")

    # 触发条件 3：技术状态变化（对比上一次）
    new_sig = _tech_sig(kline_summary)  # {trend, macd, rsi, kdj, boll, pattern}
    old_sig = previous_state.get("tech_sig")
    if old_sig != new_sig:
        reasons.append("tech_state_changed")

    # 持久化最新状态到 JSON 文件
    write_json_atomic(state_path, state)
    return EventDecision(should_analyze=bool(reasons), reasons=reasons)
```

关键设计：
- **状态 diff**：只对比技术指标组合是否变化，不关心数值大小
- **持久化**：状态存 JSON 文件，重启不丢失
- **原子写入**：write_json_atomic 先写临时文件再 rename，防数据损坏
- **仅作参考信号**：门控不阻断分析，只是标记是否有事件触发，最终由上层决定是否通知

### 实现建议

在 `src/` 下新增 `event-gate.ts`：
- `checkAndUpdate(symbol, quote, klineSummary, thresholds): EventDecision`
- 状态持久化到 `~/.openclaw/trading-reports/event-state.json`
- 技术指标摘要：`{ trend, macdStatus, rsiStatus, kdjStatus, bollStatus }`
- 纯函数，无外部依赖

---

## 十七、数据覆盖度评分（P1 · 简单）

### 来源

PanWatch。`src/core/context_builder.py` 的 `_estimate_quality_score()`。

### 问题

我们的质量门控 (`quality-gate.ts`) 是**硬检查**——检查空报告、错误标记、短长度。但没有评估数据源的覆盖度：即使报告很长，如果多个数据源失败了，分析质量也不高。

### 他们的做法

```python
def _estimate_quality_score(coverage) -> int:
    score = 100
    if not coverage.get("quote"):          score -= 35  # 无行情，最关键
    if not coverage.get("technical"):      score -= 25  # 无技术面
    if not coverage.get("kline_history"):  score -= 10  # 无历史K线
    if not coverage.get("news_realtime"):  score -= 15  # 无实时新闻
    if not coverage.get("news_extended"):  score -= 10  # 无扩展新闻
    if not coverage.get("history_news"):   score -= 10  # 无历史新闻
    if not coverage.get("events"):         score -= 5   # 无事件
    return max(0, min(100, score))
```

质量分还会追踪趋势（improving / deteriorating / flat），存入数据库供后续参考。

### 与我们现有质量门控的互补

| 维度 | 我们现有 | PanWatch 做法 | 结合方案 |
|------|---------|-------------|---------|
| 报告内容 | A-F 硬检查 | — | 保留 |
| 数据覆盖度 | — | 0-100 软评分 | 新增 |
| 趋势追踪 | — | improving/flat/deteriorating | 新增 |

### 实现建议

在 `src/quality-gate.ts` 中扩展：
- 新增 `estimateCoverageScore(sources: DataSourceResult[]): number`
- 每个 analyst report 的 `data_sources_used` 已有字段，可直接统计
- 覆盖度评分加入 `QualitySummary`，注入 prompt 时给下游 agent 参考

---

## 十八、预测结果追踪（P1 · 中等）

### 来源

PanWatch。`src/core/prediction_outcome.py` + `src/core/context_store.py`。

### 问题

分析做完就结束了，不知道历史建议是否靠谱。没有反馈回路就无法改进。

### 他们的做法

**分析时记录预测**（每次 AI 给出操作建议后自动执行）：
```python
# 记录预测：1 天后和 5 天后各一条
for horizon in (1, 5):
    save_agent_prediction_outcome(
        agent_name="intraday_monitor",
        stock_symbol=symbol,
        prediction_date=today,
        horizon_days=horizon,
        action="buy",
        trigger_price=current_price,
    )
```

**后台定时评估**：
```python
def evaluate_pending_prediction_outcomes():
    pending = list_pending_prediction_outcomes(max_horizon_days=10)
    for rec in pending:
        target_day = prediction_date + horizon_days
        if target_day > today: continue  # 还没到期

        # 拿目标日期的实际收盘价
        outcome_price = _pick_close_on_or_before(klines, target_day)
        outcome_ret = (outcome_price - base_price) / base_price * 100

        mark_agent_prediction_outcome(
            record_id=rec.id,
            outcome_price=outcome_price,
            outcome_return_pct=outcome_ret,
            status="evaluated",
        )
```

关键设计：
- **多时间窗口**：1 天和 5 天两个 horizon，覆盖短线和中线
- **K 线缓存**：评估时批量获取 K 线数据，避免逐条请求
- **完整闭环**：预测 → 实际结果 → 准确率统计

### 实现建议

在 `src/` 下新增 `prediction-tracker.ts`：
- 分析完成时自动记录：`savePrediction(ticker, date, action, price, horizonDays)`
- 需要定时评估器（可集成到 dashboard 或独立 cron）
- 存储：先 JSON 文件，后续 SQLite

---

## 十九、分层新闻上下文（P2 · 中等）

### 来源

PanWatch。`src/core/context_builder.py` + `src/core/news_ranker.py`。

### 问题

我们的 news.py 脚本只抓当日新闻，没有跨天记忆，没有时间分层。AI 缺少历史新闻背景。

### 他们的做法

```python
# 三层新闻结构，按时间窗口分层
news = {
    "realtime": pack_news[:8],           # 最近 6-12h，最多 8 条
    "extended": pack_news[:12],          # 最近 24-72h，最多 12 条
    "history": historical_news[:15],     # 过去 7 天，最多 15 条
    "history_topic": topic_summary,      # 历史新闻主题概括
}
```

还有**跨天历史新闻记忆**：从数据库中读取过去 7 天所有 agent 分析过的相关新闻，按 symbol 过滤、去重、排序后提供给 AI。

### 实现建议

在 news.py 或 orchestrator 中：
- 增加 `history_days=7` 参数，扩展新闻抓取时间窗口
- 按时间分层打包，而不是一个大列表
- 历史新闻做主题摘要（可用 AI 做，或简单用关键词聚合）

---

## 二十、持仓约束注入（P2 · 中等）

### 来源

PanWatch。`src/core/context_builder.py` 的 `_build_portfolio_constraints()`。

### 问题

我们的 trader prompt 不知道用户是否已经持有该股、仓位多大、成本多少。交易计划可能不切实际。

### 他们的做法

```python
{
    "has_position": True,
    "position": {
        "total_quantity": 1000,
        "avg_cost": 25.80,
        "trading_style": "swing",   # 短线/波段/长线
    },
    "single_position_ratio": 0.28,  # 该股占总仓位 28%
    "risk_budget_hint": "normal",   # strict(>35%) / normal(>20%) / relaxed
    "total_available_funds": 50000,
}
```

### 实现建议

- 在 `trading_full` 的调用参数中增加可选的持仓信息
- 如果用户提供了持仓数据，注入 trader prompt
- risk_budget_hint 让 AI 知道风控约束

---

## 二十一、通知去重与静默时段（P2 · 简单）

### 来源

PanWatch。`src/core/notify_dedupe.py` + `src/core/notify_policy.py`。

### 问题

如果未来加推送功能，需要防止短时间内重复推送相同内容。

### 他们的做法

- **内容去重**：基于 agent_name + title + content 哈希，TTL 内不重复推送
- **静默时段**：可配置"免打扰"时间（如 23:00-07:00），支持跨午夜
- **失败安全**：去重逻辑出错时宁可多发，不可漏发
- **per-Agent TTL**：盘中 30 分钟、盘前 12 小时、新闻 1 小时

### 实现建议

等推送功能开发时再考虑。核心模式是 content hash + TTL + quiet hours。

---

## 二十二、模拟交易引擎（P3 · 复杂）

### 来源

PanWatch。`src/core/paper_trading_engine.py` + `src/core/paper_trading_scheduler.py`。

### 功能概述

- 多市场资金分配（CN:HK:US 可配比例）
- 100 股整数倍买入
- 动态止损/止盈计算
- 峰值资产和最大回撤跟踪
- 60 秒扫描 + 入场/出场自动触发
- 完整的 P&L 报表

### 借鉴价值

长期可考虑，但优先级低。需要先有策略信号系统 (src/core/signals/) 才能驱动。

---

## 附录 A：完整对比总结（AShare + astock + CN + PanWatch）

| 特性 | 我们 | AShare | astock | CN | PanWatch | 优先级 | 难度 |
|------|------|--------|--------|-----|----------|--------|------|
| 信号提取增强 | ✅ 3 层 fallback | 4 层 fallback | 类似 | 类似 | — | — | — |
| VPA 量价预计算 | ✅ 已有 | 完整量价预计算 | 类似 | 无 | 完整技术指标 | — | — |
| 数据质量门控 | ✅ 硬检查 | 无 | 两层验证 | 无 | 覆盖度评分 | — | — |
| 交易日历 | ❌ | 完整日历+市场阶段 | 完整日历+市场阶段 | 有 | 按市场交易时段 | **P0** | 很简单 |
| 建议池+防翻转 | ❌ | 无 | 无 | 无 | 完整持久化+去重+防翻转 | **P0** | 简单 |
| 事件驱动门控 | ❌ | 无 | 无 | 无 | 技术状态 diff 触发 | **P1** | 简单 |
| 数据覆盖度评分 | ❌ | 无 | 无 | 无 | 0-100 软评分+趋势追踪 | **P1** | 简单 |
| 预测结果追踪 | ❌ | 无 | 无 | 无 | 多 horizon 闭环反馈 | **P1** | 中等 |
| 反思与记忆 | ❌ | BM25+5 角色记忆 | 简化版反思 | ChromaDB 向量记忆 | 跨天上下文快照 | **P1** | 中等 |
| 结构化 Claim 辩论 | ❌ | 完整 claim 状态机 | 无 | 无 | 无 | **P1** | 较难 |
| 结构化输出 Schema | ❌ | 无 | Pydantic schema | 有 | JSON+宽松 fallback | **P1** | 中等 |
| 断点续跑 | ❌ | 无 | SQLite checkpoint | 无 | 无 | **P1** | 难 |
| ChromaDB 向量记忆 | ❌ | 无 | 无 | ChromaDB 语义检索 | 无 | **P1** | 中等 |
| 分层新闻上下文 | ❌ | 无 | 无 | 无 | realtime/extended/history 三层 | **P2** | 中等 |
| 持仓约束注入 | ❌ | 无 | 无 | 无 | 仓位占比+风控提示+交易风格 | **P2** | 中等 |
| 通知去重+静默 | ❌ | 无 | 无 | 无 | content hash+TTL+quiet hours | **P2** | 简单 |
| 反爬虫对抗 | ❌ | 无 | 东财限流 | curl_cffi TLS 指纹 | 腾讯 API 稳定源 | **P2** | 简单 |
| Tool Call 限次 | ❌ | 无 | 无 | 计数器防死循环 | 无 | **P2** | 简单 |
| 多市场支持 | ❌ 仅 A 股 | 仅 A 股 | 仅 A 股 | A 股+港股+美股 | A 股+港股+美股 | **P2** | 中等 |
| 更多免费数据源 | 部分 | 多源 | 7 个零鉴权源 | Tushare+AKShare+BaoStock+FinnHub | efinance+akshare+tencent | **P2** | 简单 |
| 北向资金自缓存 | ❌ | 无 | 实时+CSV 累积 | 无 | 无 | **P2** | 简单 |
| 模拟交易引擎 | ❌ | 完整回测框架 | 无 | 无 | Paper Trading 完整系统 | **P3** | 难 |
| 多层缓存架构 | 文件缓存 | 无 | 无 | MongoDB+Redis+文件 | SQLite+JSON 文件 | **P3** | 中等 |
| Web UI | HTML 报告 | 无 | Streamlit | FastAPI+Vue3 | FastAPI+React+shadcn/ui | **P3** | 难 |
| Docker 部署 | ❌ | 无 | Dockerfile | docker-compose+nginx | Docker 一键部署 | **P3** | 中等 |
| 定时调度 | ❌ | DB+scheduler | 无 | Worker+调度器 | APScheduler 多调度器 | **P3** | 难 |

## 附录 B：推荐实现顺序

```
Phase 1（基础加固）
  ├── 交易日历（防止非交易日浪费 LLM 调用）
  ├── 建议池+防翻转（操作建议持久化、去重）
  └── 结构化输出 Schema（减少解析失败率）

Phase 2（智能增强）
  ├── 事件驱动门控（智能调度，减少无效 AI 调用）
  ├── 数据覆盖度评分（与现有质量门控互补）
  ├── 预测结果追踪（闭环反馈，验证分析准确率）
  ├── 反思与记忆系统（从历史中学习）
  ├── 结构化 Claim 辩论（提升辩论质量）
  └── 断点续跑（防止长时间分析中断丢失）

Phase 3（数据扩展 + 上下文增强）
  ├── 分层新闻上下文（跨天新闻记忆）
  ├── 持仓约束注入（交易计划更贴合实际）
  ├── 腾讯财经 PE/PB 数据
  ├── 同花顺 EPS 一致预期
  └── 北向资金本地缓存

Phase 4（平台化，可选）
  ├── 通知去重+静默时段
  ├── 模拟交易引擎
  ├── Web UI
  ├── 定时调度
  └── 多市场支持
```
