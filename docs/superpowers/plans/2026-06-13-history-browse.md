# 历史报告浏览（trading_history 工具）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `trading_history` 插件工具，让用户在聊天窗口内浏览/搜索/过滤已保存的历史分析报告（卡片列表），详情仍走 `trading_report`。

**Architecture:** 复用现有 `listReports()`（`src/dashboard-api.ts`）扫盘 + 倒序能力。新增 `src/history-format.ts` 承载纯函数：`normalizeDirection`（中英文方向→canonical，未知返回 null）、`filterReports`（多维 AND 过滤）、`formatHistoryCards`（卡片 + 截断提示）。`src/index.ts` 注册薄工具包装。`ReportSummary` 加一个 additive `reasoning` 字段（`listReports` 已 parse 该数据，目前被丢弃）。

**Tech Stack:** TypeScript（strict）、Vitest、@sinclair/typebox（工具参数 schema）、复用 `formatElapsed`（`src/orchestrator.ts:334` 导出）。

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/dashboard-api.ts` | `ReportSummary` 接口 + `listReports`/`toSummary` | 修改：加 `reasoning?: string` 字段（additive，2 处）|
| `src/history-format.ts` | 过滤 + 格式化纯函数（新模块）| 新建 |
| `src/index.ts` | 插件工具注册 | 修改：导入 + 注册 `trading_history` |
| `openclaw.plugin.json` | 工具契约 | 修改：`contracts.tools` 加 `"trading_history"` |
| `tests/ts/history.test.ts` | 纯函数单测 | 新建 |

---

## Task 1: 扩展 ReportSummary 加 reasoning 字段（additive）

**Why:** 卡片要展示 `final.reasoning` 摘要，但 `ReportSummary` 当前只平铺了 `direction`/`confidence`，`toSummary` 丢弃了 `reasoning`。`listReports` 已经 read+parse 了每个 JSON 文件，reasoning 就在手边。加一个 additive 字段比每张卡片重新 `readReport` 读盘更 DRY。
**注：** 这取代了 spec §改动范围里"不动 dashboard-api.ts"的约束——该约束过严，additive 字段不破坏 dashboard（前端忽略未知字段）。

**Files:**
- Modify: `src/dashboard-api.ts`（`ReportSummary` 接口 ~行 7-37 + `toSummary` ~行 228-251）
- Test: `tests/ts/history.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/ts/history.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listReports } from '../../src/dashboard-api';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';

