# 交易日处理设计（雪球数据日期驱动）

> 日期：2026-06-18
> 状态：设计（待评审）
> 范围：watchlist 管道的「自然日 vs 交易日」「数据日期 vs 自然日」问题
> 关联：[`2026-06-17-watchlist-stock-pool-design.md`](./2026-06-17-watchlist-stock-pool-design.md)（第一期管道）

## 1. 背景与问题

第一期管道按**自然日**驱动：`snapshot` 用 `now()` 当文件名，`diff` 用文件名日期当匹配锚点。但雪球异动数据有两个本质特性，导致自然日驱动会出错：

1. **雪球数据是纯交易日驱动的**——周末 / 节假日完全没有异动数据（实测：`reason.timestamp` 落在周六周日 = 0% / 0%）。
2. **数据日期 ≠ 自然日**——雪球当日异动归因是**盘后**才生成的（约 20:00 后）。所以同一自然日 06-18：
   - 中午 12:00 跑 → 雪球最新数据还停在 06-17
   - 晚上 20:30 跑 → 雪球 06-18 数据才出来

当前管道对这两点没有任何处理，现在能跑对纯粹是「恰好盘后人工跑了」——一旦 cron 定时、节假日跑、或中午跑，就坏。

## 2. 现状漏洞

假设 06-18 是节假日，或 06-18 中午 12 点跑：

| 位置 | 现状代码 | 问题 |
|------|----------|------|
| `snapshot.py:87` | `scan_date = now()` | 文件名 `raw/2026-06-18.json`，但雪球数据最新还是 06-17，文件名撒了谎 |
| `diff.ts:30` | `todayStartMs = Date.parse(today.end_date…)` | 用**文件名日期**（06-18）当锚点；A/B 类判定（`diff.ts:40,51`）要求 `timestamp/end === 06-18`，但数据里根本没有 06-18 → **A 类、B 类全空，真实异动全丢** |
| `diff-cli.ts:16` | `findLatestBaseline` 按**自然日**找 | 节假日跑出的空快照会进 baseline 链，污染下一交易日的对比 |

## 3. 方案演进与取舍

设计过程中评估并**否决**了三个方向：

### 3.1 否决：交易日历驱动（方案 B / C 的日历部分）

引入 A 股交易日历（akshare `tool_trade_date_hist_sina`），靠日历 + 时钟判定「该不该跑」。
- **否决理由**：日历只是「预筛」，雪球数据本身才是根本；A 股法定节假日每年变动，日历要持续维护；且仍需另一套机制判断雪球是否真更新。多一个会过期的依赖，收益小。

### 3.2 否决：盘后时间判定（`--after 20:00`）

靠「现在到晚上 8 点了吗」判断盘后数据是否就绪。
- **否决理由**：8:00 是经验值，雪球实际更新时间会漂移；间接判断（看手表）永远不如直接判断（问雪球）；还多一个用户要记的参数。

### 3.3 否决：抽样探测 data_date

全扫前先抽样 5~10 只「热闹股」，看它们的 `max(range.end)` 判断雪球更新进度。
- **否决理由（关键）**：抽样股的异动 ≠ 雪球更新进度。超大盘股（平安银行、茅台、宁德时代）平日**反而没异动**（稳重，只有剧烈波动才异动），抽它们会误判「雪球没更新」（实际只是这几只今天没动静）。**抽样判断的是「这几只有没有今天异动」，不是「雪球数据更新到哪天」，两者不是一回事。** 全市场 5207 只里必然有今天异动的股，所以只有全市场算出的 `data_date` 才是金标准。

### 3.4 最终：全扫 + data_date 现算 + 幂等

放弃所有「快速预判要不要扫」的手段，直接全扫，让雪球数据自己说话。`data_date` 由全市场数据算出，命名文件、做 diff 锚点、做幂等判定。

## 4. 最终设计

### 4.1 核心概念：`data_date`

**雪球当前最新交易日**，由数据算出：

