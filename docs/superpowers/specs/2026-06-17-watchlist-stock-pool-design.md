# 股票池自动维护设计（雪球异动驱动）

> 日期：2026-06-17
> 状态：设计已确认，待实现
> 范围：第一期（原始采集 + diff 发现 + 最小加工）

## 1. 背景与目标

当前 `trading_quick` / `trading_full` 工具分析哪只股票是**人工指定 ticker**。本设计目标是**自动维护一个股票池**：每天扫描全市场，发现异动股票，作为候选股供后续分析。

### 核心思路

利用雪球 `abnormal/reasons.json` 接口——它返回单只股票的异动归因（天级 `reason_list` + 区间级 `range_reason_list`）。**没有异动的股票返回空数组**，因此接口本身就是一个天然的异动过滤器，无需额外阈值。

### 数据价值层级

雪球异动数据有三层价值，从底到高：

1. **单日异动**（`reason_list`）：天级脉冲，单独看噪声大，价值低——作为"触发器"
2. **区间趋势**（`range_reason_list`）：LONG/SHORT + 涨幅 + 持续天数——投资价值所在
3. **跨个股板块共振**（聚合）：多只股指向同一行业驱动——最强信号

第一期聚焦第 1、2 层（数据采集 + diff + 单股排序），第 3 层（板块聚合）留第二期。

## 2. 架构：分层解耦的数据管道

**核心原则**：每层留原始数据，方案可随时换、随时重跑。

```
第0层【universe 清单】  每日刷新全市场 ticker（东财 clist）
   存: watchlist/universe.json
   ↓
第1层【raw 快照】       并发扫描雪球，每股存完整异动历史
   存: watchlist/raw/{date}.json
   ↓
第2层【diff 发现】      今日快照 vs 上次快照 → 新增异动
   存: watchlist/diff/{date}.json
   ↓
第3层【加工】           趋势排序生成候选清单（第一期最小加工）
   存: watchlist/derived/{date}-candidates.json
   ↓
                    人工挑选 → trading_full
```

### 设计原则

1. **原始数据不可变**：第 0、1 层是"事实"，雪球给什么存什么，不做加工。
2. **解读可替换**：第 2、3 层是"解读"，规则/方案随时换——因为原始快照都在，改 diff 规则或换加工方案，只需重跑该层，不用重新扫描。
3. **每层独立 CLI**：可单独跑、可串跑。

### 实现层归属

- **第 0、1 层（数据采集）→ Python**：与现有 `skills/*/scripts/*.py` 同类，复用 `skills/_shared/http_helpers.py`（`em_get` 东财限流、`record_call`/`output_json` 健康追踪）。
- **第 2、3 层（diff/加工）→ TypeScript**：JSON 对比对 TS 更顺手，复用 `src/source-health-cli.ts` 的 CLI 模式 + `src/source-health-store.ts` 的原子写。

通过 JSON 文件解耦——Python 采集写文件，TS 读取文件加工，互不依赖。

## 3. 存储格式

位置：`~/.openclaw/watchlist/`（与 `trading-reports/` 平级）。全部 JSON + 原子写（tmp + rename，防 partial write，复用 `source-health-store.ts` 模式）。

```
~/.openclaw/watchlist/
├── universe.json                          # 第0层：全市场清单（每日刷新）
├── raw/
│   ├── 2026-06-17.json                    # 第1层：今日雪球快照
│   └── 2026-06-16.json                    # 上次快照（diff 的基线）
├── diff/
│   └── 2026-06-17.json                    # 第2层：今日 vs 上次的新增异动
└── derived/
    └── 2026-06-17-candidates.json         # 第3层：排序后的候选清单
```

### universe.json（第 0 层）

```jsonc
{
  "updated_at": "2026-06-17T20:35:00+08:00",
  "source": "eastmoney clist",
  "total": 5533,
  "stocks": [
    { "code": "688146", "symbol": "SH688146", "name": "中船特气" },
    { "code": "600519", "symbol": "SH600519", "name": "贵州茅台" }
  ]
}
```

### raw/{date}.json（第 1 层）

