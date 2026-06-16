# 数据源 API 参考

> 本文档细化到**接口级**：每个数据脚本调用了哪些接口/SDK、参数、返回字段、字段映射、错误处理、已知陷阱。配套文档 [data-sources.zh.md](data-sources.zh.md) 是总览，本文档是详细 API 参考。
>
> **状态**: 覆盖全部 7 个数据脚本。

## 目录

- [trading-kline（K 线 + VPA + 技术指标）](#trading-klinek-线--vpa--技术指标)
- [trading-fundamentals（估值 + 财务）](#trading-fundamentals估值--财务) — 7 子源：腾讯估值/mootdx 财报/em 基础信息/em 季度趋势/em 机构预期/akshare 三大报表
- [trading-news（个股新闻 + 宏观）](#trading-news个股新闻--宏观) — 3 子源：东方财富个股搜索/CLS 宏观/akshare 宏观兜底
- [trading-sentiment（情绪 + 涨停池）](#trading-sentiment情绪--涨停池) — 2 子源：东方财富热门排行/akshare 涨停池
- [trading-policy（政策事件）](#trading-policy政策事件) — 3 子源：东方财富个股搜索/CLS 宏观/akshare 宏观兜底
- [trading-hot-money（资金流）](#trading-hot-money资金流) — 5 子源：同花顺北向/push2 个股资金流/同花顺热门/东财龙虎榜/push2 板块资金流
- [trading-lockup（解禁 + 减持）](#trading-lockup解禁--减持) — 2 子源：东财公告 API/东财减持查询（另含 datacenter 解禁 + mootdx F10）

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

#### 真实输出示例（688662，2026-06-16）

`vpa` 字段（截取前 ~1500 字符）:

```
## VPA 量价预计算指标（基于 20 日均量基准）

### 近期关键行情摘要（预计算，直接引用）

> **禁止自行计算涨跌幅** —— 以下数值已由系统基于完整 K 线预计算，直接引用即可。
> 从 raw K 线自行计算极易出错（前收盘基准 / 累计口径 / 日期对齐不一致）。
- **最新收盘价**: 134.76 元（2026-06-16）
- **当日涨跌幅**: +15.3%
- **近3日逐日涨跌幅（旧→新）**: +17.8% / -22.5% / +15.3%
- **近5日累计涨跌幅**: +44.1%（从 93.53 元至 134.76 元）
- **近10日累计涨跌幅**: +51.0%（从 89.25 元至 134.76 元）
- **近30日累计涨跌幅**: +91.8%（从 70.25 元至 134.76 元）

**OBV 趋势（10日）**: 上升
**近5日量能趋势**: 放量（5日均量/20日均量 = 1.76）

### 逐日量价数据

| 日期 | 类型 | 涨跌幅 | 实体大小 | 收盘位置 | 上影线 | 下影线 | 量比 | 量价关系 |
|------|------|--------|----------|----------|--------|--------|------|----------|
| 2026-05-06 | 阴线 | -3.1% | 宽(0.059) | 低位(0.08) | 0.07 | 0.08 | 1.1(温和放量) | 一致(跌+放量) |
| 2026-05-07 | 阳线 | +10.8% | 宽(0.138) | 高位(0.81) | 0.19 | 0.12 | 1.4(温和放量) | 一致(涨+放量) |
...
```

`technical_indicators` 字段（截取前 ~1200 字符）:

```
## 预计算技术指标

### 移动平均线 (SMA)
- SMA5: 128.53
- SMA10: 108.81
- SMA20: 100.91
- SMA50: 82.85
- SMA200: 数据不足
- **均线排列**: 多头排列（价格 134.76 在所有短期均线之上）

### MACD (12, 26, 9)
- DIF (快线): 12.6201
- DEA (慢线): 8.7378
- MACD 柱状图: 7.7645
- MACD 多头运行（DIF > DEA，柱状图为正）

### RSI (14)
- RSI: 61.98
- 偏强区域 (60-70)：多头占优

### KDJ (9, 3, 3)
- K: 69.89
- D: 64.68
- J: 80.32

### 布林带 (20, 2)
- 上轨: 136.75
- 中轨: 100.91
- 下轨: 65.06
- 当前价格: 134.76
- 价格位置: 97.2%（0%=下轨，100%=上轨）
- **接近上轨**：短期超买，可能回调

### 综合信号汇总
| 指标 | 数值 | 信号方向 | 信号强度 |
|------|------|----------|----------|
| SMA 排列 | 价=134.76 | 看多 | 强 |
| MACD | DIF=12.620 | 看多 | 强 |
| RSI(14) | 62.0 | 看多 | 中 |
| KDJ | K=69.9 D=64.7 | 看多 | 中 |
| Bollinger | 位=97% | 看空 | 强 |

**多头信号**: 4 | **空头信号**: 1 | **中性**: 0
```

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


### 已知陷阱

1. **mootdx/akshare `vol` 单位是"手"**：脚本已 `× 100` 转"股"（commit `e564815`）
2. **akshare `日期` 无时间部分**："2026-06-12" vs mootdx "2026-06-12 15:00"，跨源对齐注意（commit `55a5d99` 修了 VPA 表格显示）
3. **`category=9` 是日线**：其他值含义不同，本脚本固定日线
4. **`adjust="qfq"` 前复权**：历史价格会被调整，跨源对比优先用涨跌幅
5. **不支持北交所**：8xx 开头会被识别为"Unknown ticker format"
6. **`vpa`/`technical_indicators` 是 markdown 字符串**：非结构化字段，程序消费需 regex
7. **`_source` 标记最终选用的源**：诊断价格差异时先看这个字段

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

## trading-fundamentals（估值 + 财务）

> 文件：`skills/trading-fundamentals/scripts/fundamentals.py`（517 行）
>
> 健康追踪子源：`fundamentals/tencent`、`fundamentals/mootdx`、`fundamentals/em_push2`、`fundamentals/em_datacenter`、`fundamentals/em_quarterly`、`fundamentals/em_consensus`、`fundamentals/akshare`

### 调用入口

```bash
python skills/trading-fundamentals/scripts/fundamentals.py --ticker 600519 --date 2026-06-14
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码（`normalize_ticker` 会剥离 `.SH`/`.SZ` 前缀）
- `date`（string, 必填）: 分析日期 `YYYY-MM-DD`（仅用于标记，不参与接口查询）

### 子源 1: `fundamentals/tencent`（实时估值，主源）

**协议**: HTTP（腾讯财经 `qt.gtimg.cn`）

**调用签名**（`tencent_quote` from `http_helpers.py`）:
```python
from http_helpers import tencent_quote
result = tencent_quote(["600519"])
# 底层: GET https://qt.gtimg.cn/q=sh600519
# 编码: GBK（腾讯特殊，非 UTF-8）
```

**HTTP 参数**:
| 参数 | 取值 | 说明 |
|---|---|---|
| URL | `https://qt.gtimg.cn/q=<prefix><code>` | 批量用逗号分隔（如 `sh600519,sz000001`） |
| prefix | `sh`/`sz`/`bj` | 6/9→sh、8→bj、其他→sz |

**返回字段**（`~` 分隔数组，取关键索引）:
| 索引 | http_helpers 字段 | output 字段 | 单位 | 说明 |
|---|---|---|---|---|
| `vals[1]` | `name` | `valuation.name` | — | 股票名称 |
| `vals[3]` | `price` | `valuation.price` | **元** | 当前/最新价 |
| `vals[32]` | `change_pct` | `valuation.change_pct` | % | 涨跌幅 |
| `vals[38]` | `turnover_pct` | `valuation.turnover_pct` | % | 换手率 |
| `vals[39]` | `pe_ttm` | `valuation.pe_ttm` | — | 市盈率(TTM) |
| `vals[44]` | `mcap_yi` | `valuation.market_cap_yi` | **亿元** | 总市值 |
| `vals[45]` | `float_mcap_yi` | `valuation.float_market_cap_yi` | **亿元** | 流通市值 |
| `vals[46]` | `pb` | `valuation.pb` | — | 市净率 |
| `vals[52]` | `pe_static` | `valuation.pe_static` | — | 静态市盈率 |

**字段映射**（`fetch_fundamentals` 第 1 段）:
```python
data["valuation"] = {
    "name": q["name"], "price": q["price"],
    "pe_ttm": q["pe_ttm"], "pe_static": q["pe_static"],
    "pb": q["pb"], "market_cap_yi": q["mcap_yi"],
    "float_market_cap_yi": q["float_mcap_yi"],
    "turnover_pct": q["turnover_pct"], "change_pct": q["change_pct"],
}
```

### 子源 2: `fundamentals/mootdx`（财务快照，TDX TCP）

**协议**: TDX TCP（同 kline，通达信 7709 端口）

**Python SDK**: `mootdx >= 0.5.7`

**调用签名**:
```python
from mootdx.quotes import Quotes
client = Quotes.factory(market=<0|1>, timeout=10)
fin = client.finance(symbol="600519")  # F10 财务快照
row = fin.iloc[0]
```

**返回字段**（pandas Series，中文拼音字段名）:
| mootdx 字段 | output 字段 | 单位 | 说明 |
|---|---|---|---|
| `liutongguben` | `float_shares` | 股 | 流通股本 |
| `zongguben` | `total_shares` | 股 | 总股本 |
| `jingzichan` | `net_assets` | **元** | 净资产 |
| `zhuyingshouru` | `revenue` | **元** | 主营收入 |
| `jinglirun` | `net_profit` | **元** | 净利润 |
| `meigujingzichan` | `bvps` | **元** | 每股净资产 |
| `weifenpeilirun` | `undistributed_profit` | **元** | 未分配利润 |
| `zongzichan` | `total_assets` | **元** | 总资产 |
| `gudongrenshu` | `shareholder_count` | — | 股东人数 |
| `jingyingxianjinliu` | `operating_cash_flow` | **元** | 经营现金流 |
| `zichanfuzhailv` | `debt_ratio` | % | 资产负债率 |
| `xishoumaoliv` | `gross_margin` | % | 销售毛利率 |

**派生字段**:
```python
# ROE 计算（当 net_profit 和 net_assets 都存在）
snapshot["roe"] = round(net_profit / net_assets * 100, 2)
```

### 子源 3: `fundamentals/em_push2`（股票基本信息，主源）

**协议**: HTTP（东方财富 push2）

**调用签名**:
```python
url = "https://push2.eastmoney.com/api/qt/stock/get"
params = {
    "fltt": "2", "invt": "2",
    "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43",
    "secid": f"{market_code}.{code}",  # e.g. "1.600519"
}
r = em_get(url, params=params, timeout=10)
```

**参数说明**:
| 参数 | 取值 | 说明 |
|---|---|---|
| `secid` | `<market>.<code>` | `market`: 1=沪、0=深 |
| `fields` | `f57,f58,f84,...` | 逗号分隔的字段代码 |
| `fltt` | `2` | 价格精度（2 = 不除以 100） |

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `f127` | `stock_info.industry` | 行业板块 |
| `f58` | `stock_info.name` | 股票名称 |
| `f84` | `stock_info.total_shares` | 总股本 |
| `f85` | `stock_info.float_shares` | 流通股本 |
| `f116` | `stock_info.total_mv` | 总市值 |

### 子源 4: `fundamentals/em_datacenter`（datacenter 兜底，备源）

**触发条件**: push2 失败或未返回 `industry` 字段时自动触发。

**协议**: HTTP（`datacenter-web.eastmoney.com`，**不受 push2 IP 限流影响**，commit `d0a36f7`）

**调用签名**:
```python
url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
params = {
    "reportName": "RPT_LICO_FN_CPD",
    "columns": "SECURITY_NAME_ABBR,BOARD_NAME,TRADE_MARKET",
    "filter": '(SECURITY_CODE="600519")',
    "pageSize": "1",
}
r = em_get(url, params=params, timeout=10)
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `BOARD_NAME` | `stock_info.industry` | 行业板块 |
| `SECURITY_NAME_ABBR` | `stock_info.name` | 股票简称 |

### 子源 5: `fundamentals/em_quarterly`（季度财务趋势）

**协议**: HTTP（东方财富 datacenter）

**调用签名**（`_fetch_quarterly_financials`）:
```python
url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
params = {
    "reportName": "RPT_LICO_FN_CPD",
    "columns": "ALL",
    "filter": '(SECURITY_CODE="600519")',
    "pageNumber": "1", "pageSize": "5",
    "sortColumns": "REPORTDATE",  # 注意: REPORTDATE 不是 REPORT_DATE
    "sortTypes": "-1",
    "source": "WEB", "client": "WEB",
}
r = em_get(url, params=params, timeout=15)
```

**返回字段映射**（取前 4 条，金额从元 → 亿元）:
| HTTP 字段 | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `REPORTDATE` | `report_date` | `[:10]` | 截取 YYYY-MM-DD |
| `TOTAL_OPERATE_INCOME` | `revenue_yi` | `/ 1e8` → **亿元** | 营业总收入 |
| `PARENT_NETPROFIT` | `net_profit_yi` | `/ 1e8` → **亿元** | 归母净利润 |
| `BASIC_EPS` | `eps` | `float()` | 基本每股收益 |
| `YSTZ` | `revenue_yoy` | — | 营收同比 (%) |
| `SJLTZ` | `net_profit_yoy` | — | 净利润同比 (%) |
| `WEIGHTAVG_ROE` | `roe` | — | 加权平均 ROE (%) |
| `XSMLL` | `gross_margin` | — | 销售毛利率 (%) |

### 子源 6: `fundamentals/em_consensus`（机构一致预期）

**协议**: HTTP（东方财富 datacenter）

**调用签名**（`_fetch_consensus_eps`）:
```python
url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
params = {
    "reportName": "RPT_WEB_RESPREDICT",
    "columns": "ALL",
    "filter": '(SECURITY_CODE="600519")',
    "pageNumber": "1", "pageSize": "5",
    "source": "WEB", "client": "WEB",
    # 注意: 无 sortColumns（此报表无 REPORTDATE 列）
}
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `EPS1`-`EPS4` | `forecast_years[].eps` | 4 年 EPS 预测（YEAR1=最近） |
| `YEAR1`-`YEAR4` | `forecast_years[].year` | 年份 |
| `YEAR_MARK1`-`4` | `forecast_years[].type` | `"A"`=实际 / `"E"`=预测 |
| `RATING_ORG_NUM` | `analyst_count` | 覆盖机构数 |
| `RATING_BUY_NUM` | `ratings.buy` | 买入评级数 |
| `RATING_ADD_NUM` | `ratings.overweight` | 增持评级数 |
| `RATING_NEUTRAL_NUM` | `ratings.neutral` | 中性评级数 |
| `RATING_REDUCE_NUM` | `ratings.underweight` | 减持评级数 |
| `RATING_SALE_NUM` | `ratings.sell` | 卖出评级数 |
| `DEC_AIMPRICEMIN` | `target_price_min` | 目标价下限 |
| `DEC_AIMPRICEMAX` | `target_price_max` | 目标价上限 |

**派生字段**（函数内计算）:
```python
consensus_eps_current = forecast_years[0]["eps"]
consensus_eps_next = forecast_years[1]["eps"]
eps_growth_pct = (next - current) / current * 100  # 仅当 current > 0
```

### 子源 7: `fundamentals/akshare`（三大报表派生 financial_health）

**协议**: HTTP（新浪财经，通过 akshare SDK）

**Python SDK**: `akshare >= 1.15`

**调用签名**（`_fetch_financial_health`）:
```python
import akshare as ak
# 三大报表（sina 数据源）
df_bs = ak.stock_financial_report_sina(stock="sh600519", symbol="资产负债表")
df_cf = ak.stock_financial_report_sina(stock="sh600519", symbol="现金流量表")
df_is = ak.stock_financial_report_sina(stock="sh600519", symbol="利润表")
```

**提取的原始列**:
| 报表 | 列名 | output 字段 |
|---|---|---|
| 资产负债表 | `商誉` | `goodwill_yi`（/ 1e8 → **亿元**） |
| 资产负债表 | `归属于母公司股东权益合计` | `goodwill_to_equity_pct` 分母 |
| 资产负债表 | `资产总计` / `负债合计` | `debt_ratio_pct` |
| 资产负债表 | `流动资产合计` / `流动负债合计` / `存货` | `current_ratio` / `quick_ratio` |
| 现金流量表 | `经营活动产生的现金流量净额` | `ocf_yi`（/ 1e8 → **亿元**） |
| 现金流量表 | `购建固定资产、无形资产和其他长期资产所支付的现金` | `capex_yi` |
| 利润表 | `归属于母公司所有者的净利润` | `net_profit_parent_yi` |

### 预计算产物

#### `forward_pe` / `peg`（commit `12f135e`）

在所有子源完成后，由 `valuation` + `consensus_eps` 派生：
```python
# forward_pe: 当前价格 / 下一年 EPS
if price and eps_next and eps_next > 0:
    consensus["forward_pe"] = round(price / eps_next, 2)

# PEG: TTM 市盈率 / EPS 增长率（仅正增长时计算）
if pe_ttm and growth and growth > 0:
    consensus["peg"] = round(pe_ttm / growth, 2)
```
写入 `consensus_eps` 字段内（不单独开 key）。

#### `financial_health`（commit `52085fd`）

由 `_derive_financial_health` 纯函数计算（与网络抓取分离，可单测），取三表共有报告期的最近 4 期：
```python
{
    "periods": [
        {
            "date": "2025-12-31", "period_type": "FY",
            "goodwill_yi": 12.3, "goodwill_to_equity_pct": 8.5,
            "debt_ratio_pct": 45.2, "current_ratio": 1.8, "quick_ratio": 1.5,
            "ocf_yi": 30.1, "capex_yi": 5.2, "fcf_yi": 24.9,
            "net_profit_parent_yi": 15.3, "ocf_to_ni_ratio": 1.97,
        },
        # ... 最近 4 期
    ],
    "latest": { ... },  # = periods[0]
    "goodwill_impairment_risk": false,  # goodwill_to_equity_pct > 30 → true
    "ocf_quality": "good",              # ocf_to_ni_ratio >= 1 → good / >= 0.5 → ok / else weak
    "notes": [
        "扣非净利润: sina 利润表未提供，无法计算扣非/归母比",
        "OCF/净利/资本开支为累计值，跨期比较须注意期间长度 (period_type)",
    ],
}
```

#### 真实输出示例（688662 富信科技，2026-06-14）

`financial_health` 字段（`consensus_eps` 为 null 时无 `forward_pe`/`peg` 派生）:

```json
{
  "periods": [
    {
      "date": "2026-03-31", "period_type": "Q1",
      "goodwill_yi": null, "goodwill_to_equity_pct": null,
      "debt_ratio_pct": 23.62, "current_ratio": 2.14, "quick_ratio": 1.32,
      "ocf_yi": -0.05, "capex_yi": 0.29, "fcf_yi": -0.34,
      "net_profit_parent_yi": 0.07, "ocf_to_ni_ratio": -0.66
    },
    {
      "date": "2025-12-31", "period_type": "FY",
      "debt_ratio_pct": 20.67, "current_ratio": 2.6, "quick_ratio": 1.76,
      "ocf_yi": 0.71, "capex_yi": 0.98, "fcf_yi": -0.27,
      "net_profit_parent_yi": 0.39, "ocf_to_ni_ratio": 1.79
    }
  ],
  "latest": { "date": "2026-03-31", "debt_ratio_pct": 23.62, "ocf_quality": "weak" },
  "goodwill_impairment_risk": false,
  "ocf_quality": "weak",
  "notes": ["扣非净利润: sina 利润表未提供，无法计算扣非/归母比"]
}
```

### Fallback 逻辑

fundamentals 的 7 个子源**不是线性 fallback 链**，而是**并行采集 + 各自独立容错**:

```python
# 每个子源 try/except 独立，失败写入 <key>_error 字段，不影响其他子源
try:
    data["valuation"] = ...        # tencent
except Exception as e:
    data["valuation_error"] = str(e)

try:
    data["financial_snapshot"] = ...  # mootdx
except Exception as e:
    data["financial_snapshot_error"] = str(e)

# push2 → datacenter 是唯一的二级 fallback（仅 industry 字段）
if not info.get("industry"):
    # 尝试 datacenter
    ...
```

**唯一的 fallback 链**: `em_push2` → `em_datacenter`（仅当 push2 未返回 industry 时）。

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-14",
    "valuation": {
      "name": "贵州茅台", "price": 1508.0,
      "pe_ttm": 20.5, "pe_static": 21.3, "pb": 7.8,
      "market_cap_yi": 18920.0, "float_market_cap_yi": 18920.0,
      "turnover_pct": 0.3, "change_pct": -0.5
    },
    "financial_snapshot": {
      "float_shares": 1256250000.0, "total_shares": 1256250000.0,
      "net_assets": 246000000000.0, "revenue": 150000000000.0,
      "net_profit": 70000000000.0, "roe": 28.46,
      "bvps": 195.8, "debt_ratio": 22.9, "gross_margin": 91.5
    },
    "stock_info": {"industry": "白酒", "name": "贵州茅台"},
    "quarterly_trends": [
      {"report_date": "2025-12-31", "revenue_yi": 150.0, "net_profit_yi": 70.0,
       "eps": 55.7, "revenue_yoy": 10.0, "net_profit_yoy": 12.0, "roe": 28.5}
    ],
    "consensus_eps": {
      "forecast_years": [
        {"year": 2025, "type": "E", "eps": 60.5},
        {"year": 2026, "type": "E", "eps": 68.0}
      ],
      "consensus_eps_current": 60.5, "consensus_eps_next": 68.0,
      "eps_growth_pct": 12.4,
      "analyst_count": 35,
      "ratings": {"buy": 20, "overweight": 10, "neutral": 5, "underweight": 0, "sell": 0},
      "target_price_min": 1600.0, "target_price_max": 2000.0,
      "forward_pe": 22.18, "peg": 1.65
    },
    "financial_health": {
      "periods": [...],
      "latest": {...},
      "goodwill_impairment_risk": false,
      "ocf_quality": "good",
      "notes": [...]
    }
  },
  "source": "tencent+mootdx+eastmoney+akshare",
  "_calls": [
    {"stage": "fundamentals/tencent", "success": true, "error": null, "duration_ms": 320},
    {"stage": "fundamentals/mootdx", "success": true, "error": null, "duration_ms": 850},
    {"stage": "fundamentals/em_push2", "success": true, "error": null, "duration_ms": 1100},
    {"stage": "fundamentals/em_quarterly", "success": true, "error": null, "duration_ms": 950},
    {"stage": "fundamentals/em_consensus", "success": true, "error": null, "duration_ms": 880},
    {"stage": "fundamentals/akshare", "success": true, "error": null, "duration_ms": 3200}
  ]
}
```

**部分失败时**（push2 限流 + datacenter 兜底成功）:
```json
{
  "success": true,
  "data": {
    "stock_info": {"industry": "白酒", "name": "贵州茅台"},
    "stock_info_push2_error": "ConnectionError: ...",
    "_calls": [
      {"stage": "fundamentals/em_push2", "success": false, "error": "ConnectionError", "duration_ms": 10001},
      {"stage": "fundamentals/em_datacenter", "success": true, "error": null, "duration_ms": 600}
    ]
  }
}
```


### 已知陷阱

1. **datacenter `sortColumns` 大小写敏感**：`REPORTDATE` 不是 `REPORT_DATE`，错写返回 null 无报错（commit `12f135e`）
2. **datacenter `"result": null` 显式 null**：`d.get("result", {})` 在 null 时返回 None，须用 `(d.get("result") or {})` 防御（commit `12f135e`）
3. **push2 IPv6 连接重置**：`http_helpers.py` 全局强制 IPv4（commit `6fdfc01`）
4. **push2 IP 限流 per-subdomain**：push2 限流时 datacenter 正常，datacenter 是可靠兜底（commit `d0a36f7`）
5. **PEG 仅正增长时计算**：`eps_growth_pct <= 0` 时 `peg` 字段不存在
6. **`forward_pe` 依赖两个子源**：需 `valuation.price` + `consensus_eps_next` 都成功
7. **akshare 财报 NaN 值**：sina 缺失值用 NaN，`math.isfinite()` 过滤为 None 避免非法 JSON
8. **akshare `扣非净利润` 不可得**：sina 利润表不暴露，`financial_health.notes` 标注此限制
9. **OCF/净利/资本开支为累计值**：季报跨期比较需注意 `period_type`（Q1/H1/Q3/FY）

### 健康追踪接入

每个子源的 try/except 块都调用 `record_call`（commit `72dc718`）:
```python
start = time.monotonic()
try:
    tq = tencent_quote([code])
    # ... 处理 ...
    record_call("fundamentals/tencent", success=True,
                duration_ms=(time.monotonic() - start) * 1000)
except Exception as e:
    record_call("fundamentals/tencent", success=False, error=str(e),
                duration_ms=(time.monotonic() - start) * 1000)
```

7 个 stage：`fundamentals/tencent`、`fundamentals/mootdx`、`fundamentals/em_push2`、`fundamentals/em_datacenter`、`fundamentals/em_quarterly`、`fundamentals/em_consensus`、`fundamentals/akshare`。

## trading-news（个股新闻 + 宏观）

> 文件：`skills/trading-news/scripts/news.py`（277 行）
>
> 健康追踪子源：`news/stock_em`、`news/macro_cls`、`news/macro_akshare`

### 调用入口

```bash
python skills/trading-news/scripts/news.py --ticker 600519 --date 2026-06-14 --lookback-days 7
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码
- `date`（string, 必填）: 分析日期 `YYYY-MM-DD`（用于时间分层 cutoff）
- `lookback-days`（int, 可选, 默认 `7`）: 历史层回看天数（policy 角色传 14）

### 子源 1: `news/stock_em`（个股新闻，主源）

**协议**: HTTP（东方财富搜索 API，JSONP 封装）

**调用签名**（`_fetch_news_eastmoney`）:
```python
url = "https://search-api-web.eastmoney.com/search/jsonp"
inner_param = {
    "uid": "", "keyword": "600519",
    "type": ["cmsArticleWebOld"],
    "client": "web", "clientType": "web", "clientVersion": "curr",
    "param": {
        "cmsArticleWebOld": {
            "searchScope": "default", "sort": "default",
            "pageIndex": 1, "pageSize": 50,
            "preTag": "", "postTag": "",
        }
    },
}
params = {
    "cb": "callback",
    "param": json.dumps(inner_param, ensure_ascii=False),
    "_": "1",
}
headers = {"Referer": "https://so.eastmoney.com/", "User-Agent": _UA}
resp = em_get(url, params=params, headers=headers, timeout=15)
```

**JSONP 解析**（关键步骤）:
```python
text = resp.text
text = text[text.index("(") + 1: text.rindex(")")]  # 剥离 callback(...)
data = json.loads(text)
```

**返回字段映射**:
| HTTP 字段（`result.cmsArticleWebOld[]`） | output 字段 | 说明 |
|---|---|---|
| `title` | `title` | 文章标题（可能含 HTML 高亮标签） |
| `content` | `content` | 截取前 300 字符 |
| `date` | `time` | 发布时间 |
| `mediaName` | `source` | 来源媒体（默认"东方财富"） |

### 子源 2: `news/macro_cls`（宏观新闻，主源）

**协议**: HTTP（财联社 `cls.cn`）

**调用签名**（`_fetch_global_news_cls`）:
```python
import requests
url = "https://www.cls.cn/nodeapi/telegraphList"
params = {"rn": "10", "page": "1"}
headers = {"User-Agent": _UA, "Referer": "https://www.cls.cn/"}
r = http_get(url, params=params, headers=headers, timeout=10)
```

**返回字段映射**:
| HTTP 字段（`data.roll_data[]`） | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `title` 或 `brief` | `title` | `title or brief` | 标题（无标题时用摘要） |
| `content` 或 `brief` | `content` | `[:300]` | 正文截取 |
| `ctime` | `time` | `fromtimestamp()` → `YYYY-MM-DD HH:MM` | Unix 时间戳转可读 |

### 子源 3: `news/macro_akshare`（宏观新闻，备源）

**触发条件**: CLS 失败或返回空列表时自动触发。

**协议**: HTTP（东方财富全球财经快讯，通过 akshare SDK）

**调用签名**（`_fetch_global_news_akshare`）:
```python
import akshare as ak
df = ak.stock_info_global_em()
# 返回 DataFrame: 标题/摘要/发布时间/链接
```

**返回字段映射**:
| akshare 列 | output 字段 | 说明 |
|---|---|---|
| `标题` | `title` | 文章标题 |
| `摘要` | `content` | 截取前 300 字 |
| `发布时间` | `time` | 截取前 16 字符（`YYYY-MM-DD HH:MM`） |

### Fallback 逻辑（宏观新闻）

```python
# 宏观新闻：CLS 优先 → akshare 兜底
macro_source = "none"
macro_articles = []
try:
    macro_articles = _fetch_global_news_cls()
    if macro_articles:
        macro_source = "cls"
except Exception as e:
    data["macro_news_error"] = str(e)  # 记录失败原因（可观测性）

if not macro_articles:
    try:
        macro_articles = _fetch_global_news_akshare()
        if macro_articles:
            macro_source = "akshare"
    except Exception as e:
        data["macro_news_error"] = f"{existing}; akshare: {e}"

data["macro_news"] = macro_articles
data["macro_news_source"] = macro_source  # "cls" / "akshare" / "none"
```

**触发条件**: CLS 抛任何异常（网络/超时/JSON 解析失败）或返回空列表。

### 预计算产物

#### 时间分层分类（`_categorize_news`）

个股新闻按发布时间分为三层:
```python
layers = {
    "realtime_6h": [],      # 最近 6 小时
    "extended_24h": [],     # 6-24 小时
    "history_7d": [],       # 1-7 天（= lookback_days）
}
```

- `realtime_6h` / `extended_24h` 的 cutoff 固定（6h / 24h）
- `history_7d` 的 cutoff = `lookback_days` 参数（默认 7，policy 传 14）
- 无法解析时间的文章归入 `history_7d`
- 输出 `layer_stats`: 各层计数 + `total_categorized`

**时间解析**（`_parse_news_time`）支持 4 种格式:
- `%Y-%m-%d %H:%M:%S`
- `%Y-%m-%d %H:%M`
- `%Y-%m-%dT%H:%M:%S`
- `%Y年%m月%d日 %H:%M`

#### 真实输出示例（688662 富信科技，2026-06-14）

时间分层分类 + layer_stats（活跃交易期，有大量新闻）:

```json
{
  "lookback_days": 7,
  "news_layers": {
    "realtime_6h": [
      {"title": "富信科技(688662)交易异常波动(06-16)", "time": "2026-06-16 17:10:19", "source": "东方财富Choice数据"},
      {"title": "半导体板块再度爆发，科创50指数续创年内新高", "time": "2026-06-16 15:15:00", "source": "财联社"}
    ],
    "extended_24h": [
      {"title": "牛市旗手富信科技年内涨幅近200%...", "time": "2026-06-14 17:59:00", "source": "21世纪经济报道"}
    ],
    "history_7d": [
      {"title": "富信科技(688662)交易异常波动(06-12)", "time": "2026-06-12 17:47:58", "source": "东方财富Choice数据"},
      {"title": "20CM涨停富信科技现身机构调研计划...", "time": "2026-06-10 19:06:28", "source": "东方财富"}
    ]
  },
  "layer_stats": {
    "realtime_6h_count": 11, "extended_24h_count": 1,
    "history_7d_count": 28, "total_categorized": 40
  },
  "macro_news_source": "akshare"
}
```

> 注：该 ticker 在 2026-06-14 原始报告中所有层为空（非交易日前后跑的），上方示例来自 fresh run。

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "600519", "date": "2026-06-14", "lookback_days": 7,
    "stock_news": [
      {"title": "茅台发布2025年年报", "content": "...", "time": "2026-06-14 10:30", "source": "东方财富"}
    ],
    "news_layers": {
      "realtime_6h": [...],
      "extended_24h": [...],
      "history_7d": [...]
    },
    "layer_stats": {
      "realtime_6h_count": 2, "extended_24h_count": 5,
      "history_7d_count": 15, "total_categorized": 22
    },
    "macro_news": [
      {"title": "央行降准0.5个百分点", "content": "...", "time": "2026-06-14 09:15", "source": "财联社"}
    ],
    "macro_news_source": "cls"
  },
  "source": "eastmoney+cls",
  "_calls": [
    {"stage": "news/stock_em", "success": true, "error": null, "duration_ms": 800},
    {"stage": "news/macro_cls", "success": true, "error": null, "duration_ms": 500}
  ]
}
```

**CLS 失败 + akshare 兜底时**:
```json
{
  "success": true,
  "data": {
    "macro_news": [...],
    "macro_news_source": "akshare",
    "macro_news_error": "CLS macro news unavailable: ConnectionError: ..."
  },
  "source": "eastmoney+akshare",
  "_calls": [
    {"stage": "news/stock_em", "success": true, "error": null, "duration_ms": 800},
    {"stage": "news/macro_cls", "success": false, "error": "ConnectionError: ...", "duration_ms": 10001},
    {"stage": "news/macro_akshare", "success": true, "error": null, "duration_ms": 1500}
  ]
}
```


### 已知陷阱

1. **CLS telegraphList 接口不稳定**：曾连续多天 ConnectionError，旧代码 `bare except: pass` 吞错（commit `10017ee`），现 `raise` + `macro_news_error` 字段 + akshare 兜底
2. **`macro_news_source` 追踪实际源**：`"cls"` / `"akshare"` / `"none"`（都挂了需人工排查）
3. **JSONP 解析依赖 `(` `)` 字符**：东方财富改版可能破坏，异常被捕获返回空列表
4. **`content` 截取 300 字符**：下游 LLM 看到的是截断版本
5. **时间分层 cutoff 基于 `date` 参数**：周末/假日运行时 realtime_6h 可能为空
6. **lookback_days 影响 history 层范围**：默认 7 天，policy 传 14 天；realtime/extended 不受影响

### 健康追踪接入

3 个 stage 的 `record_call` 模式统一（commit `5db1308`）:
```python
start = time.monotonic()
try:
    articles = _fetch_news_eastmoney(code)
    record_call("news/stock_em", success=True,
                duration_ms=(time.monotonic() - start) * 1000)
    return articles
except Exception as e:
    record_call("news/stock_em", success=False, error=str(e),
                duration_ms=(time.monotonic() - start) * 1000)
    return []
```

CLS 子源特殊：失败时 `raise` 而非 `return []`（让上层 fallback 逻辑接管），但 `record_call` 仍在 `_fetch_global_news_cls` 内部先记录失败再 raise。

## trading-sentiment（情绪 + 涨停池）

> 文件：`skills/trading-sentiment/scripts/sentiment.py`（299 行）
>
> 健康追踪子源：`sentiment/hot_rank`、`sentiment/zt_pool`

### 调用入口

```bash
python skills/trading-sentiment/scripts/sentiment.py --ticker 600519 --date 2026-06-14
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码
- `date`（string, 必填）: 分析日期 `YYYY-MM-DD`（zt_pool 用于回溯查找最近交易日）

### 子源 1: `sentiment/hot_rank`（热门股排行）

**协议**: HTTP（东方财富 push2 `clist` 接口）

**调用签名**（`_fetch_hot_rank`）:
```python
url = "https://push2.eastmoney.com/api/qt/clist/get"
params = {
    "pn": "1", "pz": "20", "po": "1", "np": "1",
    "fltt": "2", "invt": "2",
    "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
    "fields": "f2,f3,f4,f12,f14,f104,f105,f127",
}
r = em_get(url, params=params, timeout=10)
```

**参数说明**:
| 参数 | 取值 | 说明 |
|---|---|---|
| `fs` | `m:0+t:6,m:0+t:80,...` | 市场筛选器（沪深 A 股全市场） |
| `pz` | `20` | 返回条数（取 top 20） |
| `po` | `1` | 降序 |
| `fields` | `f2,f3,f4,f12,f14,...` | 字段代码 |

**返回字段映射**（`data.diff[]`）:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `f12` | `code` | 股票代码 |
| `f14` | `name` | 股票名称 |
| `f3` | `change_pct` | 涨跌幅 (%) |
| `f2` | `price` | 当前价 |

### 子源 2: `sentiment/zt_pool`（涨停板情绪池）

**协议**: HTTP（东方财富 push2ex，通过 akshare SDK）

**Python SDK**: `akshare >= 1.15`

**调用签名**（`_fetch_zt_pool`）:
```python
import akshare as ak
df = ak.stock_zt_pool_em(date="20260614")
# 底层: GET https://push2ex.eastmoney.com/api/qt/stock/ztpool/get
```

**非交易日回溯逻辑**:
```python
# 最多向前回溯 5 天查找最近交易日
for offset in range(5):
    candidate = (base - timedelta(days=offset)).strftime("%Y%m%d")
    df = ak.stock_zt_pool_em(date=candidate)
    if df is not None and len(df) > 0:
        actual = candidate
        break
```

**列查找**（akshare 版本间列名可能微调，用关键词匹配）:
```python
def _col(keyword):
    for c in df.columns:
        if keyword in str(c):
            return c
    return None

streak_col = _col("连板数")    # 如 "连板数" 或 "连板数_"
industry_col = _col("行业")
code_col = _col("代码")
name_col = _col("名称")
```

**返回字段映射**:
| akshare 列 | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `代码` | — | `astype(str) == code` 检查匹配 | 用于 target_in_pool |
| `名称` | `target_in_pool.name` | `str()` | 目标股名称 |
| `行业` | `target_in_pool.industry` / `top_industries` | `Counter().most_common(5)` | 行业分布 |
| `连板数` | `target_in_pool.streak` / `max_streak` | `int()` | 连板天数 |

### 预计算产物

#### 涨停池派生字段（commit `fc8a505`）

```python
{
    "actual_date": "2026-06-12",        # 实际数据日期（可能 ≠ 入参 date）
    "limit_up_count": 45,                # 涨停家数
    "max_streak": 5,                     # 最高连板数（龙头高度）
    "streak_distribution": {5: 1, 4: 3, 3: 5, 2: 12, 1: 24},  # 连板梯队
    "streak_distribution_text": "5板1家/4板3家/3板5家/2板12家/1板24家",  # 预格式化文本
    "top_industries": [
        {"industry": "半导体", "count": 8},
        {"industry": "汽车零部件", "count": 5}
    ],
    "target_in_pool": {                  # 仅当目标股在涨停池中
        "streak": 2, "name": "XX股份", "industry": "半导体"
    },
    "previous_day_count": 38             # 前一交易日涨停数（best-effort）
}
```

**`streak_distribution_text` 预格式化**（项目约定：预计算避免 LLM 算术错误）:
```python
dist_text = "/".join(f"{k}板{v}家" for k, v in dist_sorted.items())
```

#### 新闻情绪评分（`_score_sentiment`）

基于关键词字典对个股新闻打分:
- **正面词表** (`_POSITIVE_WORDS`): 利好、涨停、大涨、突破、超预期、增持、回购…（33 个）
- **负面词表** (`_NEGATIVE_WORDS`): 利空、跌停、大跌、亏损、减持、退市、爆雷…（35 个）

```python
score = (positive_count - negative_count) / total  # 归一化到 [-1, +1]
# label: > 0.5 乐观 / > 0.2 偏乐观 / > -0.2 中性 / > -0.5 偏悲观 / else 悲观
```

#### 热门股位置检测（`_check_hot_rank_position`）

检查目标股是否在 hot_rank top 20 中:
```python
{"rank": 3, "name": "XX股份", "change_pct": 10.0}  # 排名、名称、涨跌幅
```

#### 真实输出示例（688662 富信科技，2026-06-14）

涨停池 + 新闻情绪（hot_rank 为 null 时因 push2 限流）:

```json
{
  "hot_rank": null,
  "zt_pool": {
    "actual_date": "2026-06-12",
    "limit_up_count": 89,
    "max_streak": 4,
    "streak_distribution": {"4": 2, "2": 8, "1": 79},
    "streak_distribution_text": "4板2家/2板8家/1板79家",
    "top_industries": [
      {"industry": "半导体", "count": 11},
      {"industry": "化学制品", "count": 6},
      {"industry": "消费电子", "count": 6},
      {"industry": "光伏设备", "count": 5},
      {"industry": "电池设备", "count": 4}
    ],
    "previous_day_count": 0
  },
  "news_sentiment": {
    "score": 0.067,
    "label": "中性",
    "positive": 5,
    "negative": 4,
    "neutral": 6,
    "total": 15
  },
  "stock_hot_position": null
}
```

### Fallback 逻辑

sentiment 的子源是**并行采集**（非线性 fallback）:
- `hot_rank` 失败 → `hot_rank = None`，其余继续
- `zt_pool` 失败 → `zt_pool = None`，其余继续
- 个股新闻失败 → `stock_news = []`，其余继续

zt_pool 内部有**非交易日回溯**逻辑（最多 5 天），但这不是跨源 fallback。

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "600519", "date": "2026-06-14",
    "hot_rank": [
      {"code": "300xxx", "name": "XX股份", "change_pct": 20.0, "price": 15.6}
    ],
    "zt_pool": {
      "actual_date": "2026-06-13",
      "limit_up_count": 45,
      "max_streak": 5,
      "streak_distribution": {5: 1, 4: 3, 3: 5, 2: 12, 1: 24},
      "streak_distribution_text": "5板1家/4板3家/3板5家/2板12家/1板24家",
      "top_industries": [{"industry": "半导体", "count": 8}],
      "previous_day_count": 38
    },
    "stock_news": [...],
    "news_count": 15,
    "news_sentiment": {"score": 0.2, "label": "偏乐观", "positive": 5, "negative": 2, "neutral": 8, "total": 15},
    "stock_hot_position": null
  },
  "source": "eastmoney",
  "_calls": [
    {"stage": "sentiment/hot_rank", "success": true, "error": null, "duration_ms": 900},
    {"stage": "sentiment/zt_pool", "success": true, "error": null, "duration_ms": 2200}
  ]
}
```

**失败时**（hot_rank 限流）:
```json
{
  "success": true,
  "data": {
    "hot_rank": null,
    "zt_pool": {...}
  },
  "_calls": [
    {"stage": "sentiment/hot_rank", "success": false, "error": "ConnectionError: ...", "duration_ms": 10001},
    {"stage": "sentiment/zt_pool", "success": true, "error": null, "duration_ms": 2200}
  ]
}
```


### 已知陷阱

1. **push2 IP 限流影响 hot_rank**：高频探测后 IP-ban ~15min+，hot_rank 返回 `None` 不阻断其他子源
2. **zt_pool 用 push2ex**：与 push2 不同子域名，push2 限流时 push2ex 仍可访问
3. **akshare 列名版本漂移**：用 `_col(keyword)` 模糊匹配（如 "连板数" vs "连板数_"）
4. **非交易日回溯最多 5 天**：长假可能超出窗口 → zt_pool 返回 `None`，`actual_date` 记录实际日期
5. **NaN 连板数过滤**：`s is not None and s == s`（NaN != NaN 是 IEEE 754 特性）
6. **`stock_news` 独立调用东方财富搜索 API**：与 news 脚本各自独立，不共享结果
7. **情绪评分是关键词匹配**：不含 NLP/ML，按正/负面词 hit count 判定

### 健康追踪接入

2 个 stage 的 `record_call`（commit `42c30da`）:
```python
# hot_rank
start = time.monotonic()
try:
    r = em_get(url, params=params, timeout=10)
    # ... 解析 ...
    record_call("sentiment/hot_rank", success=True, duration_ms=(time.monotonic() - start) * 1000)
    return result
except Exception as e:
    record_call("sentiment/hot_rank", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
    return None

# zt_pool（在非交易日回溯循环之后统一记录）
if df is None:
    record_call("sentiment/zt_pool", success=False, error="No trading day found in 5-day window", ...)
    return None
# ... 计算 ...
record_call("sentiment/zt_pool", success=True, duration_ms=...)
```

## trading-policy（政策事件）

> 文件：`skills/trading-policy/scripts/policy.py`（208 行）
>
> 健康追踪子源：`policy/stock_em`、`policy/macro_cls`、`policy/macro_akshare`

### 调用入口

```bash
python skills/trading-policy/scripts/policy.py --ticker 600519 --date 2026-06-14 --lookback-days 30
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码
- `date`（string, 必填）: 分析日期 `YYYY-MM-DD`
- `lookback-days`（int, 可选, 默认 `30`）: 政策新闻回看天数

### 子源 1: `policy/stock_em`（个股相关政策新闻）

**协议**: HTTP（东方财富搜索 API，同 news 的 stock_em）

**调用签名**（`_fetch_policy_eastmoney`）:
```python
url = "https://search-api-web.eastmoney.com/search/jsonp"
inner_param = {
    "uid": "", "keyword": code,
    "type": ["cmsArticleWebOld"],
    "param": {"cmsArticleWebOld": {"pageIndex": 1, "pageSize": 30, ...}},
}
params = {"cb": "callback", "param": json.dumps(inner_param), "_": "1"}
headers = {"Referer": "https://so.eastmoney.com/", "User-Agent": _UA}
resp = em_get(url, params=params, headers=headers, timeout=15)
```

**与 news/stock_em 的差异**:
- `pageSize`: policy 用 30（news 用 50）
- 时间过滤: policy 按 `lookback_days` 过滤（news 不在此层过滤，交给时间分层）
- 输出字段含 `date`（news 输出 `time`）

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `title` | `title` | 文章标题 |
| `content` | `content` | 截取前 300 字 |
| `date` | `date` | 截取前 10 字符（`YYYY-MM-DD`） |
| `mediaName` | `source` | 来源媒体 |

### 子源 2: `policy/macro_cls`（宏观政策电报，主源）

**协议**: HTTP（财联社 `cls.cn`，同 news/macro_cls）

**调用签名**（`_fetch_macro_policy_cls`）:
```python
url = "https://www.cls.cn/nodeapi/telegraphList"
params = {"rn": "20", "page": "1"}
headers = {"User-Agent": _UA, "Referer": "https://www.cls.cn/"}
r = http_get(url, params=params, headers=headers, timeout=10)
```

**与 news/macro_cls 的差异**:
- `rn`（limit）: policy 用 20（news 用 10）
- 输出字段含 `date`（news 输出 `time`）

**返回字段映射**:
| HTTP 字段 | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `title` 或 `brief` | `title` | — | 标题 |
| `content` 或 `brief` | `content` | `[:300]` | 正文 |
| `ctime` | `date` | `fromtimestamp()` → `[:10]` | 仅取日期部分 |

### 子源 3: `policy/macro_akshare`（宏观政策，备源）

**触发条件**: CLS 失败或返回空列表时自动触发。

**协议**: HTTP（东方财富全球财经快讯，通过 akshare SDK）

**调用签名**（`_fetch_macro_policy_akshare`）:
```python
import akshare as ak
df = ak.stock_info_global_em()
```

**返回字段映射**:
| akshare 列 | output 字段 | 说明 |
|---|---|---|
| `标题` | `title` | 文章标题 |
| `摘要` | `content` | 截取前 300 字 |
| `发布时间` | `date` | 截取前 10 字符（`YYYY-MM-DD`） |

### Fallback 逻辑（宏观政策）

与 news 的宏观 fallback 完全同构（commit `10017ee` 同一批修复）:
```python
macro_source = "none"
macro_articles = []
try:
    macro_articles = _fetch_macro_policy_cls()
    if macro_articles:
        macro_source = "cls"
except Exception as e:
    data["macro_policy_error"] = str(e)

if not macro_articles:
    try:
        macro_articles = _fetch_macro_policy_akshare()
        if macro_articles:
            macro_source = "akshare"
    except Exception as e:
        data["macro_policy_error"] = f"{existing}; akshare: {e}"

data["macro_policy_news"] = macro_articles
data["macro_policy_source"] = macro_source
```

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "600519", "date": "2026-06-14", "lookback_days": 30,
    "stock_policy_news": [
      {"date": "2026-06-10", "title": "白酒行业消费税调整分析", "content": "...", "source": "东方财富"}
    ],
    "macro_policy_news": [
      {"date": "2026-06-14", "title": "国务院常务会议部署稳增长措施", "content": "...", "source": "财联社"}
    ],
    "macro_policy_source": "cls"
  },
  "source": "eastmoney+cls",
  "_calls": [
    {"stage": "policy/stock_em", "success": true, "error": null, "duration_ms": 800},
    {"stage": "policy/macro_cls", "success": true, "error": null, "duration_ms": 500}
  ]
}
```

**CLS 失败时**:
```json
{
  "data": {
    "macro_policy_news": [...],
    "macro_policy_source": "akshare",
    "macro_policy_error": "CLS macro policy unavailable: ConnectionError: ..."
  },
  "source": "eastmoney+akshare"
}
```


### 已知陷阱

1. **与 news 脚本高度同构**：宏观新闻 fallback 逻辑几乎相同，差异在 limit（20 vs 10）、字段名、lookback_days（30 vs 7）
2. **CLS 失效是已知问题**：与 news 共享同一问题（commit `10017ee`），`macro_policy_source` 追踪实际源
3. **东方财富搜索基于关键词**：用股票代码搜索，返回不一定全是政策新闻，LLM 需自行判断相关性
4. **`lookback_days` 影响个股政策范围**：宏观新闻取最新 N 条不做日期过滤
5. **articles 列表初始化 bug**：早期 `articles` 未在 try 外初始化导致 `UnboundLocalError`（commit `fa6dda9`）

### 健康追踪接入

3 个 stage（commit `a8aead4`）:
```python
# stock_em
start = time.monotonic()
try:
    # ... fetch ...
    record_call("policy/stock_em", success=True, duration_ms=...)
    return articles
