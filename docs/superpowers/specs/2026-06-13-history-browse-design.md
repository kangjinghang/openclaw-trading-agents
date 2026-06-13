# 历史报告浏览设计（trading_history 工具）

日期: 2026-06-13

## 概述

新增 `trading_history` 工具，让用户在聊天窗口内浏览/搜索已保存的历史分析报告。支持列出全部（最近优先）、按股票查、按方向/模式/日期范围过滤。详情仍走现有 `trading_report` 工具，二者职责分离。

**明确不做**：交互式翻页（offset 状态化）、复杂选号查详情。YAGNI——截断 + 过滤提示已足够，详情已有专用工具。

## 背景：现状与缺口

报告存盘结构完整：`{report_dir}/{ticker}/{date}_{mode}.json`（summary）+ detail 目录。

- `trading_report` 工具**必须提供精确 ticker + date**，没有列表/发现能力。
- `dashboard-api.ts` `listReports()` 已能扫描全部报告并按日期倒序，但只被独立的 `dashboard.js` HTTP 服务消费，**未暴露为插件工具**。
- `src/index.ts` 结尾 `formatSummary` 只提示 `trading_report`，从不提如何"看看我都分析过哪些"。

**缺口**：聊天窗口内无法回答"我最近分析过哪些股票""600519 分析过几次""上周看多的有哪些"。用户必须知道精确 ticker+date 才能查任何历史。

## 方案

### 工具形态：新增独立工具（方案 A）

`trading_history` 专用列表/过滤，与 `trading_report` 职责分离：

| 工具 | 意图 | 输入 | 输出 |
|------|------|------|------|
| `trading_report` | 精确查单条 | ticker + date（必填）| 完整详情对象 |
| `trading_history`（新） | 浏览/过滤/列表 | 全可选过滤参数 | 卡片列表文本 |

两个工具意图分明，LLM 按用户意图选用，返回类型不同不混淆。`listReports()` 保持不动（dashboard 仍消费全量），过滤逻辑放在工具执行闭包里。

### 工具接口

```
参数（全部可选）:
  ticker?     string   按股票过滤，如 "600519"
  direction?  string   按方向过滤: Buy/Sell/Hold 或 看多/看空/中性（规范化）
  mode?       string   "quick" | "full"
  date_from?  string   YYYY-MM-DD（含）
  date_to?    string   YYYY-MM-DD（含）
  limit?      number   返回条数上限，默认 10
```

### 数据流

```
trading_history.execute
  → listReports(reportDir)          // 已存在，扫盘 + 按日期倒序
  → filterReports(all, params)      // 闭包内纯函数：ticker/direction/mode/date AND 组合
  → 记录 filteredCount（过滤后总数，截断前）
  → slice(0, limit)
  → formatHistoryCards(filtered, shown, params)
  → { content: [{ type: "text", text }] }   // 只返文本，不进 details 通道
```

### 方向规范化

用户/LLM 可能输入中英文任一形式，需统一比对：

```
规范化映射（大小写不敏感）:
  buy / overweight / 看多 / 多   → "Buy"
  sell / underweight / 看空 / 空 → "Sell"
  hold / 中性 / 观望              → "Hold"
```

比对时：把用户输入的 `direction` 规范化为 canonical 值，再与 `ReportSummary.direction`（`toSummary` 已从 `final.direction` 取出）做大小写不敏感比较。`parseDirection()`（`orchestrator.ts` 现有）已做中文→canonical 映射，复用其映射表；规范化函数新建一小段，含 `overweight/underweight`（只在 PM/Research 阶段出现）也归到 Buy/Sell，保证过滤一致。

### 过滤维度（全部可选，AND 组合）

| 参数 | 字段 | 规则 |
|------|------|------|
| `ticker` | `summary.ticker` | 精确相等 |
| `direction` | `summary.direction` | 规范化后相等 |
| `mode` | `summary.mode` | 精确相等（"quick"/"full"） |
| `date_from` | `summary.date` | `>=`（字符串比较，YYYY-MM-DD 字典序=时间序）|
| `date_to` | `summary.date` | `<=` |

字段安全：所有字段缺失时容错（`toSummary` 已对 `direction` 兜底 `"Hold"`）。

### 输出格式

**标题行**（反映过滤条件 + 命中数）：

```
## 历史报告 · 8 条（共 23 条，已按 贵州茅台 过滤）
```

无过滤时简化为 `## 历史报告 · 8 条`。`ticker` 参数是代码（如 `600519`），但标题显示公司名——公司名从首个匹配报告的 `company_name` 解析；无匹配或 `company_name` 缺失时回退显示 ticker 代码本身（如 `已按 600519 过滤`）。

**每张卡片**（字段全部取自 `ReportSummary`，无需额外读盘）：

```
### 🟢 600519 贵州茅台 — 06-13 full
置信 78% | 耗时 3m | $0.12
> 高端消费复苏，量价齐升…
```