```
data_date = max( 全市场所有 reason.timestamp ∪ 所有 range.end ) → 转「某天 00:00 北京」的日期
```

它是**计算属性，不持久化**——哪里需要哪里现算（命名文件、diff 锚点、幂等检查）。不写进 raw 的 stocks（stocks 保持雪球原样，不被派生值污染）。

> 实测依据：`reason.timestamp` 和 `range.end` 的时间精度**只有 `00:00:00` 一种**（北京时间），所以 `max` 得到的就是某天 00:00，可直接当 diff 的精确匹配锚点。

### 4.2 snapshot 流程

```
snapshot 启动
  scan_target = --date 或今天          ← 仅作「查询窗口上限」，不是文件名
  query_end   = scan_target 23:59:59
  query_begin = scan_target 前推 14 月
  │
  ├─ 全扫 5207 只（query_begin, query_end）
  │    雪球返回什么存什么（今天没数据就返回昨天的，原样进内存）
  │
  ├─ data_date = max(内存数据所有 timestamp ∪ range.end) → 日期
  │    （边界：若 max=0，说明没抓到任何异动数据 → 报错退出，不写文件）
  │
  ├─ raw/{data_date}.json 已存在？
  │    ├─ 是 → 不写，提示「{data_date} 已处理，跳过」（幂等）
  │    └─ 否 → 写 raw/{data_date}.json
  └─ 完成
```

**raw 文件内容**（元信息全部基于 `data_date`，自洽；stocks 雪球原样）：
- `scan_date = data_date`（= 文件名）
- `end_date = data_date`
- `begin_date = data_date 前推 14 月`，`begin_ms / end_ms` 基于 `data_date` 重算
- `window_months / scanned / succeeded / failed`
- `stocks`：雪球原样（**无 `data_date` 字段**）

### 4.3 diff 流程

```
diff
  today    = raw/{--date 或最新快照}.json
  todayStartMs = 从 today.stocks 现算 max(reason.timestamp ∪ range.end)   ← 取自数据，不读 end_date 字段
  baseline = raw 目录里上一个已存在的快照（按日期排的前一个）
  computeDiff(today, baseline)  ← 用现算的 todayStartMs 当锚点
```

`todayStartMs` 从 `today.stocks` 现算，意味着**无论 raw 文件名 / 元信息字段怎么标，锚点永远跟随实际数据**。这也是老 raw（无 `data_date` 字段、文件名是自然日）能直接用的原因。

baseline 找「上一个已存在的快照」——因为 raw 文件名已经是交易日（`data_date`），目录里日期相邻的快照天然就是相邻交易日，**节假日没有快照文件，自动跳过**，无需日历。

### 4.4 幂等语义

`raw/{data_date}.json` 存在即跳过，覆盖所有「无新数据」场景：

| 场景 | data_date | 行为 |
|------|-----------|------|
| 交易日盘后第一次跑 | 今天 | 文件不存在 → 全扫写盘 |
| 同一天重复跑 | 今天 | 文件已存在 → 跳过 |
| 盘中 / 盘前跑 | 昨天 | 文件已存在 → 跳过（雪球未更新到今天）|
| 节假日跑 | 上一交易日 | 文件已存在 → 跳过 |

**代价**：因为不再有「快速预判」手段，重复跑 / 盘中跑 / 节假日跑都会先**全扫 15 分钟**，再发现 `data_date` 没变 / 已存在而跳过——白扫。但**主场景（每天盘后跑一次）无额外代价**：正常就是扫一次、`data_date` 是新的、写文件。只有异常触发（重复 cron、手动重跑、调试）才多等 15 分钟。

## 5. 各文件改造

### `skills/watchlist/scripts/snapshot.py`
- `scan_date` 含义从「文件名」改为「查询窗口上限」（`scan_target`）
- 全扫后从内存数据算 `data_date`
- 新增幂等检查：`raw/{data_date}.json` 存在则不写、提示退出
- raw 写入时 `scan_date / end_date / begin_date / begin_ms / end_ms` 全部基于 `data_date`（而非 `scan_target`）
- 文件名用 `data_date`
- `--limit`（调试用）下 `data_date` 可能不准（只扫 N 只）→ 文档标注「仅供调试，正式跑不用」

