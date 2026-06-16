# 数据源 API 参考

> 本文档细化到**接口级**：每个数据脚本调用了哪些接口/SDK、参数、返回字段、字段映射、错误处理、已知陷阱。配套文档 [data-sources.zh.md](data-sources.zh.md) 是总览，本文档是详细 API 参考。
>
> **状态**: 进行中 — 当前覆盖 trading-kline，其余 6 个脚本待补。

## 目录

- [trading-kline（K 线 + VPA + 技术指标）](#trading-klinek-线--vpa--技术指标)
- trading-fundamentals（估值 + 财务）— TODO
- trading-news（个股新闻 + 宏观）— TODO
- trading-sentiment（情绪 + 涨停池）— TODO
- trading-policy（政策事件）— TODO
- trading-hot-money（资金流）— TODO
- trading-lockup（解禁 + 减持）— TODO

---

## trading-kline（K 线 + VPA + 技术指标）

> 文件：`skills/trading-kline/scripts/kline.py`（781 行）
>
> 健康追踪子源：`kline/mootdx`、`kline/akshare`

### 调用入口

```bash
# 通过 stdin JSON（orchestrator 默认路径）
echo '{"ticker":"688662","count":120}' | python skills/trading-kline/scripts/kline.py

# 或通过 CLI 参数
python skills/trading-kline/scripts/kline.py --ticker 688662 --count 120
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码（如 `"688662"`、`"600519"`、`"000001"`）
- `count`（int, 可选, 默认 `120`）: 拉取的 K 线根数

**市场识别**（`detect_market()`）:
- 起始 `6`（含主板 6xx + 科创板 688） → 上交所（`market=1`）
- 起始 `0` 或 `3`（主板 + 创业板） → 深交所（`market=0`）
- 其他 → `DataFetchError("Unknown ticker format")`

### 子源 1: `kline/mootdx`（主源）

**协议**: TDX TCP（通达信 7709 端口，**非 HTTP**）

**Python SDK**: `mootdx >= 0.5.7`

**调用签名**（`fetch_from_mootdx()`）:
```python
from mootdx.quotes import Quotes
quotes = Quotes.factory(market=<0|1>, timeout=10)
df = quotes.bars(symbol="<ticker>", category=9, start=0, offset=<count>)
```

**SDK 参数**:
| 参数 | 类型 | 必填 | 取值 / 说明 |
|---|---|---|---|
| `market` | int | 是 | `0` = 深交所、`1` = 上交所（由 `detect_market()` 推断） |
| `timeout` | int | 是 | TCP 连接超时秒数（本脚本固定 `10`） |
| `symbol` | str | 是 | 6 位股票代码（如 `"688662"`），**不带交易所前缀** |
| `category` | int | 是 | K 线周期：`9` = 日线、`5` = 分时、`6` = 分钟、`8` = 1 分钟、`0` = 5 分钟、`1` = 15 分钟、`7` = 30 分钟、`4` = 60 分钟。**本脚本固定用 `9`（日线）** |
| `start` | int | 是 | 起始偏移（`0` = 最新一根） |
| `offset` | int | 是 | 返回条数（用户传 `count`） |

**SDK 返回**（pandas DataFrame，列名英文）:
| 列名 | dtype | 单位 | 说明 |
|---|---|---|---|
| `datetime` | object (str) | — | 格式 `"YYYY-MM-DD HH:MM"`（如 `"2026-06-12 15:00"`）|
| `open` | float64 | 元 | 开盘价 |
| `high` | float64 | 元 | 最高价 |
| `low` | float64 | 元 | 最低价 |
| `close` | float64 | 元 | 收盘价 |
| `vol` | float64 | **手** | 成交量（**TDX 协议单位为"手"，1 手 = 100 股**）|
| `amount` | float64 | 元 | 成交额 |

**字段映射**（kline.py 的 `for _, row in df.iterrows()` 转换）:
| mootdx 列 | output 字段 | 转换 | 备注 |
|---|---|---|---|
| `datetime` | `date` | `str(row.get('datetime', ''))` | 保留完整 "YYYY-MM-DD HH:MM" |
| `open` | `open` | `float(row.get('open', 0))` | |
| `high` | `high` | `float(row.get('high', 0))` | |
| `low` | `low` | `float(row.get('low', 0))` | |
| `close` | `close` | `float(row.get('close', 0))` | |
| `vol` | `volume` | `float(row.get('vol', 0)) * 100` | **× 100（手 → 股）**；commit `e564815` 修复（之前直接传手数导致 LLM 误用 100x 过小值） |
| `amount` | `amount` | `float(row.get('amount', 0))` | |

### 子源 2: `kline/akshare`（备源）

**底层 HTTP**: 新浪财经 `https://finance.sina.com.cn/realstock/company/<symbol>/hisdata/klc_kl.js`（akshare 库封装，调用方不直接接触）

**Python SDK**: `akshare >= 1.15`

**调用签名**（`fetch_from_akshare()`）:
```python
import akshare as ak
df = ak.stock_zh_a_hist(
    symbol="sh600519",          # 带 sh/sz 前缀
    period="daily",
    start_date="19700101",      # 拉全部历史，再用 tail(count) 截取
    adjust="qfq",               # 前复权
)
df = df.tail(count)             # 截取最近 N 根
```

**SDK 参数**:
| 参数 | 类型 | 必填 | 取值 / 说明 |
|---|---|---|---|
| `symbol` | str | 是 | 带前缀的完整代码：上交所 `sh<6位>`、深交所 `sz<6位>`（kline.py 根据 `detect_market()` 自动加前缀） |
| `period` | str | 是 | K 线周期：`"daily"` = 日线、`"weekly"` = 周线、`"monthly"` = 月线。**本脚本固定 `"daily"`** |
| `start_date` | str | 是 | 起始日期 `YYYYMMDD`。本脚本固定 `"19700101"`（拉全部历史），再用 `tail(count)` 截取 |
| `adjust` | str | 是 | 复权：`"qfq"` 前复权（默认）、`"hfq"` 后复权、`""` 不复权。**本脚本固定 `"qfq"`** 保持价格连续性 |

**SDK 返回**（pandas DataFrame，列名**中文**）:
| 列名 | dtype | 单位 | 说明 |
|---|---|---|---|
| `日期` | object (str) | — | 格式 `"YYYY-MM-DD"`（**无时间部分**，与 mootdx 的 "YYYY-MM-DD HH:MM" 不同）|
| `开盘` | float64 | 元 | 开盘价（前复权）|
| `最高` | float64 | 元 | 最高价 |
| `最低` | float64 | 元 | 最低价 |
| `收盘` | float64 | 元 | 收盘价 |
| `成交量` | float64 | **手** | 同 mootdx（TDX 协议）|
| `成交额` | float64 | 元 | 成交额 |

**字段映射**:
| akshare 列 | output 字段 | 转换 |
|---|---|---|
| `日期` | `date` | `str(row.get('日期', ''))` |
| `开盘`/`最高`/`最低`/`收盘` | `open`/`high`/`low`/`close` | `float()` |
| `成交量` | `volume` | `float(row.get('成交量', 0)) * 100`（手 → 股）|
| `成交额` | `amount` | `float(row.get('成交额', 0))` |

### Fallback 逻辑

```python
SOURCES = ["mootdx", "akshare"]  # 顺序即优先级

for source in SOURCES:
    start = time.monotonic()
    try:
        if source == "mootdx":
            data = fetch_from_mootdx(ticker, count)
        elif source == "akshare":
            data = fetch_from_akshare(ticker, count)
        else:
            continue
        record_call(f"kline/{source}", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        # ... 预计算 vpa + technical_indicators（见下）...
        return {"success": True, "data": data, "vpa": ..., "technical_indicators": ..., "_source": source}
    except DataFetchError as e:
        record_call(f"kline/{source}", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        last_error = str(e)
        continue

return {"success": False, "error": str(last_error)}
```

**触发 fallback 的条件**:
- mootdx 抛 `DataFetchError`（包括：未安装、TCP 连接失败、返回空 DataFrame）
- mootdx 超时（`timeout=10` 秒）

### 预计算产物

kline.py 不只返回 raw K 线，还计算两段 markdown 文本注入到 output 顶层字段，避免 LLM 自己算涨跌幅/技术指标出错（commit `55a5d99` 起的标准做法）。

#### `vpa` 字段（string，markdown）

由 `compute_vpa(rows)` 生成，包含：

1. **`### 近期关键行情摘要（预计算，直接引用）`**（commit `55a5d99`）
   - `> 禁止自行计算涨跌幅` 警告
   - 最新收盘价 + 完整日期（如 `150.80 元（2026-06-12）`）
   - 当日涨跌幅（如 `+17.8%`）
   - 近 3 日逐日涨跌幅（旧→新，如 `+20.0% / +14.0% / +17.8%`）
   - 近 5/10/30 日累计涨跌幅（含起止价位）

2. **OBV 趋势（10日）**: `上升` / `下降` / `平稳`

3. **近 5 日量能趋势**: `放量` / `缩量` / `平稳`（含 `5日均量/20日均量 = X.XX`）

4. **逐日量价数据表**（最近 30 根，markdown 表格）:
   - `日期`（commit `55a5d99` 修了 `[-5:]` → `[:10]` 取 "YYYY-MM-DD"，之前误取 "HH:MM"）
   - `类型`（阳线/阴线/十字星）
   - `涨跌幅`（如 `+17.8%`，基于前一日 close 算）
   - `实体大小`（宽/窄/中 + 数值）
   - `收盘位置`（高位/中位/低位 + 0-1 数值）
   - `上影线` / `下影线`（0-1 比例）
   - `量比`（数值 + 标签：巨量>2.0 / 明显放量>1.5 / 温和放量>1.0 / 缩量<0.8 / 极度缩量<0.5）
   - `量价关系`（一致(涨+放量) / 一致(跌+放量) / 背离(涨+缩量) / 背离(跌+缩量) / 中性）

5. **关键量价模式识别**（条件触发）:
   - 健康上涨信号（5日价格上涨 + 成交量配合递增）
   - 顶部背离信号（5日价格上涨但成交量递减）
   - 底部放量信号（5日价格下跌但成交量递增）
   - 卖压衰竭信号（5日价格下跌且成交量递减）

#### `technical_indicators` 字段（string，markdown）

由 `compute_technical_indicators(rows)` 生成，包含：

1. **移动平均线 SMA**: 5/10/20/50/200 日 + 均线排列判定（多头排列 / 空头排列 / 交织排列）
2. **MACD(12,26,9)**: DIF（快线）/ DEA（慢线）/ 柱状图 + 多头/空头运行判定
3. **RSI(14)**: 当前值 + 区域判定（**超买 >70** / **超卖 <30** / 中性 40-60）
4. **KDJ(9,3,3)**: K / D / J 值 + 超买警告（J > 100）/ 超卖警告（J < 0）
5. **布林带(20, 2)**: 上轨 / 中轨 / 下轨 / 当前价格 / 价格位置%（0%=下轨，100%=上轨，>100% 突破上轨）
6. **综合信号汇总表**: 各指标信号方向（看多/看空/中性）+ 强度（强/中/弱）+ 多空统计

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "688662",
    "count": 120,
    "data": [
      {
        "date": "2026-06-12 15:00",
        "open": 138.0,
        "high": 153.6,
        "low": 133.54,
        "close": 150.8,
        "volume": 18237800.0,
        "amount": 2705516544.0
      }
      // ... 共 120 根
    ]
  },
  "vpa": "## VPA 量价预计算指标（基于 20 日均量基准）\n\n### 近期关键行情摘要...",
  "technical_indicators": "## 预计算技术指标\n\n### 移动平均线 (SMA)\n- SMA5: 113.55\n...",
  "_source": "mootdx",
  "_calls": [
    {
      "stage": "kline/mootdx",
      "success": true,
      "error": null,
      "duration_ms": 976
    }
  ]
}
```

**失败时**:
```json
{
  "success": false,
  "error": "mootdx fetch failed: Connection timed out; akshare fetch failed: No module named 'akshare'",
  "_calls": [
    {"stage": "kline/mootdx", "success": false, "error": "Connection timed out", "duration_ms": 10023},
    {"stage": "kline/akshare", "success": false, "error": "No module named 'akshare'", "duration_ms": 5}
  ]
}
```

### 错误处理

| 失败模式 | 触发条件 | 行为 |
|---|---|---|
| mootdx 未安装 | `ImportError` on `from mootdx.quotes import Quotes` | `raise DataFetchError("mootdx not installed")` → fallback akshare |
| mootdx 返回空 | `df is None or df.empty` | `raise DataFetchError("No data returned from mootdx for <ticker>")` → fallback akshare |
| mootdx TCP 超时 | 10 秒内未连接 | 异常被 `except Exception` 捕获 → fallback akshare |
| akshare 未安装 | `ImportError` on `import akshare as ak` | `raise DataFetchError("akshare not installed")` → 无下一源，整体失败 |
| akshare 返回空 | `df is None or df.empty` | `raise DataFetchError("No data returned from akshare for <ticker>")` → 整体失败 |
| 两源都失败 | — | 返回 `{"success": false, "error": "..."}`，`_calls` 记录两次失败 |
| Ticker 格式未知 | 不以 0/3/6 开头 | `raise DataFetchError("Unknown ticker format")`，**不进入 fallback 循环** |

### 已知陷阱（gotchas）

1. **mootdx `vol` 单位是"手"不是"股"**
   - TDX 协议历史包袱，所有 mootdx/akshare 的成交量字段都以"手"为单位
   - kline.py 已统一 `× 100` 转换为"股"（commit `e564815`）
   - 下游消费方（VPA 计算、技术指标、analyst prompt）拿到的 `volume` 字段都是"股"

2. **akshare `日期` 字段无时间部分**
   - 格式 "2026-06-12"（mootdx 是 "2026-06-12 15:00"）
   - 跨源对齐时需注意——VPA 表格用 `[:10]` 取 "YYYY-MM-DD" 统一显示（commit `55a5d99`）

3. **mootdx `category=9` 是日线**
   - 其他值含义：5=分时、6=分钟、8=1分钟、0=5分钟、1=15分钟、7=30分钟、4=60分钟
   - 本脚本固定 `category=9`，调用方不要复用其他值（会破坏 VPA/技术指标计算，因为它们假设日线）

4. **akshare `adjust="qfq"` 前复权**
   - 历史价格会被向下调整（最近一日不变），与真实历史价格不同
   - 涨跌幅计算依然正确（同源内日间比）
   - 跨源对比（mootdx vs akshare）的绝对价格可能不一致——优先用涨跌幅而非绝对价

5. **`market` 推断不区分北交所**
   - 8xx 开头（北交所）会被识别为"Unknown ticker format"
   - 当前不支持北交所股票

6. **`vpa` / `technical_indicators` 是 markdown 字符串而非结构化字段**
   - 设计取舍：LLM 直接读 markdown 比解析 JSON 更可靠
   - 如需程序化消费，得自己 regex 解析（不推荐）——优先用 `data.data[]` 的 raw K 线重算

7. **`_source` 字段标记最终选用的源**
   - 值为 `"mootdx"` 或 `"akshare"`
   - 用于诊断"为什么两条数据的绝对价不一致"（akshare 是 qfq 复权价）

### 健康追踪接入

每次调用 mootdx/akshare 都通过 `record_call` 记录（commit `ba71a48` + `2bf8f45`）：

```python
start = time.monotonic()
try:
    data = fetch_from_xxx(ticker, count)
    record_call(f"kline/{source}", success=True,
                duration_ms=(time.monotonic() - start) * 1000)
    return data