except Exception as e:
    record_call("policy/stock_em", success=False, error=str(e), duration_ms=...)
    return []

# macro_cls（失败时 raise，但 record_call 先记）
start = time.monotonic()
try:
    # ... fetch ...
    record_call("policy/macro_cls", success=True, duration_ms=...)
    return articles
except Exception as e:
    record_call("policy/macro_cls", success=False, error=str(e), duration_ms=...)
    raise RuntimeError(...) from e

# macro_akshare（同上模式）
```

## trading-hot-money（资金流）

> 文件：`skills/trading-hot-money/scripts/hot_money.py`（221 行）
>
> 健康追踪子源：`hot_money/northbound`、`hot_money/fund_flow`、`hot_money/hot_stocks`、`hot_money/dragon_tiger`、`hot_money/sector_fund_flow`

### 调用入口

```bash
python skills/trading-hot-money/scripts/hot_money.py --ticker 600519 --date 2026-06-14
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码
- `date`（string, 必填）: 分析日期 `YYYY-MM-DD`

### 子源 1: `hot_money/northbound`（北向资金，同花顺）

**协议**: HTTP（同花顺 `data.hexin.cn`）

**调用签名**（`_fetch_northbound`）:
```python
url = "https://data.hexin.cn/market/hsgtApi/method/dayChart/"
headers = {
    "User-Agent": "Mozilla/5.0 ... Chrome/117.0.0.0",
    "Host": "data.hexin.cn",
    "Referer": "https://data.hexin.cn/",
}
r = http_get(url, headers=headers, timeout=10)
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `time[]` | `recent_points[].time` | — | 时间序列 |
| `hgt[]` | `hgt_close` / `recent_points[].hgt` | `float(hgt[-1])` | 沪股通净流入 |
| `sgt[]` | `sgt_close` / `recent_points[].sgt` | `float(sgt[-1])` | 深股通净流入 |
| — | `total` | `hgt_close + sgt_close` | 北向合计 |
| — | `signal` | `"inflow" if total > 0 else "outflow"` | 方向标记 |
| — | `recent_points` | 最近 10 个数据点 | 趋势上下文 |

### 子源 2: `hot_money/fund_flow`（个股资金流，东方财富 push2）

**协议**: HTTP（东方财富 push2 `fflow/kline` 接口）

**调用签名**（`_fetch_fund_flow`）:
```python
secid = f"1.{code}" if code.startswith("6") else f"0.{code}"
url = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
params = {
    "secid": secid, "klt": 1,
    "fields1": "f1,f2,f3,f7",
    "fields2": "f51,f52,f53,f54,f55,f56,f57",
}
r = em_get(url, params=params, timeout=10)
```

**返回解析**（klines 数组，取最后一条）:
```python
klines = d.get("data", {}).get("klines", [])
last = klines[-1].split(",")  # e.g. "2026-06-14,1000000,..."
```

| klines 索引 | output 字段 | 说明 |
|---|---|---|
| `last[1]` | `main_net` | 主力净流入（**元**） |
| `last[4]` | `large_net` | 大单净流入 |
| `last[5]` | `super_net` | 超大单净流入 |

### 子源 3: `hot_money/hot_stocks`（热门涨停股，同花顺 10jqka）

**协议**: HTTP（同花顺 `zx.10jqka.com.cn`）

**调用签名**（`_fetch_hot_stocks`）:
```python
url = f"http://zx.10jqka.com.cn/event/api/getharden/date/{date}/orderby/date/orderway/desc/charset/GBK/"
headers = {"User-Agent": "Mozilla/5.0 ... Chrome/117.0.0.0"}
r = http_get(url, headers=headers, timeout=10)
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `code` | `code` | 股票代码 |
| `name` | `name` | 股票名称 |
| `reason` | `reason` | 涨停原因/题材 |
| `zhangfu` | `change_pct` | 涨幅 |

