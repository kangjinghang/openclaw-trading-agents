# 分析过程节奏感知（总进度 + 已用时间）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 quick/full 分析增加一条常驻"总进度 % + 累计已用时间"原地更新行（id=`overall-progress`），让用户在漫长的分析师阶段有节奏感。只产出准确信号，不做 ETA 预估。

**Architecture:** 在 `src/orchestrator.ts` 内新增轻量 `ProgressTracker` 类，封装"开始时间 + 时长加权映射 + 单调 emit"。两个主函数（`runQuickAnalysis`/`runFullAnalysis`）各自用不同权重映射建 tracker，在各阶段边界 emit；共享的 `runAnalystPhase` 多收一个可选 `tracker` 参数，每个分析师完成时按 `completedCount/7` 推进。复用现有 `makeLogProgress` 闭包的第 4 参数 `id`（`analyst-progress` 行已用此机制），无需改 `makeLogProgress` 本身。

**Tech Stack:** TypeScript (strict), Vitest, OpenClaw `onUpdate`/`AgentToolProgress`（已接入）。

Spec: `docs/superpowers/specs/2026-06-13-progress-rhythm-design.md`

---

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `src/orchestrator.ts` | 分析编排（唯一源码改动） | 新增 `pctInRange`/`formatElapsed`/`ProgressTracker`/`QUICK_WEIGHTS`/`FULL_WEIGHTS`（放在 `makeLogProgress` 之后，~line 326）；`runAnalystPhase` 加 `tracker?` 参数 + 3 处 emit；`runQuickAnalysis`/`runFullAnalysis` 建 tracker + 各阶段 emit + 传参 |
| `tests/ts/progress-tracker.test.ts` | ProgressTracker + 辅助函数单测（新建） | Task 1/2 写入 |
| `tests/ts/integration.test.ts` | 端到端进度断言 | Task 3/4 各加 1 个用例 |

**不动的文件**：`types.ts`、所有 prompts、`index.ts`、其他源文件。不破坏现有 `analyst-progress` 行与所有 append 行。

---

## Task 1: 纯辅助函数 `pctInRange` + `formatElapsed`

**Files:**
- Create: `tests/ts/progress-tracker.test.ts`
- Modify: `src/orchestrator.ts`（在 `type LogProgressFn = ReturnType<typeof makeLogProgress>;` 之后，~line 325，新增 + 导出两个函数）

- [ ] **Step 1: 写失败测试**

创建 `tests/ts/progress-tracker.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { pctInRange, formatElapsed } from '../../src/orchestrator';

describe('pctInRange', () => {
  it('computes percentage within range by fraction', () => {
    expect(pctInRange([5, 80], 0)).toBe(5);
    expect(pctInRange([5, 80], 0.5)).toBe(43);   // 5 + 75*0.5 = 42.5 → Math.round → 43
    expect(pctInRange([5, 80], 1)).toBe(80);
  });

  it('clamps frac outside [0,1] to endpoints', () => {
    expect(pctInRange([5, 80], -0.5)).toBe(5);
    expect(pctInRange([5, 80], 1.5)).toBe(80);
  });

  it('handles zero-width range', () => {
    expect(pctInRange([50, 50], 0.3)).toBe(50);
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45000)).toBe('45s');
    expect(formatElapsed(59000)).toBe('59s');
  });

  it('formats >=60s as m:ss', () => {
    expect(formatElapsed(60000)).toBe('1m0s');
    expect(formatElapsed(90000)).toBe('1m30s');
    expect(formatElapsed(240000)).toBe('4m0s');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/progress-tracker.test.ts`
Expected: FAIL — `pctInRange`/`formatElapsed` 未从 `../../src/orchestrator` 导出（导入报错或 undefined）。

- [ ] **Step 3: 写最小实现**

在 `src/orchestrator.ts` 的 `type LogProgressFn = ReturnType<typeof makeLogProgress>;`（约 line 325）之后插入：

```typescript
/** Compute overall % within a stage's [start,end] range given a 0..1 fraction. */
export function pctInRange(range: [number, number], frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  return Math.round(range[0] + (range[1] - range[0]) * f);
}

/** Format elapsed ms as "45s" (<60s) or "1m30s" (>=60s). */
export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/progress-tracker.test.ts`
Expected: PASS（6 个测试全过）。

