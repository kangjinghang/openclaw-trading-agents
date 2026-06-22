# 数据源

[English](data-sources.md) | 中文

OpenClaw Trading Agents 使用的 A 股市场数据源。所有数据源均为免费公开接口。

## 总览

| 技能 | 数据类型 | 主源 | 备源 | Python 依赖 |
|------|---------|------|------|------------|
| trading-kline | K 线 OHLCV | mootdx (通达信 TCP 7709) | akshare (新浪 HTTP) | `mootdx`, `akshare` |
| trading-fundamentals | PE/PB/ROE/财务数据 | 腾讯财经 / 东方财富 | mootdx F10 | `mootdx`, `akshare` |
| trading-news | 个股新闻 + 宏观新闻 | 财联社 / 东方财富 | — | `requests`, `akshare` |
| trading-sentiment | 市场情绪 / 涨停情绪池 | 东方财富 | akshare (zt_pool) | `akshare` |
| trading-policy | 政策事件 | 东方财富搜索 / 财联社 | — | `requests` |
| trading-hot-money | 北向资金/主力资金/板块资金流/龙虎榜 | 东方财富 | akshare | `akshare`, `requests` |
| trading-lockup | 解禁/内部人交易 | 东方财富 / mootdx F10 | akshare | `mootdx`, `akshare` |
| trading-sector | 行业排名/概念板块 | 东方财富 / 百度 | akshare | `akshare`, `requests` |
| watchlist | 股票池异动归因 | 雪球 abnormal/reasons.json | akshare（universe） | `requests` |

## 数据源详情

### K 线数据（`trading-kline`）

```python
# 主源：mootdx（通达信 TCP 协议，最稳定）
from mootdx.quotes import Quotes
client = Quotes.factory(market="std")
df = client.bars(symbol=stock_code, frequency=9, offset=count)

# 备源：akshare（新浪财经 HTTP）
import akshare as ak
df = ak.stock_zh_a_hist(symbol=stock_code, period="daily", adjust="qfq")
```

### 基本面（`trading-fundamentals`）

PE(TTM)、PB、总市值、季度财务数据来自腾讯财经和东方财富。资产负债表/现金流量表/利润表来自新浪财经（通过 akshare）。

### 新闻（`trading-news`）

- 个股新闻：东方财富搜索 API
- 宏观/全球新闻：财联社实时电报 + 东方财富

### 情绪（`trading-sentiment`）

- 热门股排行 / 市场宽度：东方财富 push2
- 个股新闻情绪评分：东方财富搜索 API + 关键词字典打分
- **涨停情绪池（`zt_pool`）**：akshare `stock_zt_pool_em`（底层东方财富 push2ex），含涨停家数、连板梯队分布、龙头高度、标的命中检测；非交易日自动回溯最近交易日

### 政策（`trading-policy`）

- 政策事件：东方财富搜索 API
- 宏观快讯：财联社实时政策公告

### 资金流向（`trading-hot-money`）

- 北向资金（沪股通/深股通）：东方财富 push2 API
- 个股主力资金流向（主力/散户）：东方财富
- 板块资金流排名：行业板块主力净流入 inflow/outflow top8（东方财富 push2 clist）
- 龙虎榜：东方财富，含席位明细

### 解禁（`trading-lockup`）

- 解禁日历 + 影响评估：东方财富
- 内部人交易：mootdx F10

### 行业板块（`trading-sector`）

- 行业排名（90 个行业，含日涨跌幅）：东方财富 `push2` API
- 概念板块：~~百度股市通~~（2026-06 起 API 返回 403），东方财富 `push2` API

> **注意**：`push2.eastmoney.com` 使用流量管理器（负载均衡），会解析到不同 IP。部分网络环境下 IPv6 连接在 TLS 重协商时被服务端断开。共享模块 `http_helpers.py` 已强制 IPv4 DNS 解析作为缓解措施。所有脚本均能优雅处理 API 失败 — 返回空数据而非崩溃。

### 雪球异动（`watchlist`，股票池维护）

- **universe 清单**：akshare `stock_info_a_code_name`（约 5207 只，排除北交所）
- **异动归因**：雪球 `abnormal/reasons.json`（需 cookie `xq_a_token`），返回单股异动：
  - `reason_list`：天级异动点（timestamp + description + reason）
  - `range_reason_list`：区间趋势（begin/end/type=LONG|SHORT/percent/summary）
  - 没有异动的股返回空数组——接口本身是天然异动过滤器
- **时间窗口**：滚动 14 个月（覆盖长周期趋势，同时让 diff 持续发现新异动）
- **交易日语义**：雪球纯交易日驱动（周末/节假日无数据）、盘后才有当日数据；管道按 data_date（数据实际最新交易日）驱动，非自然日
- **幂等**：data_date 快照已存在则跳过
- **产物（两个候选榜，互补）**：`derived/{date}-candidates.json`（**区间异动榜**，持续上涨趋势，按 days>幅度排）+ `derived/{date}-daily-candidates.json`（**单日异动榜**，今日脉冲，按涨幅排）