### 子源 4: `hot_money/dragon_tiger`（龙虎榜，东方财富 datacenter）

**协议**: HTTP（东方财富 datacenter，通过 `eastmoney_datacenter` helper）

**调用签名**（`_fetch_dragon_tiger`）:
```python
data = eastmoney_datacenter(
    "RPT_DAILYBILLBOARD_DETAILSNEW",
    filter_str=f'(TRADE_DATE>=\'{start_dt}\')(TRADE_DATE<=\'{date}\')(SECURITY_CODE="{code}")',
    page_size=10,
    sort_columns="TRADE_DATE",
    sort_types="-1",
)
```

**返回字段映射**（金额从元 → 万元）:
| HTTP 字段 | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `TRADE_DATE` | `date` | `[:10]` | 交易日期 |
| `EXPLANATION` | `reason` | — | 上榜原因 |
| `BILLBOARD_NET_AMT` | `net_buy` | `/ 10000` → **万元** | 净买入额 |
| `BILLBOARD_BUY_AMT` | `buy_amt` | `/ 10000` → **万元** | 买入额 |
| `BILLBOARD_SELL_AMT` | `sell_amt` | `/ 10000` → **万元** | 卖出额 |
| `TURNOVERRATE` | `turnover` | `float()` | 换手率 (%) |
| `CLOSE_PRICE` | `close_price` | `float()` | 收盘价 |
| `CHANGE_RATE` | `change_rate` | `float()` | 涨跌幅 (%) |