字段来源与处理：
- emoji：复用 `index.ts` 现有 `directionEmoji()`（🟢 Buy / 🔴 Sell / 🟡 Hold）
- 日期：`MM-DD`（从 `date` = `YYYY-MM-DD` 取后 5 位），节省宽度
- 置信/耗时/成本：`confidence`×100、`formatElapsed(duration_ms)`（复用 orchestrator 导出）、`total_cost_usd`
- 引用摘要：`final.reasoning.slice(0, 60)` + `…`；缺失则整行省略

**截断提示**（`filteredCount > shownCount` 时尾部追加）：

```
> 还有 13 条，可按 ticker / 方向 / 日期范围 缩小范围。
> 查看某条详情请用 trading_report。
```

未截断时只留末尾那行 `trading_report` 引导。

**空结果**：

```
## 历史报告 · 0 条
没有匹配的报告。检查 report_dir 或放宽过滤条件。
```

**返回通道**：列表只返回 `content[0].text`，**不进 `toolResult(data)` 的 `details` 通道**——卡片列表是给人看的文本，避免聊天侧渲染冗长 JSON。

### 注册与契约

**`src/index.ts`**：在 `trading_report` 注册之后追加 `trading_history`，与现有工具同构——读 `config.report_dir`。

```
api.registerTool({
  name: "trading_history",
  label: "Browse Analysis History",
  description: "浏览/搜索已保存的历史分析报告。可按股票、方向、模式、日期范围过滤。不传参数则列出最近的报告。",
  parameters: HistoryParams,   // 全可选
  async execute(_id, params) {
    const all = listReports(config.report_dir);
    const filtered = filterReports(all, params);
    const limit = params.limit && params.limit > 0 ? params.limit : 10;
    const shown = filtered.slice(0, limit);
    const text = formatHistoryCards(filtered, shown, params);
    return { content: [{ type: "text" as const, text }] };
  },
});
```

**`openclaw.plugin.json`**：`contracts.tools` 数组追加 `"trading_history"`。

### 边界处理

| 情况 | 行为 |
|------|------|
| `report_dir` 不存在/为空 | `listReports` 已返回 `[]` → 走空结果文案 |
| 报告 JSON 损坏 | `listReports` 已 try/catch 跳过 → 不崩 |
| `limit ≤ 0` | clamp 到默认 10（防 LLM 传 0 或负数）|
| `limit` 过大 | 不设硬上限——`listReports` 本身扫全盘，切片成本可忽略；用户要 50 条就给 50 |
| 方向/模式值非法 | 规范化失败 → 该维度视为"不匹配"，自然返回空（不报错，让用户自己调参）|
| `date_from > date_to` | 过滤自然返回空，不额外校验（YAGNI）|

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/history-format.ts`（新）| `filterReports` + `formatHistoryCards` + `normalizeDirection` 纯函数，便于单测 import |
| `src/index.ts` | 导入上述函数 + 注册 `trading_history` 工具 |
| `openclaw.plugin.json` | `contracts.tools` 追加 `"trading_history"` |
| `tests/ts/history.test.ts`（新）| 过滤/规范化/格式化单测 |

不动：`dashboard-api.ts`、`dashboard.ts`、`report-store.ts`、`orchestrator.ts`、prompts、types。

## 测试

新增 `tests/ts/history.test.ts`（纯函数单测，无 LLM/磁盘 IO）：

**`filterReports`**：
- ticker 过滤：3 条不同股票，传 `"600519"` → 只剩该股 2 条
- direction 规范化：传 `"看多"` / `"Buy"` / `"overweight"` → 都命中 direction=`Buy` 的报告
- mode 过滤：传 `"full"` → 只剩 full
- 日期范围：`date_from:"2026-06-10"` + `date_to:"2026-06-12"` → 区间内 3 条
- AND 组合：ticker + direction 同时传 → 两条件都满足才返回
- 方向值非法（`"foo"`）→ 返回空，不抛
- 空数组输入 → 返回空数组

**`formatHistoryCards`**：
- 正常卡片含 emoji、日期 `MM-DD`、置信 `78%`、耗时、成本、reasoning 截断 `…`
- reasoning 缺失 → 整行省略，不出现空 `>`
- 截断提示：`filteredCount=23, shownCount=10` → 含"还有 13 条"+"trading_report"引导
- 未截断（`filteredCount=3`）→ 只留 `trading_report` 引导，无"还有"
- 空结果 → "0 条" + "没有匹配的报告"
- 标题行反映过滤条件（ticker 存在时含公司名）

**回归**：现有 `tests/ts/dashboard.test.ts`（测 `listReports`）保持通过——未改 `listReports`。

**集成**（可选，低优先）：在 `integration.test.ts` 加一例——造几份报告 JSON 到临时 `report_dir`，调用工具 execute，断言文本含某 ticker。若成本高可省，靠单测覆盖。

## 不做的事

- **交互式翻页（offset 状态化）**：截断 + 过滤提示已足够；详情已有 `trading_report`。
- **复杂选号查详情**：用户看到列表后自己用 `trading_report` + ticker+date 查详情。
- **改 `listReports` 签名**：dashboard 仍要全量，过滤放在工具层。
- **列表进 `details` 通道**：卡片列表是文本，塞 JSON 会冗长。
- **limit 硬上限**：`listReports` 扫全盘成本可忽略，用户要多少给多少（仅 clamp ≤0）。