### `src/watchlist/diff.ts`（`computeDiff`）
- 删除 `todayStartMs = Date.parse(today.end_date + …)`
- 改为 `todayStartMs` = 从 `today.stocks` 现算 `max(reason.timestamp ∪ range.end)`
- 其余 A / B1 / B2 判定逻辑不变（仍用 `=== todayStartMs` 精确匹配）

### `src/diff-cli.ts`
- `--date` 默认值从「今天（自然日）」改为「raw 目录最新快照」（即最新 `data_date`）
- `findLatestBaseline` 基本不变（找 `d < today` 的最大日期 = 上一交易日快照）

### `src/scan-all-cli.ts`
- `snapshot` 跑完（自带幂等）
- `diff` / `candidates` 不带 `--date`，自动处理最新快照
- `--date` 透传给 `snapshot` 当查询上限（回补历史）

### `src/watchlist/candidates.ts` + `src/candidates-cli.ts`
- **不改**。`buildCandidates` 从 diff 取，与日期无关。

## 6. CLI 参数

| 命令 | 参数 | 说明 |
|------|------|------|
| `snapshot` | `--date` `--concurrency` `--limit` `--watchlist-dir` | `--date` = 查询窗口上限（回补）/ 默认今天；幂等自动 |
| `diff` | `--date` `--baseline` | `--date` 默认 = 最新快照 |
| `candidates` | `--date` | 默认 = 最新快照 |
| `scan-all` | `--date` `--concurrency` | `--date` 透传给 snapshot |

**无新增参数**：没有交易日历参数、没有 `--after`。

## 7. 迁移策略（现有 06-16 / 06-17 产物）

**核心原则：raw 是不可变事实，不动；diff / derived 是解读，从 raw 重跑。**

| 层 | 现有产物 | 处理 |
|----|----------|------|
| `raw/` | 06-16.json、06-17.json | **不动**，原样保留。`data_date` 现算，无字段也能用；且 06-16 的雪球数据已抓不回，不能重跑 |
| `diff/` | 06-16.json（37M 旧逻辑）、06-17.json（203K 新逻辑） | **用新 `computeDiff` 从现有 raw 重跑覆盖** |
| `derived/` | 06-16（损坏 null）、06-17（正常） | **用新 `buildCandidates` 从新 diff 重跑覆盖** |

06-16 / 06-17 的 raw 文件名恰好是交易日 = `data_date`（都是盘后抓的交易日），新模型下文件名合法，直接能用。

## 8. 测试策略

核心逻辑全用假数据单测，不碰网络：

- `computeDataDate`（新算 `data_date` 的函数）：假 raw，验证 `max(timestamp ∪ range.end)` 算对；空数据边界（max=0 报错）
- `computeDiff`：假 today / baseline，验证「数据日期 < 文件名日期」场景（节假日 / 盘中）下锚点跟随数据、异动不被误丢
- snapshot 幂等：mock `raw/{data_date}.json` 存在 → 不写、提示退出
- 现有 diff / candidates 测试用例随 `computeDiff` 改动同步更新

## 9. 不做的事（YAGNI）

- 交易日历（3.1 否决）
- 盘后时间判定 / `--after`（3.2 否决）
- 抽样探测（3.3 否决，不可靠）
- `data_date` 持久化字段（违反 raw 不可变 + 雪球原样原则）
- 向后兼容老格式的代码分支（`data_date` 现算，新老 raw 一视同仁，零兼容代码）
- 板块共振 / LLM 加工 / 全自动调度（第二期）

## 10. 实测依据

设计阶段从 `raw/2026-06-17.json`（5207 股）实测：