### 子源 5: `hot_money/sector_fund_flow`（板块资金流排名，东方财富 push2）

**协议**: HTTP（东方财富 push2 `clist` 接口，commit `caa7c7d`）

**调用签名**（`_fetch_sector_fund_flow`）:
```python
url = "https://push2.eastmoney.com/api/qt/clist/get"
params = {
    "pn": "1", "pz": "100", "po": "1", "np": "1",
    "fltt": "2", "invt": "2",
    "fs": "m:90+t:2",          # 行业板块（~90 个）
    "fields": "f3,f12,f14,f62,f136,f184",
}
r = em_get(url, params=params, timeout=15)
```

**返回字段映射**（金额从元 → 亿元）:
| HTTP 字段 | output 字段 | 转换 | 说明 |
|---|---|---|---|
| `f14` | `name` | — | 板块名称 |
| `f3` | `change_pct` | — | 板块涨跌幅 (%) |
| `f62` | `main_net_yi` | `/ 1e8` → **亿元** | 主力净流入 |
| `f136` | `super_net_yi` | `/ 1e8` → **亿元** | 超大单净流入 |
| `f184` | `main_net_pct` | — | 主力净流入占比 (%) |

**输出结构**:
```python
{
    "inflow_top": boards_sorted[:8],      # 主力净流入 top 8
    "outflow_top": reversed(boards_sorted[-8:]),  # 主力净流出 top 8
    "total_boards": len(boards_sorted),   # 总板块数
}
```