- [ ] **Step 5: 提交**

```bash
git add tests/ts/progress-tracker.test.ts src/orchestrator.ts
git commit -m "feat(orchestrator): 添加进度百分比/耗时辅助函数 pctInRange + formatElapsed"
```

---

## Task 2: `ProgressTracker` 类 + 权重映射

**Files:**
- Modify: `tests/ts/progress-tracker.test.ts`（追加测试块）
- Modify: `src/orchestrator.ts`（在 Task 1 的两个函数之后新增权重映射 + 类）

- [ ] **Step 1: 写失败测试**

在 `tests/ts/progress-tracker.test.ts` 末尾追加（顶部 import 行补充 `ProgressTracker`）：

```typescript
import { pctInRange, formatElapsed, ProgressTracker, QUICK_WEIGHTS, FULL_WEIGHTS } from '../../src/orchestrator';

// ... 保留 Task 1 的 describe 块 ...

describe('ProgressTracker', () => {
  function makeTracker(weights: Record<string, [number, number]>) {
    const calls: { msg: string; id?: string }[] = [];
    const log = (msg: string, _t?: number, _c?: number, id?: string) => calls.push({ msg, id });
    const tracker = new ProgressTracker(1000, log as any, weights);
    return { tracker, calls };
  }

  it('emits overall-progress with pct and elapsed for a known stage', () => {
    const { tracker, calls } = makeTracker({ data: [0, 5] });
    tracker.emit('data');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('overall-progress');
    expect(calls[0].msg).toContain('5%');
    expect(calls[0].msg).toContain('已用');
  });

  it('silently skips unknown stage (no log call)', () => {
    const { tracker, calls } = makeTracker({ data: [0, 5] });
    tracker.emit('nonexistent');
    expect(calls).toHaveLength(0);
  });

  it('never decreases pct — backwards/again emit is a no-op (monotonic + dedupe)', () => {
    const { tracker, calls } = makeTracker({ analysts: [5, 80], trader: [80, 88] });
    tracker.emit('trader');         // 88 → emits, lastPct=88
    tracker.emit('analysts', 1);    // 80 ≤ 88 → skipped (would go backwards)
    tracker.emit('trader');         // 88 ≤ 88 → skipped (dedupe)
    expect(calls).toHaveLength(1);
    expect(calls[0].msg).toContain('88%');
  });

  it('advances by fraction within a stage range', () => {
    const { tracker, calls } = makeTracker({ analysts: [5, 80] });
    tracker.emit('analysts', 3 / 7);  // 5 + 75*(3/7) = 37.14 → 37
    expect(calls[0].msg).toContain('37%');
  });

  it('QUICK_WEIGHTS and FULL_WEIGHTS are monotonic 0→100', () => {
    function check(w: Record<string, [number, number]>) {
      const vals = Object.values(w);
      for (const [lo, hi] of vals) {
        expect(lo).toBeLessThanOrEqual(hi);
      }
      expect(vals[0][0]).toBe(0);
      const last = vals[vals.length - 1];
      expect(last[1]).toBe(100);
    }
    check(QUICK_WEIGHTS);
    check(FULL_WEIGHTS);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ts/progress-tracker.test.ts`
Expected: FAIL — `ProgressTracker`/`QUICK_WEIGHTS`/`FULL_WEIGHTS` 未导出。

- [ ] **Step 3: 写最小实现**

在 `src/orchestrator.ts` 的 `formatElapsed` 之后（Task 1 插入处之后）追加：