| 验证项 | 结果 | 支撑的决策 |
|--------|------|-----------|
| `reason.timestamp` 落在周六/周日 | 0% / 0% | 雪球纯交易日驱动，节假日无数据 |
| `range.end` / `timestamp` 时分秒种类 | 只有 `00:00:00` | `=== todayStartMs` 精确匹配可靠；`max` 即 data_date |
| 06-17 快照最新 `range.end` | 2026-06-17（463 个） | 该快照盘后抓、含当日；验证盘后语义 |
| range.end 最新日期序列 | 06-17(三) 06-16(二) 06-15(一) 06-12(五) 06-11(四)，周末跳过 | 文件名=交易日，baseline 自动跳过节假日 |
| 唯特偶 SZ301319 抽查 | baseline LONG end=06-08 → today end=06-17，同 begin，pct 456→518 | B1 延续型判定正确，候选质量可信 |

## 11. 实施记录（2026-06-18）

6 个任务 TDD 完成，commit 链：`2713e32` Task1 → `e93a702` Task2 → `1a61257` Task3 → `99f7c79` Task4 → `5ac5757` Task5 → Task6 迁移（产物在 git 外）。测试：TS 470 + Python 92 全过。final subagent review 判定 READY。

### 实施踩的坑

1. **data_date 现算破坏原有测试语义**：`computeDiff` 改现算后，2 个原测试（"B1 dropped: end 不是今天"、"B2 dropped: end < today"）的 today 数据里 `TODAY_MS` 不再是最大值，`todayStartMs` 变成被测股自己的 range.end，导致被测股误判入选。修复：测试加 DUMMY 股（`percent:-1` 不被选中 + `end:TODAY_MS` 锚定 `todayStartMs`），保留原测试意图。

2. **CLI 顶层 `main()` 阻止单元测试 import**：`diff-cli.ts` / `candidates-cli.ts` 在模块顶层调 `main()`，import 做单测时触发 main → `process.exit`。修复：加 `if (require.main === module) main()` CommonJS 守卫（直接运行跑 main，被 import 不跑）。

3. **Size 预估严重偏低**：§3 预估 raw 5-8 MB/天，实测 **32 MB/天**（4-6 倍）。原因见 §12.1。

4. **限额导致部分任务 controller 直接做**：Task1 有完整 subagent 两道 review；Task2 spec-review subagent 撞 5h API 限额失败、改 controller 读码 review；Task3-6 controller 直接实现，后补 final subagent review 把关（确认达同等质量）。

## 12. 已知问题与未来工作

### 12.1 raw 膨胀（已知，用户确认暂不处理）

**现状**：raw 每个交易日 +1 个文件，约 **32 MB/个**，累积。一年约 250 交易日 × 32M ≈ **8 GB**。当前 64M（2 天）。

**原因**：每个 raw 是全市场 5207 股的完整 14 个月异动历史（雪球原样），约 2901 股带历史区间、活跃股最多 22 个 range（含 `summary/points/url/title` 字段）。**相邻快照大量重叠冗余**——同一只股 06-16 之前的历史在 06-16 和 06-17 两个文件里各存一遍，真正"新的"只有当天那点异动（diff 才几百 K）。

**方向（未来再做）**：
- **保留策略**：raw 只留最近 N 天（N=7~14，够 baseline + 短期重算），旧的删除或归档。8GB → 几百 M。
- **gzip 压缩**：raw 是 JSON 文本，压缩率高，32M → 约 3-5M。与保留策略叠加。
- **不推荐增量存储**：只存"相对上次的 diff"最省空间，但破坏"完整快照"原则、重算 diff 要拼接，复杂度不值得。

**注意**：膨胀的是 raw（事实层），不是 diff/derived（产物层，几百 K/天）。日常用的是 candidates，raw 只在重算 diff 时读。当前 64M 离 8GB 远，暂不处理。

### 12.2 其他

- **Task1 测试 DUMMY 股字段**（可选清理）：DUMMY 股的 range 缺 `summary/points` 字段（code review 指出，not blocker，不影响功能）。
- **第二期**：LLM 行业归类、板块共振聚合、全自动 cron 调度。