### Fallback 逻辑

hot_money 的 5 个子源是**并行采集**（非线性 fallback）:
- 每个子源失败返回 `None` 或 `[]`，不阻断其他子源
- push2 限流时 `fund_flow` 和 `sector_fund_flow` 可能同时失败（同一子域名）

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "600519", "date": "2026-06-14",
    "northbound": {
      "hgt_close": 50000000, "sgt_close": -20000000,
      "total": 30000000, "signal": "inflow",
      "recent_points": [
        {"time": "2026-06-14", "hgt": 50000000, "sgt": -20000000}
      ]
    },
    "fund_flow": {"main_net": 15000000, "large_net": 8000000, "super_net": 12000000},
    "sector_fund_flow": {
      "inflow_top": [
        {"name": "半导体", "change_pct": 3.5, "main_net_yi": 15.2, "super_net_yi": 8.5, "main_net_pct": 2.3}
      ],
      "outflow_top": [
        {"name": "房地产", "change_pct": -2.1, "main_net_yi": -8.3, "super_net_yi": -5.1, "main_net_pct": -1.5}
      ],
      "total_boards": 90
    },
    "hot_stocks": [
      {"code": "300xxx", "name": "XX股份", "reason": "AI芯片", "change_pct": "20.0"}
    ],
    "dragon_tiger": [
      {"date": "2026-06-12", "reason": "日涨幅偏离值达7%", "net_buy": 5000.5,
       "buy_amt": 8000.0, "sell_amt": 3000.0, "turnover": 5.2,
       "close_price": 15.6, "change_rate": 10.0}
    ]
  },
  "source": "eastmoney+10jqka+hexin",
  "_calls": [
    {"stage": "hot_money/northbound", "success": true, "error": null, "duration_ms": 600},
    {"stage": "hot_money/fund_flow", "success": true, "error": null, "duration_ms": 900},
    {"stage": "hot_money/hot_stocks", "success": true, "error": null, "duration_ms": 500},
    {"stage": "hot_money/dragon_tiger", "success": true, "error": null, "duration_ms": 1100},
    {"stage": "hot_money/sector_fund_flow", "success": true, "error": null, "duration_ms": 1000}
  ]
}
```

**push2 限流时**（fund_flow + sector_fund_flow 同时失败）:
```json
{
  "success": true,
  "data": {
    "fund_flow": null,
    "sector_fund_flow": null,
    "northbound": {...},
    "hot_stocks": [...],
    "dragon_tiger": [...]
  },
  "_calls": [
    {"stage": "hot_money/northbound", "success": true, "error": null, "duration_ms": 600},
    {"stage": "hot_money/fund_flow", "success": false, "error": "ConnectionError: ...", "duration_ms": 10001},
    {"stage": "hot_money/hot_stocks", "success": true, "error": null, "duration_ms": 500},
    {"stage": "hot_money/dragon_tiger", "success": true, "error": null, "duration_ms": 1100},
    {"stage": "hot_money/sector_fund_flow", "success": false, "error": "ConnectionError: ...", "duration_ms": 10002}
  ]
}
```


### 已知陷阱

1. **push2 限流同时影响 fund_flow + sector_fund_flow**：共用 `push2.eastmoney.com`，限流 ~15min+（per-subdomain）
2. **`null` 表示抓取失败**：`fund_flow` / `sector_fund_flow` 为 null 是数据不可用，不是"净流入为零"
3. **push2 IPv6 连接重置**：`http_helpers.py` 全局强制 IPv4（commit `6fdfc01`）
4. **北向资金单位是元**：`hgt_close` / `sgt_close` 原始单位元，不是亿元
5. **龙虎榜金额从元转万元**：`BILLBOARD_NET_AMT` 等 `/ 10000`，output 单位万元
6. **板块资金流从元转亿元**：`f62` / `f136` 原始单位元，`/ 1e8` 转亿元
7. **hot_stocks 用 HTTP**：`http://zx.10jqka.com.cn/` 非加密，可能被拦截
8. **dragon_tiger 返回 `[]` 而非 `null`**：空列表 = "正常无数据"，null = "抓取失败"
9. **em_get 限流间隔全局共享**：IP-ban 后间隔无意义