except Exception as e:
    record_call(f"kline/{source}", success=False, error=str(e),
                duration_ms=(time.monotonic() - start) * 1000)
    raise
```

跨 run 健康状态查看：
```bash
npm run source-health -- --json | python -c "import json,sys; d=json.load(sys.stdin); print(d['sources'].get('kline/mootdx', {}).get('stats', {}))"
```

---

## trading-fundamentals（估值 + 财务）— TODO

> 文件：`skills/trading-fundamentals/scripts/fundamentals.py`（517 行）
>
> 子源：`fundamentals/tencent`、`fundamentals/mootdx`、`fundamentals/em_push2`、`fundamentals/em_datacenter`、`fundamentals/em_quarterly`、`fundamentals/em_consensus`、`fundamentals/akshare`

待补：腾讯财经接口、东方财富 push2/datacenter 接口、akshare 三大报表接口、字段映射、`forward_pe`/`peg` 预计算、`financial_health` 派生字段、known issues（push2 限流、akshare 财报接口稳定性）。

## trading-news（个股新闻 + 宏观）— TODO

> 文件：`skills/trading-news/scripts/news.py`（277 行）
>
> 子源：`news/stock_em`、`news/macro_cls`、`news/macro_akshare`

待补：东方财富搜索 API（jsonp 解析）、CLS telegraphList 接口（已失效）、akshare 全球财经快讯接口、`macro_news_source` 字段含义、lookback_days 时间窗、字段映射。

## trading-sentiment（情绪 + 涨停池）— TODO

> 文件：`skills/trading-sentiment/scripts/sentiment.py`（299 行）
>
> 子源：`sentiment/hot_rank`、`sentiment/zt_pool`

待补：东方财富 push2 热门股排行接口、akshare `stock_zt_pool_em` 涨停池接口（含 max_streak/streak_distribution/top_industries/target_in_pool 字段）、非交易日回溯逻辑、关键词情绪评分字典。

## trading-policy（政策事件）— TODO

> 文件：`skills/trading-policy/scripts/policy.py`（208 行）
>
> 子源：`policy/stock_em`、`policy/macro_cls`、`policy/macro_akshare`

待补：东方财富搜索 API、CLS 接口、akshare fallback、字段映射。

## trading-hot-money（资金流）— TODO

> 文件：`skills/trading-hot-money/scripts/hot_money.py`
>
> 子源：`hot_money/northbound`、`hot_money/fund_flow`、`hot_money/hot_stocks`、`hot_money/dragon_tiger`、`hot_money/sector_fund_flow`

待补：东方财富 push2 北向资金接口、push2 clist 资金流接口（fund_flow/sector_fund_flow 共用，受 IP 限流影响最大）、龙虎榜接口、字段映射（main_net/large_net/super_net 等）、`fund_flow=null`/`sector_fund_flow=null` 的语义、push2 IP-ban 缓解策略。

## trading-lockup（解禁 + 减持）— TODO

> 文件：`skills/trading-lockup/scripts/lockup.py`（227 行）
>
> 子源：`lockup/ann_em`、`lockup/reduce_em`

待补：东方财富解禁公告接口（importance 0-3 等级、解禁市值计算）、减持接口、字段映射。

---

## 文档化风格说明（给后续补文档的同学）

每个脚本的文档结构（参考 trading-kline）：

1. **调用入口** + 入参说明
2. **每个子源**（按主备顺序）:
   - 协议（HTTP/TCP/SDK）
   - 调用签名（Python 代码）
   - 参数表（名称/类型/取值）
   - 返回字段表（列名/dtype/单位/说明）
   - 字段映射（SDK/HTTP 字段 → output 字段 + 转换逻辑）
3. **Fallback 逻辑**（伪代码 + 触发条件）
4. **预计算产物**（如果脚本不只返回 raw 数据，如 kline 的 VPA/技术指标、fundamentals 的 forward_pe/peg）
5. **输出 JSON 结构**（完整示例 + 失败时）
6. **错误处理**（失败模式表）
7. **已知陷阱**（gotchas，包括单位/格式/字段名陷阱）
8. **健康追踪接入**（record_call 调用点）

**风格要求**:
- 字段名用反引号（\`vol\`）
- 单位用粗体警告（**手**、**元**）
- 转换逻辑用代码块
- 失败示例必须给真实 JSON
- 已知陷阱必须给具体 commit 引用（如 commit \`e564815\`）