```typescript
/** Duration-weighted stage → [startPct, endPct] maps. Analysts dominate (~80% quick / ~52% full). */
export const QUICK_WEIGHTS: Record<string, [number, number]> = {
  data: [0, 5], analysts: [5, 80], pm: [80, 97], save: [97, 100],
};
export const FULL_WEIGHTS: Record<string, [number, number]> = {
  data: [0, 3], analysts: [3, 55], debate: [55, 72], research: [72, 80],
  trader: [80, 88], riskDebate: [88, 95], riskMgr: [95, 100],
};

/**
 * Emits a single in-place "overall-progress" line: `总进度 N% · 已用 Xs`.
 * Monotonic: emit is a no-op when the computed pct does not strictly exceed
 * the last emitted pct. This makes revise-loop re-runs of trader/riskDebate
 * automatically skip (they'd re-compute a lower pct) without the orchestrator
 * needing to track first-pass vs retry.
 */
export class ProgressTracker {
  private lastPct = -1;
  constructor(
    private startTime: number,
    private log: LogProgressFn,
    private weights: Record<string, [number, number]>,
  ) {}

  emit(stage: string, frac = 1): void {
    const range = this.weights[stage];
    if (!range) return;                       // unknown stage: silent skip
    const pct = pctInRange(range, frac);
    if (pct <= this.lastPct) return;          // monotonic + dedupe
    this.lastPct = pct;
    const elapsed = formatElapsed(Date.now() - this.startTime);
    this.log(`总进度 ${pct}% · 已用 ${elapsed}`, undefined, undefined, 'overall-progress');
  }
}
```