### 健康追踪接入

5 个 stage 的 `record_call`（commit `615e830` 从 `record_error` 升级为 `record_call`）:
```python
# 每个子源的统一模式
start = time.monotonic()
try:
    result = _fetch_xxx(...)
    record_call(f"hot_money/{source}", success=True, duration_ms=(time.monotonic() - start) * 1000)
    return result
except Exception as e:
    record_call(f"hot_money/{source}", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
    return None  # 或 [] 对 dragon_tiger
```

5 个 stage：`hot_money/northbound`、`hot_money/fund_flow`、`hot_money/hot_stocks`、`hot_money/dragon_tiger`、`hot_money/sector_fund_flow`。

## trading-lockup（解禁 + 减持）

> 文件：`skills/trading-lockup/scripts/lockup.py`（227 行）
>
> 健康追踪子源：`lockup/ann_em`、`lockup/reduce_em`
>
> 注：另有 `lockup_history` / `lockup_upcoming` / `insider_transactions` 三段逻辑不单独追踪健康状态（无独立 stage 名）， failures 静默降级为空列表。

### 调用入口

```bash
python skills/trading-lockup/scripts/lockup.py --ticker 600519 --date 2026-06-14
```

**入参**:
- `ticker`（string, 必填）: 6 位 A 股代码
- `date`（string, 必填）: 分析日期 `YYYY-MM-DD`（用于计算 upcoming 窗口 + announcements 回看）