> 设计：[`superpowers/specs/2026-06-17-watchlist-stock-pool-design.md`](superpowers/specs/2026-06-17-watchlist-stock-pool-design.md) + [`superpowers/specs/2026-06-18-trading-day-handling-design.md`](superpowers/specs/2026-06-18-trading-day-handling-design.md)

## Fallback 模式

每个数据脚本遵循统一的 fallback 结构：

```python
SOURCES = [
    {"name": "eastmoney", "fetch": fetch_from_eastmoney, "priority": 1},
    {"name": "akshare",   "fetch": fetch_from_akshare,   "priority": 2},
]

def fetch(ticker, **params):
    last_error = None
    for source in sorted(SOURCES, key=lambda s: s["priority"]):
        try:
            result = source["fetch"](ticker, **params)
            result["_source"] = source["name"]
            return result
        except Exception as e:
            logger.warning(f"{source['name']} failed: {e}")
            last_error = e
    return {"success": False, "error": f"all sources failed: {last_error}"}
```

## 限流注意事项

- **东方财富**：有请求限速保护，脚本使用 ≥1s 间隔 + 随机抖动 + session 复用。
- **mootdx**：使用 TCP 直连（非 HTTP），更稳定。
- **akshare**：聚合多个数据源（含东方财富），可作为通用备源。

## 数据源健康监控

每个数据脚本调用数据源时通过 `http_helpers.record_call(stage, success, error, duration_ms)` 记录**每次调用结果**（成功+失败均记），`output_json()` 把累积记录作为顶层 `_calls` 数组输出。orchestrator 收集所有 `_calls`，分两路派发：

1. **本 run 视图**：失败调用推到 `pipeline_health`（`check: "source_call_failed"`），可在 `report.json.pipeline_health` 看到，每次分析报告独立可见
2. **跨 run 持久化**：所有调用追加到 `~/.openclaw/trading-reports/_source-health.json`，环形 buffer 每 source 最近 2000 次（覆盖 1+ 年），含 `success_rate` / `last_error` / `avg_duration_ms` 等派生统计。CLI 和 dashboard 都支持按周期过滤（3d / 7d / 30d / 1y / all），在读取时通过 `filterHistorySince` 动态重算 stats——无需按日聚合即可观察长期稳定性

向后兼容：`record_error(stage, msg)` 是 `record_call(stage, success=False, error=msg)` 的别名，旧调用点继续工作；`output_json` 同时输出 `_errors`（只失败，老格式）和 `_calls`（全部，新格式）。

### Stage 命名规范

格式 `<role>/<sub_source>`（slash 分层便于聚合，如 `hot_money/*` 可看整个 hot_money 健康度）。共 21 个子源：

| Role | 子源 stage | 主备关系 |
|---|---|---|
| `kline` | `kline/mootdx`、`kline/akshare` | mootdx 主 → akshare 备 |
| `fundamentals` | `fundamentals/tencent`、`fundamentals/mootdx`、`fundamentals/em_push2`、`fundamentals/em_datacenter`、`fundamentals/em_quarterly`、`fundamentals/em_consensus`、`fundamentals/akshare` | 多源拼装；`em_push2` 与 `em_datacenter` 是行业/公司名 fallback 对（前者限流后切后者） |
| `news` | `news/stock_em`、`news/macro_akshare` | 宏观：东方财富全球快讯（akshare）单源；CLS 已移除（接口失效） |
| `policy` | `policy/stock_em`、`policy/macro_akshare` | 同 news |
| `sentiment` | `sentiment/hot_rank`、`sentiment/zt_pool` | 均东方财富 |
| `hot_money` | `hot_money/northbound`、`hot_money/fund_flow`、`hot_money/hot_stocks`、`hot_money/dragon_tiger`、`hot_money/sector_fund_flow` | 均东方财富（fund_flow/sector_fund_flow 受 push2 限流影响大） |
| `lockup` | `lockup/ann_em`、`lockup/reduce_em` | 均东方财富 |

### 观测方式（3 个面）

**1. CLI（推荐日常使用）**：
```bash
npm run source-health                            # 表格输出（默认，全历史，按失败源在前排序）
npm run source-health -- --period 7d             # 只看最近 7 天（同样支持 3d / 30d / 90d / 1y / all）
npm run source-health -- --period=30d            # 等号写法（与空格写法等价）
npm run source-health -- --json                  # JSON 输出（脚本友好）
npm run source-health -- --json --period 30d     # JSON + 周期过滤（顶层含 period: {filter, since} 字段）
npm run source-health -- --failing               # 只看最近有失败的 source
npm run source-health -- --failing --period 30d  # 失败过滤 + 周期过滤
REPORT_DIR=/custom/path npm run source-health    # 自定义 report 路径
```