> 注意：`LogProgressFn` 已在文件内定义（`type LogProgressFn = ReturnType<typeof makeLogProgress>;`），类直接引用即可。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ts/progress-tracker.test.ts`
Expected: PASS（Task 1 的 6 个 + Task 2 的 5 个，共 11 个测试全过）。

- [ ] **Step 5: 提交**

```bash
git add tests/ts/progress-tracker.test.ts src/orchestrator.ts
git commit -m "feat(orchestrator): 添加 ProgressTracker 总进度追踪器 + 时长加权映射"
```

---

## Task 3: 接入 `runAnalystPhase` + `runQuickAnalysis`

**Files:**
- Modify: `src/orchestrator.ts`
  - `runAnalystPhase`（签名 line 522-531）：加 `tracker?` 参数 + 3 处 emit
  - `runQuickAnalysis`（line 730-889）：建 tracker + 边界 emit + 传参
- Modify: `tests/ts/integration.test.ts`（加 1 个进度断言用例）

- [ ] **Step 1: 改 `runAnalystPhase` 签名加 tracker 参数**

`src/orchestrator.ts:522-531`，把末参数 `log: LogProgressFn` 之后追加 `tracker?: ProgressTracker`：

```typescript
async function runAnalystPhase(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger,
  runId: string,
  health: PipelineHealth,
  log: LogProgressFn,
  tracker?: ProgressTracker,
): Promise<{ analystReports: AnalystReport[]; totalTokens: number; totalCostUsd: number; dataResults: Array<{ role: string; result: ScriptResult }>; companyName: string }> {
```

- [ ] **Step 2: 在数据采集完成处 emit "data"**

在 `src/orchestrator.ts:561` 的 `log(\`[1/4] 数据采集完成 ...\`);` 之后追加一行：

```typescript
  log(`[1/4] 数据采集完成 (${ANALYST_CONFIGS.length - dataFailed}/${ANALYST_CONFIGS.length} 成功${dataFailed > 0 ? `, ${dataFailed} 失败` : ""})`);
  tracker?.emit("data");
```

- [ ] **Step 3: 在两处 `completedCount++` 之后 emit "analysts"**

成功路径（约 line 679-680）：

```typescript
        log(`⏳ [2/4] 分析师 ${completedCount}/${ANALYST_CONFIGS.length} (${voteStr})`, undefined, undefined, "analyst-progress");
        log(`  ✓ ${cfg.role}: ${vDir} (${llmResult.usage.total_tokens.toLocaleString()} tokens)`);
        tracker?.emit("analysts", completedCount / ANALYST_CONFIGS.length);
```

catch 路径（约 line 703-704）：

```typescript
        log(`⏳ [2/4] 分析师 ${completedCount}/${ANALYST_CONFIGS.length} (${voteStr})`, undefined, undefined, "analyst-progress");
        log(`  ✗ ${cfg.role}: 失败 — ${err.message?.slice(0, 60)}`);
        tracker?.emit("analysts", completedCount / ANALYST_CONFIGS.length);
```

- [ ] **Step 4: `runQuickAnalysis` 建 tracker + 传参**

在 `src/orchestrator.ts:747` 的 `const log = makeLogProgress(runId, onProgress);` 之后追加：

```typescript
  const log = makeLogProgress(runId, onProgress);
  const tracker = new ProgressTracker(startTime, log, QUICK_WEIGHTS);
```

把 line 753 的 `runAnalystPhase(...)` 调用末尾加上 `tracker`：

```typescript
  const { analystReports, totalTokens, totalCostUsd, dataResults, companyName } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health, log, tracker);
```

- [ ] **Step 5: 在 PM 决策确定后 emit "pm"，保存后 emit "save"**

在 `src/orchestrator.ts:862` 的 `};`（`finalDecision` 对象闭合）之后、line 863 `const result: QuickAnalysisResult = ...` 之前插入：

```typescript
  };

  tracker.emit("pm");

  const result: QuickAnalysisResult = { ticker, date, mode: "quick", analysts: analystReports, final: finalDecision };
```

在 line 871 的 `reportStore.save(...)` 之后（line 872 `saveRawData(...)` 之前或之后均可）追加：

```typescript
  reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost, runId, traceLogger.warnings, health.toJSON(), provenance);
  saveRawData(detailDir, dataResults, "03_data");
  tracker.emit("save");
```

- [ ] **Step 6: 编译确认**

Run: `npm run build`
Expected: 编译通过（`runAnalystPhase` 新参数可选，现有 `runFullAnalysis` 调用点暂未传 tracker 也不报错——Task 4 会补）。

- [ ] **Step 7: 加集成测试断言 overall-progress 单调到 100**

在 `tests/ts/integration.test.ts` 的 quick 分析 describe 块内（其他 `it(...)` 旁），加一个用例：

```typescript
  it('should emit overall-progress with monotonic percentages reaching 100 in quick mode', async () => {
    const progressMsgs: { text: string; id?: string }[] = [];
    const onProgress = (text: string, id?: string) => progressMsgs.push({ text, id });
    await runQuickAnalysis('600519', '2026-06-05', config, mockClient, undefined, onProgress);

    const overall = progressMsgs.filter(p => p.id === 'overall-progress');
    expect(overall.length).toBeGreaterThan(0);
    const pcts = overall.map(p => {
      const m = p.text.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : -1;
    });
    // monotonic non-decreasing
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
    // ends at 100 (save stage)
    expect(pcts[pcts.length - 1]).toBe(100);
    // analysts phase advanced at least once (data→save alone would be <7 emits)
    expect(overall.length).toBeGreaterThanOrEqual(7);
  });
```

> 该用例与同 describe 下的其他用例共享 `beforeEach` 里的 `config`/`mockClient`/`execPython` mock 设置。`onProgress` 是 `runQuickAnalysis` 的第 6 参数（第 5 参数 `signal` 传 `undefined`）。

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run tests/ts/integration.test.ts`
Expected: PASS（含新增进度用例）。

- [ ] **Step 9: 提交**

```bash
git add src/orchestrator.ts tests/ts/integration.test.ts
git commit -m "feat(orchestrator): quick 模式接入总进度行（overall-progress）"
```

---

## Task 4: 接入 `runFullAnalysis`

**Files:**
- Modify: `src/orchestrator.ts`（line 913-1130 区域）
- Modify: `tests/ts/integration.test.ts`（加 full 模式进度用例）

- [ ] **Step 1: 建 tracker + 传参给 runAnalystPhase**

在 `src/orchestrator.ts:928` 的 `const log = makeLogProgress(runId, onProgress);` 之后追加：

```typescript
  const log = makeLogProgress(runId, onProgress);
  const tracker = new ProgressTracker(startTime, log, FULL_WEIGHTS);
```

把 line 935 的 `runAnalystPhase(...)` 调用末尾加 `tracker`：

```typescript
  const { analystReports, dataResults, companyName } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health, log, tracker);
```

- [ ] **Step 2: 在各阶段完成处 emit（5 处）**

辩论完成（line 971 之后）：
```typescript
  log(`[3/7] 多空辩论完成 (Bull ${debate.rounds.flatMap(r => r.bull_claims).length} claims, Bear ${debate.rounds.flatMap(r => r.bear_claims).length} claims)`);
  tracker.emit("debate");
```

研究经理裁决完成（line 993 之后）：
```typescript
  log(`[4/7] 研究经理裁决: ${researchDecision.direction} (信心 ${researchDecision.confidence})`);
  tracker.emit("research");
```

交易员计划完成（line 1000 之后）：
```typescript
  log(`[5/7] 交易计划: ${tradingPlan.direction} 目标价 ${tradingPlan.target_price} 止损 ${tradingPlan.stop_loss}`);
  tracker.emit("trader");
```

风控辩论完成（line 1007 之后）：
```typescript
  log(`[6/7] 风控辩论完成`);
  tracker.emit("riskDebate");
```

最终风控评估（line 1062 之后）：
```typescript
  log(`[7/7] 风控评估: ${riskAssessment.status} (风险评分 ${riskAssessment.risk_score})`);
  tracker.emit("riskMgr");
```

> **关键**：revise 回路（line 1012-1025）重跑 `runTrader`(1019) 与 `runRiskDebate`(1023)，但**不**在其中调用 `tracker.emit`。整体停在 riskDebate 水位（95%）直到 line 1062 的 `riskMgr` emit →100%。即使误加，`ProgressTracker` 的单调守卫（`pct <= lastPct` 则跳过）也会兜底。

- [ ] **Step 3: 编译确认**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 4: 加 full 模式集成测试**

在 `tests/ts/integration.test.ts` 加 full 模式进度用例（与现有 full 分析用例同构，复用其 mock 设置；若现有 full 用例在独立 describe，参考其 mock LLM 配置）：

```typescript
  it('should emit overall-progress with monotonic percentages reaching 100 in full mode', async () => {
    const progressMsgs: { text: string; id?: string }[] = [];
    const onProgress = (text: string, id?: string) => progressMsgs.push({ text, id });
    await runFullAnalysis('600519', '2026-06-05', config, mockClient, undefined, onProgress);

    const overall = progressMsgs.filter(p => p.id === 'overall-progress');
    expect(overall.length).toBeGreaterThan(0);
    const pcts = overall.map(p => {
      const m = p.text.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : -1;
    });
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
    expect(pcts[pcts.length - 1]).toBe(100);
  }, 30_000);
```

> 若 full 模式需要不同的 mock LLM（辩论/研究/交易员/风控的 VERDICT），参考同文件已有的 `'should run full analysis with debate → research → trader → risk'` 用例的 mock 设置，确保 `runFullAnalysis` 能正常完成；进度断言逻辑不变。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/ts/integration.test.ts`
Expected: PASS（含 full 模式进度用例）。

- [ ] **Step 6: 提交**

```bash
git add src/orchestrator.ts tests/ts/integration.test.ts
git commit -m "feat(orchestrator): full 模式接入总进度行（overall-progress，revise 单调）"
```

---

## Task 5: 全量构建 + 测试验证

**Files:** 无（仅验证）

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: tsc 编译无错误。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部测试通过（原 313 + Task 1 新增 6 + Task 2 新增 5 + Task 3/4 各 1 集成 = 326）。重点确认：
- `tests/ts/progress-tracker.test.ts` 全过
- `tests/ts/integration.test.ts` 全过（含 2 个新进度用例）
- 其他 22 个测试文件零回归

- [ ] **Step 3: 若有未提交的编译产物变化则提交**

Run: `git status --short`
若仅 `dist/` 变化（编译产物），按项目惯例可一并提交或留待下次；源码与测试已在 Task 1-4 提交。无需空提交。

---

## Self-Review 记录

- **Spec 覆盖**：spec §方案（双行分离、时长加权映射、已用时间格式）→ Task 1-2；§实现/接入点（runAnalystPhase 参数、两主函数 emit）→ Task 3-4；§测试（ProgressTracker 单测 + 集成回归）→ Task 1-4 的测试步骤。✓ 全覆盖。
- **占位符扫描**：无 TBD/TODO；每个代码步骤都给出完整代码。✓
- **类型一致性**：`ProgressTracker.emit(stage, frac=1)` 全程一致；`QUICK_WEIGHTS`/`FULL_WEIGHTS` 的 stage 键（data/analysts/pm/save 与 data/analysts/debate/research/trader/riskDebate/riskMgr）与各 Task 的 emit 调用逐字对应；`runAnalystPhase` 用 "data"/"analysts"（两映射共有）。✓
- **单调性**：spec §属性要求 revise 不回退——Task 2 的 `if (pct <= this.lastPct) return` 守卫 + Task 4 Step 2 明确 revise 回路内不 emit，双重保证。✓