### 数据段 1: `lockup_history`（历史解禁，东方财富 datacenter）

**协议**: HTTP（东方财富 datacenter，通过 `eastmoney_datacenter` helper）

**调用签名**（`_fetch_lockup_history`）:
```python
data = eastmoney_datacenter(
    "RPT_LIFT_STAGE",
    filter_str=f'(SECURITY_CODE="{code}")',
    page_size=15,
    sort_columns="FREE_DATE",
    sort_types="-1",
)
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `FREE_DATE` | `date` | `[:10]` 解禁日期 |
| `LIMITED_STOCK_TYPE` | `type` | 限售股类型 |
| `FREE_SHARES_NUM` | `shares` | 解禁股数 |
| `FREE_RATIO` | `ratio` | 解禁比例 |

### 数据段 2: `lockup_upcoming`（未来解禁，东方财富 datacenter）

**调用签名**（`_fetch_lockup_upcoming`）:
```python
end_dt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=90)).strftime("%Y-%m-%d")
data = eastmoney_datacenter(
    "RPT_LIFT_STAGE",
    filter_str=f'(SECURITY_CODE="{code}")(FREE_DATE>=\'{date}\')(FREE_DATE<=\'{end_dt}\')',
    page_size=20,
    sort_columns="FREE_DATE",
    sort_types="1",
)
```

**与 history 的差异**: 增加 `FREE_DATE` 范围过滤（当前日期 → +90 天），`sort_types="1"`（升序，最近解禁在前）。

### 数据段 3: `insider_transactions`（内部人交易，mootdx F10）

**协议**: TDX TCP（mootdx F10 接口）

**调用签名**（`_fetch_insider_transactions`）:
```python
from mootdx.quotes import Quotes
client = Quotes.factory(market=<0|1>, timeout=10)
info = client.f10(symbol=int(code), name="股东变动")
# 取前 10 行
```

**返回**: 每行字段全部 `str()` 化（不做类型转换），输出为 `{k: str(v)}` 字典列表。

### 子源 1: `lockup/ann_em`（结构化公告事件，东方财富 ann API）

**协议**: HTTP（东方财富公告 API `np-anotice-stock.eastmoney.com`，commit `82b0e07`）

**调用签名**（`_fetch_announcements`）:
```python
url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
params = {
    "ann_type": "A", "stock_list": code, "sr": "-1",
    "page_size": "50", "page_index": "1",
    "f_node": "0", "s_node": "0",
}
headers = {"User-Agent": _UA, "Referer": "https://data.eastmoney.com/"}
resp = http_get(url, params=params, headers=headers, timeout=10)
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `notice_date` | `date` | `[:10]` 公告日期 |
| `title` | `title` | 公告标题 |
| `art_code` | `url` | 拼接为 `https://data.eastmoney.com/notices/detail/{code}/{art_code}.html` |