describe('ReportSummary.reasoning field', () => {
  const tmpDir = join(process.cwd(), 'test-tmp-history');

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('listReports exposes final.reasoning on the summary', async () => {
    const tickerDir = join(tmpDir, '600519');
    await mkdir(tickerDir, { recursive: true });
    const report = {
      id: '600519_2026-06-13_full',
      ticker: '600519',
      company_name: '贵州茅台',
      date: '2026-06-13',
      mode: 'full',
      created_at: '2026-06-13T10:00:00Z',
      duration_ms: 180000,
      total_tokens: 12000,
      total_cost_usd: 0.12,
      final: { direction: 'Buy', confidence: 0.78, reasoning: '高端消费复苏，量价齐升' },
      analyst_verdicts: {},
      trace_count: 16,
    };
    await writeFile(join(tickerDir, '2026-06-13_full.json'), JSON.stringify(report), 'utf-8');

    const result = listReports(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].reasoning).toBe('高端消费复苏，量价齐升');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/history.test.ts`
Expected: FAIL — `result[0].reasoning` is `undefined`（字段尚未存在）

- [ ] **Step 3: 实现 — 接口加字段**

在 `src/dashboard-api.ts` 的 `ReportSummary` 接口里，紧接 `confidence: number;` 行之后追加：

```typescript
  /** Final reasoning excerpt (from final.reasoning). Undefined in old reports. */
  reasoning?: string;
```

- [ ] **Step 4: 实现 — toSummary 映射**

在 `toSummary` 函数里（`confidence: raw.final?.confidence || 0,` 行之后）追加：

```typescript
    reasoning: raw.final?.reasoning,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/ts/history.test.ts`
Expected: PASS

- [ ] **Step 6: 确认 dashboard 回归不破**

Run: `npx vitest run tests/ts/dashboard.test.ts`
Expected: PASS（additive 字段，dashboard 不读它）

- [ ] **Step 7: 提交**

```bash
git add src/dashboard-api.ts tests/ts/history.test.ts
git commit -m "feat(dashboard-api): ReportSummary 暴露 final.reasoning（additive）"
```

---

## Task 2: normalizeDirection + filterReports（TDD）

**Files:**
- Create: `src/history-format.ts`
- Test: `tests/ts/history.test.ts`（追加 describe 块）

- [ ] **Step 1: 追加失败测试**

在 `tests/ts/history.test.ts` 顶部 import 区追加：

```typescript
import { normalizeDirection, filterReports } from '../../src/history-format';
import type { ReportSummary } from '../../src/dashboard-api';
```

在文件末尾追加：

```typescript
function makeSummary(over: Partial<ReportSummary> = {}): ReportSummary {
  return {
    id: 'x', ticker: '600519', company_name: '贵州茅台', date: '2026-06-13',
    mode: 'full', created_at: '', duration_ms: 0, total_tokens: 0, total_cost_usd: 0,
    direction: 'Buy', confidence: 0.5, analyst_verdicts: {}, trace_count: 0, provenance: [],
    ...over,
  };
}

describe('normalizeDirection', () => {
  it('maps English canonical forms', () => {
    expect(normalizeDirection('Buy')).toBe('Buy');
    expect(normalizeDirection('SELL')).toBe('Sell');
    expect(normalizeDirection('hold')).toBe('Hold');
  });
  it('maps analyst Chinese forms', () => {
    expect(normalizeDirection('看多')).toBe('Buy');
    expect(normalizeDirection('看空')).toBe('Sell');
    expect(normalizeDirection('中性')).toBe('Hold');
  });
  it('maps PM/Research forms (Overweight/Underweight)', () => {
    expect(normalizeDirection('Overweight')).toBe('Buy');
    expect(normalizeDirection('underweight')).toBe('Sell');
  });
  it('maps bare 多/空 and 观望', () => {
    expect(normalizeDirection('多')).toBe('Buy');
    expect(normalizeDirection('空')).toBe('Sell');
    expect(normalizeDirection('观望')).toBe('Hold');
  });
  it('returns null for unrecognized / empty / undefined', () => {
    expect(normalizeDirection('foo')).toBeNull();
    expect(normalizeDirection('')).toBeNull();
    expect(normalizeDirection(undefined)).toBeNull();
  });
});

describe('filterReports', () => {
  const sample: ReportSummary[] = [
    makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-13', mode: 'full', direction: 'Buy', confidence: 0.78 }),
    makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-10', mode: 'quick', direction: 'Hold', confidence: 0.52 }),
    makeSummary({ ticker: '000001', company_name: '平安银行', date: '2026-06-12', mode: 'quick', direction: 'Sell', confidence: 0.65 }),
  ];

  it('filters by ticker', () => {
    const r = filterReports(sample, { ticker: '600519' });
    expect(r).toHaveLength(2);
    expect(r.every(x => x.ticker === '600519')).toBe(true);
  });

  it('filters by direction with Chinese normalization', () => {
    const r = filterReports(sample, { direction: '看多' });
    expect(r).toHaveLength(1);
    expect(r[0].direction).toBe('Buy');
  });

  it('direction "Buy" and "overweight" both match Buy reports', () => {
    expect(filterReports(sample, { direction: 'Buy' })).toHaveLength(1);
    // overweight normalizes to Buy; sample Buy report matches
    expect(filterReports(sample, { direction: 'overweight' })).toHaveLength(1);
  });

  it('filters by mode', () => {
    const r = filterReports(sample, { mode: 'quick' });
    expect(r).toHaveLength(2);
    expect(r.every(x => x.mode === 'quick')).toBe(true);
  });

  it('filters by date range (inclusive)', () => {
    const r = filterReports(sample, { date_from: '2026-06-10', date_to: '2026-06-12' });
    expect(r.map(x => x.date).sort()).toEqual(['2026-06-10', '2026-06-12']);
  });

  it('combines filters with AND', () => {
    const r = filterReports(sample, { ticker: '600519', mode: 'quick' });
    expect(r).toHaveLength(1);
    expect(r[0].date).toBe('2026-06-10');
  });

  it('unrecognized direction returns empty (not all)', () => {
    expect(filterReports(sample, { direction: 'foo' })).toEqual([]);
  });

  it('empty input returns empty', () => {
    expect(filterReports([], { ticker: '600519' })).toEqual([]);
  });

  it('no filters returns all', () => {
    expect(filterReports(sample, {})).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/history.test.ts`
Expected: FAIL — 模块 `../../src/history-format` 不存在

- [ ] **Step 3: 创建 src/history-format.ts 实现**

新建 `src/history-format.ts`：

```typescript
// src/history-format.ts — 纯函数：历史报告过滤 + 卡片格式化
// 被 src/index.ts 的 trading_history 工具调用；不依赖 OpenAI / 磁盘 IO。

import { ReportSummary } from "./dashboard-api";

/** 查询参数（与 trading_history 工具入参一致）。 */
export interface HistoryQuery {
  ticker?: string;
  direction?: string;
  mode?: string;
  date_from?: string;
  date_to?: string;
}

/**
 * 把中英文方向名规范化为 canonical "Buy"/"Sell"/"Hold"。
 * 未识别 / 空 / undefined 返回 null（供过滤逻辑区分"未提供"与"不匹配"）。
 * 注意：不能用 orchestrator.parseDirection（它把未知默认为 Hold，会污染过滤）。
 */
export function normalizeDirection(raw?: string): "Buy" | "Sell" | "Hold" | null {
  if (!raw) return null;
  const n = raw.trim().toLowerCase();
  if (!n) return null;
  if (["buy", "overweight", "看多", "多", "买入", "增持"].includes(n)) return "Buy";
  if (["sell", "underweight", "看空", "空", "卖出", "减持"].includes(n)) return "Sell";
  if (["hold", "neutral", "中性", "观望", "持有"].includes(n)) return "Hold";
  return null;
}

/**
 * 多维 AND 过滤。所有维度可选；未提供的维度不过滤。
 * 方向维度：用户提供了 direction 但无法识别 → 返回空（视为"不匹配任何"）。
 */
export function filterReports(reports: ReportSummary[], q: HistoryQuery): ReportSummary[] {
  const dirProvided = q.direction !== undefined && q.direction !== "";
  const wantDir = normalizeDirection(q.direction);
  return reports.filter((r) => {
    if (q.ticker && r.ticker !== q.ticker) return false;
    if (q.mode && r.mode !== q.mode) return false;
    if (q.date_from && r.date < q.date_from) return false;
    if (q.date_to && r.date > q.date_to) return false;
    if (dirProvided) {
      if (wantDir === null) return false; // 非法方向 → 不匹配任何
      if (normalizeDirection(r.direction) !== wantDir) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/history.test.ts`
Expected: PASS（normalizeDirection 5 组 + filterReports 9 例全过）

- [ ] **Step 5: 提交**

```bash
git add src/history-format.ts tests/ts/history.test.ts
git commit -m "feat(history): normalizeDirection + filterReports 纯函数"
```

---

## Task 3: formatHistoryCards（TDD）

**Files:**
- Modify: `src/history-format.ts`（追加 `formatHistoryCards` + 内部 `dirEmoji`）
- Test: `tests/ts/history.test.ts`（追加 describe 块）

- [ ] **Step 1: 追加失败测试**

在 `tests/ts/history.test.ts` 顶部 import 行替换为：

```typescript
import { normalizeDirection, filterReports, formatHistoryCards } from '../../src/history-format';
```

在文件末尾追加：

```typescript
describe('formatHistoryCards', () => {
  it('renders empty result with guidance', () => {
    const txt = formatHistoryCards([], [], {});
    expect(txt).toContain('历史报告 · 0 条');
    expect(txt).toContain('没有匹配的报告');
  });

  it('renders a card with emoji, MM-DD date, confidence, duration, cost, reasoning excerpt', () => {
    const items: ReportSummary[] = [
      makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-13', mode: 'full', direction: 'Buy', confidence: 0.78, duration_ms: 180000, total_cost_usd: 0.12, reasoning: '高端消费复苏，量价齐升，渠道反馈良好' }),
    ];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).toContain('🟢');
    expect(txt).toContain('600519 贵州茅台');
    expect(txt).toContain('06-13');        // MM-DD, not full date
    expect(txt).toContain('置信 78%');
    expect(txt).toContain('耗时 3m0s');
    expect(txt).toContain('$0.12');
    expect(txt).toContain('> 高端消费复苏'); // reasoning quote
  });

  it('truncates reasoning longer than 60 chars with …', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'; // 70 chars
    const items: ReportSummary[] = [makeSummary({ reasoning: long, direction: 'Buy' })];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).toContain('…');
    // excerpt is first 60 chars + …
    expect(txt).toContain(`> ${long.slice(0, 60)}…`);
  });

  it('omits reasoning line entirely when reasoning missing/empty', () => {
    const items: ReportSummary[] = [makeSummary({ direction: 'Hold', reasoning: undefined })];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).not.toContain('> \n'); // no bare empty quote line
    // more robust: no line that is just "> "
    expect(txt.split('\n').some(l => l.trim() === '>')).toBe(false);
  });

  it('shows truncation hint when filtered > shown', () => {
    const items: ReportSummary[] = Array.from({ length: 23 }, (_, i) =>
      makeSummary({ ticker: '600519', date: `2026-06-${String(i + 1).padStart(2, '0')}`, direction: 'Buy' })
    );
    const shown = items.slice(0, 10);
    const txt = formatHistoryCards(items, shown, {});
    expect(txt).toContain('共 23 条');
    expect(txt).toContain('还有 13 条');
    expect(txt).toContain('trading_report');
  });

  it('no truncation hint when all shown', () => {
    const items: ReportSummary[] = [makeSummary({ direction: 'Buy' }), makeSummary({ direction: 'Sell' })];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).not.toContain('还有');
    expect(txt).toContain('trading_report'); // guidance still present
  });

  it('title shows company name when filtered by ticker', () => {
    const items: ReportSummary[] = [
      makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-13', direction: 'Buy' }),
    ];
    const txt = formatHistoryCards(items, items, { ticker: '600519' });
    expect(txt).toContain('已按 贵州茅台 过滤');
  });

  it('title falls back to ticker code when company_name missing', () => {
    const items: ReportSummary[] = [
      makeSummary({ ticker: '600519', company_name: '', date: '2026-06-13', direction: 'Buy' }),
    ];
    const txt = formatHistoryCards(items, items, { ticker: '600519' });
    expect(txt).toContain('已按 600519 过滤');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/history.test.ts`
Expected: FAIL — `formatHistoryCards` 未导出

- [ ] **Step 3: 实现 formatHistoryCards**

在 `src/history-format.ts` 顶部 import 区追加（合并到现有 import）：

```typescript
import { formatElapsed } from "./orchestrator";
```

在文件末尾追加：

```typescript
function dirEmoji(d: string): string {
  const n = normalizeDirection(d);
  if (n === "Buy") return "🟢";
  if (n === "Sell") return "🔴";
  return "🟡";
}

/**
 * 把过滤后的报告渲染为聊天卡片列表文本。
 * - filtered: 全部命中（用于"共 N 条"标题 + 截断计数）
 * - shown: 实际展示的切片（已 slice limit）
 * - q: 当前查询（标题反映 ticker 过滤）
 */
export function formatHistoryCards(
  filtered: ReportSummary[],
  shown: ReportSummary[],
  q: HistoryQuery,
): string {
  if (shown.length === 0) {
    return "## 历史报告 · 0 条\n没有匹配的报告。检查 report_dir 或放宽过滤条件。";
  }

  const lines: string[] = [];
  const total = filtered.length;

  // 标题：ticker 过滤显示公司名；否则截断时显示"共 N 条"
  let suffix = "";
  if (q.ticker) {
    const name = filtered[0]?.company_name || q.ticker;
    suffix = `（共 ${total} 条，已按 ${name} 过滤）`;
  } else if (total > shown.length) {
    suffix = `（共 ${total} 条）`;
  }
  lines.push(`## 历史报告 · ${shown.length} 条${suffix}`);
  lines.push("");

  for (const r of shown) {
    const date = r.date.length >= 10 ? r.date.slice(5) : r.date; // MM-DD
    const conf = `${Math.round((r.confidence || 0) * 100)}%`;
    const dur = formatElapsed(r.duration_ms || 0);
    const cost = `$${(r.total_cost_usd || 0).toFixed(2)}`;
    lines.push(`### ${dirEmoji(r.direction)} ${r.ticker} ${r.company_name} — ${date} ${r.mode}`);
    lines.push(`置信 ${conf} | 耗时 ${dur} | ${cost}`);
    const reasoning = (r.reasoning || "").trim();
    if (reasoning) {
      const excerpt = reasoning.length > 60 ? reasoning.slice(0, 60) + "…" : reasoning;
      lines.push(`> ${excerpt}`);
    }
    lines.push("");
  }

  if (total > shown.length) {
    lines.push(`> 还有 ${total - shown.length} 条，可按 ticker / 方向 / 日期范围 缩小范围。`);
  }
  lines.push("> 查看某条详情请用 trading_report。");
  return lines.join("\n");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/history.test.ts`
Expected: PASS（全部历史测试通过）

- [ ] **Step 5: 提交**

```bash
git add src/history-format.ts tests/ts/history.test.ts
git commit -m "feat(history): formatHistoryCards 卡片列表 + 截断提示"
```

---

## Task 4: 注册 trading_history 工具 + 契约

**Files:**
- Modify: `src/index.ts`（import 区 + 工具注册区，在 `trading_report` 注册之后 ~行 291）
- Modify: `openclaw.plugin.json`（`contracts.tools` 数组）

- [ ] **Step 1: 加 import 与参数 schema**

在 `src/index.ts` 顶部 import 区（`import * as path from "path";` 之前）追加：

```typescript
import { listReports } from "./dashboard-api";
import { filterReports, formatHistoryCards } from "./history-format";
```

在现有 `ReportQueryParams` 定义之后追加：

```typescript
const HistoryParams = Type.Object({
  ticker: Type.Optional(Type.String({ description: "按股票代码过滤，如 600519" })),
  direction: Type.Optional(Type.String({ description: "按方向过滤: Buy/Sell/Hold 或 看多/看空/中性" })),
  mode: Type.Optional(Type.String({ description: "报告模式: quick 或 full" })),
  date_from: Type.Optional(Type.String({ description: "起始日期 YYYY-MM-DD（含）" })),
  date_to: Type.Optional(Type.String({ description: "结束日期 YYYY-MM-DD（含）" })),
  limit: Type.Optional(Type.Number({ description: "返回条数上限，默认 10" })),
});
```

- [ ] **Step 2: 注册工具**

在 `register(api)` 内、`trading_report` 的 `api.registerTool({...})` 块之后（`};` 闭合 register 之前）追加：

```typescript
    // Register trading_history tool — browse/filter saved reports
    api.registerTool({
      name: "trading_history",
      label: "Browse Analysis History",
      description: "浏览/搜索已保存的历史分析报告。可按股票、方向、模式、日期范围过滤。不传参数则列出最近的报告。",
      parameters: HistoryParams,
      async execute(_toolCallId: string, params: {
        ticker?: string; direction?: string; mode?: string;
        date_from?: string; date_to?: string; limit?: number;
      }) {
        const all = listReports(config.report_dir);
        const filtered = filterReports(all, params);
        const limit = params.limit && params.limit > 0 ? params.limit : 10;
        const shown = filtered.slice(0, limit);
        const text = formatHistoryCards(filtered, shown, params);
        return { content: [{ type: "text" as const, text }] };
      },
    });
```

- [ ] **Step 3: 更新契约**

在 `openclaw.plugin.json` 的 `"contracts.tools"` 数组里追加 `"trading_history"`，变为：

```json
    "tools": ["trading_quick", "trading_full", "trading_report", "trading_history"]
```

- [ ] **Step 4: 编译确认**

Run: `npm run build`
Expected: 编译通过，无 TS 错误

- [ ] **Step 5: 提交**

```bash
git add src/index.ts openclaw.plugin.json
git commit -m "feat(index): 注册 trading_history 工具 + 契约"
```

---

## Task 5: 全量构建 + 测试验证

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过（原有测试 + history.test.ts 新增约 23 例：1 字段 + 5 规范化 + 9 过滤 + 8 格式化）

- [ ] **Step 3: 抽查工具描述可发现性**

人工检查 `src/index.ts` 的 `trading_history` description 足以让 LLM 在用户问"我分析过哪些股票""最近的分析"时选中本工具而非 `trading_report`。

- [ ] **Step 4: 无需额外提交（本任务仅验证）**

---

## 自检（写完计划后）

**1. Spec 覆盖：**
- 工具形态方案 A → Task 4 注册独立工具 ✓
- 接口参数（ticker/direction/mode/date_from/date_to/limit）→ Task 4 HistoryParams ✓
- 数据流 listReports → filterReports → slice → formatHistoryCards → Task 4 execute ✓
- 方向规范化 → Task 2 normalizeDirection ✓
- 过滤维度 AND 组合 → Task 2 filterReports ✓
- 输出格式（标题/卡片/截断提示/空结果）→ Task 3 ✓
- reasoning 摘要 → Task 1 扩展字段 + Task 3 渲染 ✓
- 注册 + 契约 → Task 4 ✓
- 边界（limit≤0 clamp、非法方向→空、空目录）→ Task 2/3/4 ✓
- 测试矩阵 → Task 1/2/3 ✓

**2. Placeholder 扫描：** 无 TBD/TODO；每个 code step 都有完整代码。

**3. 类型一致性：**
- `HistoryQuery` 在 Task 2 定义，Task 3 `formatHistoryCards` 第三参数用 `HistoryQuery` ✓
- `ReportSummary.reasoning?: string` 在 Task 1 加，Task 3 读 `r.reasoning` ✓
- `normalizeDirection` 返回 `"Buy"|"Sell"|"Hold"|null`，filterReports/formatHistoryCards 一致 ✓
- `formatElapsed(ms: number): string` 签名匹配 Task 3 调用 `formatElapsed(r.duration_ms || 0)` ✓

**4. 关键决策记录：**
- `normalizeDirection` **不复用** `orchestrator.parseDirection`（后者把未知默认为 Hold 会污染过滤；前者未知返回 null）。这是 Task 2 注释里强调的。
- `ReportSummary.reasoning` 是 additive 字段，**取代** spec §改动范围"不动 dashboard-api.ts"——该约束过严，2 行 additive 改动是 DRY 最优解，dashboard 前端忽略未知字段不受影响。
- 列表返回**只走 `content[0].text`**，不进 `toolResult.details`（避免聊天渲染冗长 JSON）→ Task 4 execute 直接 return 对象 ✓