> **`--period` 语义**：ring buffer 现在覆盖每 source 最近 2000 次调用（约 1+ 年），不传 `--period` 即看全量。传 `--period 7d` 会先把每个 source 的 history 过滤为 `ts >= (now - 7d)` 再重算 stats，所以可以观察长期稳定性趋势（机房 vs 家里数据源表现差异等）。period 内 0 次调用的 source 显示 `(no data in period)` 而非 `0/0 (0%)`，避免误判为"该 source 不存在"。

**2. Dashboard**：detail tab 顶部"数据源健康"卡片，红色 `!` 标识有失败的 source，按 `success_rate` 升序排（最差的在前）。卡片标题右侧有周期下拉（全部 / 1 年 / 30 天 / 7 天 / 3 天），切换时表格内容就地刷新（无需重新 fetch）。period 内 0 次调用的 source 行显示 `(no data in period)`。

**3. report.json**：每次分析的 `pipeline_health` 数组含 `{check: "source_call_failed", context: {source, error}}` warn，记录本次 run 的失败子源。

### 设计参考

- 设计 spec：`docs/superpowers/specs/2026-06-15-data-source-health-design.md`
- 实施 plan：`docs/superpowers/plans/2026-06-15-data-source-health.md`
- 核心模块：`src/source-health-store.ts`（`SourceHealthStore` 类 + `computeStats` 纯函数）
- Python 收集器：`skills/_shared/http_helpers.py`（`record_call` / `record_error` / `get_calls`）

## 已知问题（基于 _source-health.json 跨 run 观察，2026-06）

> 以下问题来自真实运行 `_source-health.json` 数据 + `stability-audit.zh.md` 报告。失效源**不阻塞 pipeline** ——脚本返回空数据，分析继续；监控让失效可见、可诊断。

| 问题 | 影响子源（stage 名） | 表现（实测） | 缓解措施 |
|------|--------------------|------------|---------|
| 财联社 `cls.cn/nodeapi/telegraphList` 接口失效 | `news/macro_cls`、`policy/macro_cls`（已移除） | JSON 解析失败 / 404；稳定 3/3 失败（2026-06 实测） | 已从 news.py/policy.py 移除 CLS 直连；宏观改为 `akshare.stock_info_global_em` 单源（东方财富全球快讯，200 条，0.2s），`macro_news_source` = `eastmoney`。akshare 自己的 CLS 实现用的也是这个失效 URL，保留无意义 |
| `akshare` 模块未安装（部分环境） | `news/macro_akshare`、`policy/macro_akshare`、`fundamentals/akshare`、`sentiment/hot_rank`、`sentiment/zt_pool` | "No module named 'akshare'"；多个子源 0/N | `pip install akshare>=1.15`；缺失时影响下游分析师缺宏观腿/涨停情绪池 |
| `push2.eastmoney.com` IP 限流（Connection aborted） | `fundamentals/em_push2`、`hot_money/fund_flow`、`hot_money/sector_fund_flow` | 间歇性失败；同 IP 持续 ~15min+ | `http_helpers.py` 强制 IPv4 + ≥1s 节流；fundamentals 切到 `datacenter-web.eastmoney.com`（不受 push2 限流）；script 内 try/except 优雅降级 |
| `push2.eastmoney.com` IPv6 TLS 重置（旧问题） | `trading-sector`（独立 skill，未走 health 追踪） | 行业排名可能返回空 | 同上：强制 IPv4 |
| 百度股市通 `getrelatedblock` API 返回 403（2026-06 起） | `trading-sector`（独立 skill） | 概念板块返回 `null` | 暂无备源；数据省略 |
| `zt_pool` 非交易日无数据（正常行为） | `sentiment/zt_pool` | 周末/节假日 0/N | 非交易日自动回溯最近交易日；如当日数据日期过远仍失败，需要等下个交易日 |
| `financial_health` akshare 子源不稳定 | `fundamentals/akshare`、`fundamentals/akshare_internal` | 间歇性失败（依赖 akshare 财报接口） | 优雅降级到 None；analyst prompt 要求标 `[数据缺失: financial_health]` 哨兵（commit `a8d033b`） |

所有脚本使用 `try/except` 包裹 API 调用，对失败的子源返回 `{"success": true, "data": {...}}` 中对应的空数组。即使个别数据源不可用，分析管道仍会继续运行。`_source-health.json` 让失效可见，可主动诊断（`npm run source-health` 一行命令即可看全局状态）。

## 诊断流程（数据源失效排查）

1. 跑 `npm run source-health -- --failing` 看哪些 source 最近失败
2. 看每个失败 source 的 `last_error` 字段定位原因
3. 对照上面"已知问题"表，找匹配的缓解措施
4. 若是新问题（不在表里），看 `_source-health.json` 完整 history（CLI 加 `--json`）
   - 想看长期趋势（机房 vs 家里环境差异），加 `--period 30d` 或 `--period 1y` 看更长窗口
5. 修复后跑 `trading_quick`，再跑 `source-health` 验证 source `success_rate` 回升