**公告分类与重要性评分**（`_classify_announcement`，commit `82b0e07`）:

| 类型 | importance | 关键词 |
|---|---|---|
| 业绩预告/快报 | 3 | 业绩预告、业绩预增/预减/预亏/预盈、业绩快报 |
| 重大重组 | 3 | 重大资产重组、重组、并购、吸收合并 |
| 停牌/复牌 | 3 | 停牌、复牌 |
| 监管/处罚 | 2 | 问询函、关注函、监管措施、处罚、立案、警示 |
| 回购 | 2 | 回购 |
| 增发/配股 | 2 | 增发、配股、公开发行 |
| 股东增持 | 2 | 增持 |
| 股东减持 | 2 | 减持 |
| 分红派息 | 1 | 分红、派息、除权、除息、送转、股权登记 |
| 解禁 | 0 | 解禁、限售股上市、限售股份流通（**已过滤**，由 lockup_history 覆盖） |
| 其他 | 1 | 兜底 |

**处理逻辑**:
- 过滤掉"解禁"类型（已由 `lockup_history` / `lockup_upcoming` 覆盖）
- 过滤掉 `lookback_days`（默认 60 天）之前的公告
- 按 `(importance, date)` 降序排序，取 top 8

### 子源 2: `lockup/reduce_em`（减持公告，东方财富 datacenter）

**协议**: HTTP（东方财富 datacenter，通过 `eastmoney_datacenter` helper）

**调用签名**（`_fetch_reduce_em`）:
```python
data = eastmoney_datacenter(
    "RPT_REDUCED_HOLDINGS",
    filter_str=f'(SECURITY_CODE="{code}")(REDUCE_DATE>={datetime.now().strftime("%Y-%m-%d")})',
    page_size=10,
    sort_columns="REDUCE_DATE",
    sort_types="-1",
)
```

**返回字段映射**:
| HTTP 字段 | output 字段 | 说明 |
|---|---|---|
| `REDUCE_DATE` | `date` | `[:10]` 减持日期 |
| `REDUCING_SHAREHOLDER` | `reducing_shareholder` | 减持股东 |
| `REDUCING_SHARES` | `reducing_shares` | 减持股数 |
| `REDUCING_RATIO` | `reducing_ratio` | 减持比例 |
| `REDUCE_REASON` | `reduce_reason` | 减持原因 |

### 预计算产物

#### 解禁压力评级（`pressure_rating`）

基于 `lockup_upcoming` 的条数自动评级:
```python
if len(upcoming) >= 3:
    pressure_rating = "重大压力"
elif len(upcoming) >= 1:
    pressure_rating = "中等压力"
else:
    pressure_rating = "无明显压力"
```

#### 真实输出示例（688662 富信科技，2026-06-14）

该股无即将解禁，`pressure_rating = "无明显压力"`，但有 8 条公告（含 2 条股东减持）:

```json
{
  "ticker": "688662",
  "date": "2026-06-14",
  "lockup_history": [
    {"date": "2024-04-01", "type": "", "shares": "", "ratio": 0.3854},
    {"date": "2023-04-03", "type": "", "shares": "", "ratio": 0.0203},
    {"date": "2022-04-01", "type": "", "shares": "", "ratio": 0.5995},
    {"date": "2021-10-08", "type": "", "shares": "", "ratio": 0.0420}
  ],
  "lockup_upcoming": [],
  "insider_transactions": [],
  "announcements": [
    {"date": "2026-06-11", "type": "股东减持", "title": "富信科技:广东富信科技股份有限公司董事减持结果公告", "importance": 2},
    {"date": "2026-05-08", "type": "股东减持", "title": "富信科技:广东富信科技股份有限公司董事减持股份计划公告", "importance": 2},
    {"date": "2026-06-13", "type": "其他", "title": "富信科技:广东富信科技股份有限公司股票交易异常波动公告", "importance": 1}
  ],
  "reduce_holdings": [],
  "pressure_rating": "无明显压力"
}
```

### Fallback 逻辑

lockup 的各段是**独立采集**（非线性 fallback）:
- `lockup_history` / `lockup_upcoming` / `insider_transactions` 失败 → 返回 `[]`
- `announcements` 失败 → 返回 `[]`
- `reduce_holdings` 失败 → 返回 `[]`
- 各段失败不影响其他段

### 输出 JSON 结构（完整示例）

```json
{
  "success": true,
  "data": {
    "ticker": "600519", "date": "2026-06-14",
    "lockup_history": [
      {"date": "2025-03-15", "type": "定向增发机构配售股份", "shares": "5000000", "ratio": "0.4%"}
    ],
    "lockup_upcoming": [
      {"date": "2026-08-20", "type": "首发原股东限售股份", "shares": "10000000", "ratio": "0.8%"}
    ],
    "insider_transactions": [
      {"变动日期": "2026-05-10", "变动人": "XXX", "变动股数": "-50000", "变动比例": "-0.004%"}
    ],
    "announcements": [
      {"date": "2026-06-10", "type": "业绩预告/快报", "title": "2026年半年度业绩预增公告",
       "importance": 3, "url": "https://data.eastmoney.com/notices/detail/600519/XXX.html"},
      {"date": "2026-05-15", "type": "分红派息", "title": "2025年度利润分配方案",
       "importance": 1, "url": "..."}
    ],
    "reduce_holdings": [
      {"date": "2026-06-01", "reducing_shareholder": "XXX投资公司",
       "reducing_shares": "2000000", "reducing_ratio": "0.16%", "reduce_reason": "自身资金需求"}
    ],
    "pressure_rating": "中等压力"
  },
  "source": "eastmoney+mootdx+ann",
  "_calls": [
    {"stage": "lockup/ann_em", "success": true, "error": null, "duration_ms": 700},
    {"stage": "lockup/reduce_em", "success": true, "error": null, "duration_ms": 900}
  ]
}
```

**部分失败时**（ann_em API 返回 success=false）:
```json
{
  "success": true,
  "data": {
    "announcements": [],
    "lockup_history": [...],
    "reduce_holdings": [...]
  },
  "_calls": [
    {"stage": "lockup/ann_em", "success": false, "error": "API returned no success", "duration_ms": 500},
    {"stage": "lockup/reduce_em", "success": true, "error": null, "duration_ms": 900}
  ]
}
```


### 已知陷阱

1. **ann API 过滤"解禁"公告**：lockup_history/upcoming 已覆盖解禁数据，避免重复计算（commit `82b0e07`）
2. **ann API lookback 默认 60 天**：比 news（7 天）、policy（30 天）更长，因公告影响周期长
3. **ann API `success` 字段检查**：payload 须 `success: true`，与 datacenter 的 `result != null` 不同
4. **insider_transactions 全部 str 化**：mootdx F10 字段类型不确定，统一 `{k: str(v)}`
5. **lockup_upcoming 90 天窗口**：固定 `forward_days=90`，不可配置
6. **reduce_em 用 `datetime.now()`**：`REDUCE_DATE >= today` 而非入参 date
7. **pressure_rating 仅基于条数**：不含市值权重，快速信号够用但不精确

### 健康追踪接入

2 个 stage 的 `record_call`（commit `785370c`）:
```python
# ann_em
start = time.monotonic()
try:
    resp = http_get(url, params=params, headers=headers, timeout=10)
    payload = resp.json()
    if not payload.get("success"):
        record_call("lockup/ann_em", success=False, error="API returned no success", ...)
        return []
    # ... 处理 ...
    record_call("lockup/ann_em", success=True, ...)
    return events[:8]
except Exception as e:
    record_call("lockup/ann_em", success=False, error=str(e), ...)
    return []

# reduce_em
start = time.monotonic()
try:
    data = eastmoney_datacenter("RPT_REDUCED_HOLDINGS", ...)
    record_call("lockup/reduce_em", success=True, ...)
    return result
except Exception as e:
    record_call("lockup/reduce_em", success=False, error=str(e), ...)
    return []
```

注：`lockup_history` / `lockup_upcoming` / `insider_transactions` 三段没有独立 stage 名，失败静默降级为空列表（不通过 record_call 记录）。

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