```jsonc
{
  "scan_date": "2026-06-17",
  "begin_ms": 1713456000000,           // 传给雪球的 begin（毫秒时间戳，权威）
  "end_ms":   1781625600000,           // 传给雪球的 end（毫秒时间戳，权威）
  "begin_date": "2025-04-16",          // 从 begin_ms 反推（人类可读）
  "end_date":   "2026-06-17",          // 从 end_ms 反推（人类可读）
  "window_months": 14,
  "scanned": 5533, "succeeded": 5510, "failed": 23,
  "stocks": {
    "SH688146": {
      "name": "中船特气",
      "reason_list": [ /* 雪球返回的完整数组，原样存 */ ],
      "range_reason_list": [ /* 雪球返回的完整数组，原样存 */ ]
    },
    "SH600519": { "name": "贵州茅台", "reason_list": [], "range_reason_list": [] },
    "SH000001": { "name": "平安银行", "scan_error": "timeout" }
  }
}
```

- 空数组也存（证明扫过、无异动）。
- 失败的股票存 `scan_error` 字段，diff 时跳过——**失败隔离**。

### diff/{date}.json（第 2 层）

```jsonc
{
  "scan_date": "2026-06-17",
  "baseline": "2026-06-16",            // 对比的基线快照日期
  "changes": [
    {
      "ticker": "SH688146", "name": "中船特气",
      "new_reason_points": [ /* 今日有、昨日无的 reason_list 元素 */ ],
      "new_range_trends": [ /* 今日有、昨日无的 range_reason_list 元素 */ ]
    }
  ]
}
```

### derived/{date}-candidates.json（第 3 层）

```jsonc
{
  "scan_date": "2026-06-17",
  "candidates": [
    {
      "ticker": "SH688146", "name": "中船特气",
      "top_trend": { "type": "LONG", "percent": 756.7, "days": 77, "ongoing": true },
      "new_today": { "reasons": 1, "ranges": 1 },
      "last_analyzed": null
    }
  ]
}
```

### Size 预估

raw 单日 ~5-8 MB（5533 股，多数空、活跃股带历史），30 天 ~150-240 MB，可接受。

## 4. 参数

### 雪球时间窗口（滚动 14 个月）

```
end_ms   = 扫描当天 23:59:59 (北京时间) 的毫秒时间戳
begin_ms = end_ms 对应日期往前推 14 个月的 0:00 毫秒时间戳
```

`end_ms` 取当天 23:59:59 而非 now()，保证同一天多次扫描的窗口一致（可复现）；`begin_ms` 用日期对齐而非精确减 14×30 天，避免月份天数差异导致窗口漂移。

**为什么 14 个月**：雪球的 `begin` 同时过滤 `reason_list` 和 `range_reason_list`。窄窗口（如 7 天）会漏掉长周期趋势（实测：688146 的 756% LONG 区间在 7 天窗口下消失）。14 个月足够覆盖长区间趋势，同时让 diff 持续发现新异动。

### 扫描参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--concurrency` | 3 | 雪球并发数（保守起步，范围 1-5） |
| `--date` | 今天 | 指定扫描日期（支持补跑历史） |
| `--baseline` | 最近可用快照 | diff 的基线日期 |
| `WATCHLIST_DIR` | `~/.openclaw/watchlist` | 存储路径（环境变量） |

## 5. 每层核心算法

### 第 0 层：universe 清单刷新（Python）

```
1. 东财 clist 分页拉取（pz=100 硬上限，~56 页循环）
   fs = "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23"  ← 深主板/创业板/沪主板/科创板，天然排除北交所
2. 每页带重试（http_helpers._with_retry，ConnectionError/HTTPError 重试 3 次）
3. 按 code 去重（实测 5863→5533，东财把股归入多个分类有重复）
4. symbol 转换：6→SH、0/3→SZ（实测 200 样本零误差）
5. 存 universe.json（原子写）
```

输出字段：`{code, symbol, name}` × 5533。刷新一次 ~21 秒。

### 第 1 层：snapshot 快照（Python，核心难点）

**并发控制**：
- 默认 `concurrency=3`
- 每股调用前加 stagger jitter（0-1500ms，稳妥，虽然雪球不限流）
- **每股独立重试**：单股失败重试 1 次（网络抖动），仍失败则标记 `scan_error`、跳过

**单股处理**：
```
for symbol in universe:
    url = xueqiu reasons.json?symbol={symbol}&begin={begin_ms}&end={end_ms}
    带 cookie xq_a_token + UA
    解析 JSON → reason_list + range_reason_list 原样存
    空数组也存
    失败 → {scan_error: msg}
```

**进度可见性**：扫描中每 100 只报告一次（`已扫 N/5533，M 失败`）。5533 股 × 并发 3 ≈ 10-15 分钟。

**健康追踪**：复用 `http_helpers.record_call`，每股记录 `{stage: "xueqiu/snapshot", success, error, duration_ms}`。

### 第 2 层：diff 发现（TS，核心逻辑）

**关键设计——按 timestamp 集合求差，而非取最后一条**：

```
for ticker in 今日快照.stocks:
    今日_reasons = 今日.reason_list 的 timestamp 集合
    基线_reasons = 基线.reason_list 的 timestamp 集合（无基线=首次扫描，全部算新增）
    新增_reasons = 今日.reason_list 中 timestamp ∉ 基线_reasons 的元素

    同理对 range_reason_list（用 begin+end 组合做唯一键）

    若 新增_reasons 或 新增_ranges 非空 → 记入 diff.changes
```

**为什么用集合求差而非取最后一条**：
- 取最后一条假设雪球每天只加一条，但实际可能一次加多条、或修正历史数据。
- 集合求差能抓到"今天加了 3 条"或"雪球补了前几天漏的数据"，更鲁棒。

**range_reason_list 唯一键**：`begin+end` 组合。同一天可能新增多个区间，靠 type/percent 区分不可靠（数值会变）；begin+end 是区间身份。即使雪球更新了某区间的 percent，只要 begin+end 不变，diff 不重复计——这是"新增区间"的合理定义。

**diff 规则可换**：这套是默认规则。以后想加过滤（如"只关注 end 在最近 7 天的区间"），改 diff 脚本重跑即可，不动 raw 数据。

### 第 3 层：候选清单（TS，第一期最小加工）

```
for change in diff.changes:
    从该股今日 range_reason_list 提取"最强趋势" top_trend：
        优先级：ongoing(end 靠近今天) > 已结束
               LONG > SHORT
               |percent| 大 > 小
    汇总 new_today: {新增 reasons 数, 新增 ranges 数}
    查本地状态 last_analyzed

按 top_trend.|percent| 降序排列 → candidates.json
```

**第一期不做**（第二期）：LLM 行业归类、板块共振聚合、自动触发 trading_full。

## 6. CLI 命令

沿用 `package.json scripts` + `src/*-cli.ts` 模式。

| 命令 | 作用 | 实现 |
|------|------|------|
| `npm run scan-universe` | 第 0 层：刷新全市场清单 | Python `skills/watchlist/scripts/scan_universe.py` |
| `npm run snapshot` | 第 1 层：并发扫雪球存快照 | Python `skills/watchlist/scripts/snapshot.py` |
| `npm run diff` | 第 2 层：对比快照出 diff | TS `src/diff-cli.ts` |
| `npm run candidates` | 第 3 层：排序生成候选清单 | TS `src/candidates-cli.ts` |
| `npm run scan-all` | 串跑 0→1→2→3 | TS `src/scan-all.ts`（一键全流程） |

**新增 skill**：`skills/watchlist/`（承载 Python 脚本），与现有 7 个 skill 平级，在 `openclaw.plugin.json` 注册。

## 7. 范围划分

### 第一期（本设计）

- 第 0 层 universe 清单（东财分页 + 去重 + symbol 转换）
- 第 1 层 raw 快照（雪球并发扫描 + 失败隔离）
- 第 2 层 diff 发现（集合求差）
- 第 3 层最小加工（趋势排序，无 LLM）
- 4 个 CLI 命令 + 1 个串跑

### 第二期（后续）

- 第 3 层 LLM 加工：行业归类、板块共振聚合
- 全自动调度：cron 定时触发，无人值守跑 trading_full
- dashboard 可视化：候选股卡片

## 8. 实测验证记录

设计阶段已实测验证以下技术前提：

| 验证项 | 结论 |
|--------|------|
| 东财 clist 全量 | `fs=m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23`，server total 5533，分页 56 页 × 21 秒 |
| 东财单页上限 | 硬上限 100 条（pz=200/500/1000 都返回 100） |
| 东财去重 | 拉取 5863，去重 5533（163 条重复） |
| symbol 前缀规则 | 200 样本零误差：6→SH、0/3→SZ |
| 雪球 begin 过滤 | 同时过滤 reason_list 和 range_reason_list；7 天窄窗口丢失长区间 |
| 雪球不限流 | 5000 次/天可承受（用户确认） |
| 雪球北交所 | 920xxx 次新股返回空 reason_list（故不扫北交所） |
| akshare 备源 | 本地 ConnectionError，不如直连东财稳定 |
