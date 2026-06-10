# Pipeline Health Checkpoint Framework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified PipelineHealth checkpoint framework that catches pipeline failures (data collection, template rendering, output parsing) at each stage and can abort/skip/warn, preventing wasted LLM calls on broken inputs.

**Architecture:** A PipelineHealth collector class instantiated at pipeline start, passed through each phase. Existing checks (quality-gate, quality-review, cross-stage, warnings) remain in their files; their results get registered into PipelineHealth. New checks (template rendering validation, data collection abort gate) are added inline in orchestrator. All issues persist to report JSON.

**Tech Stack:** TypeScript, Vitest, no new dependencies.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/pipeline-health.ts` | **New**: PipelineHealth class — collects issues, provides check() helper |
| `src/types.ts` | Add PipelineIssue interface |
| `src/orchestrator.ts` | Instantiate health, insert 6 checkpoints, pass to runAnalystPhase |
| `src/report-store.ts` | Persist pipeline_health in save/saveFull |
| `src/dashboard-api.ts` | Expose pipeline_health in ReportSummary |
| `dashboard/index.html` | Render pipeline_health in alert banner |
| `tests/ts/pipeline_health.test.ts` | **New**: Unit tests for PipelineHealth class |
| `tests/ts/orchestrator_pipeline.test.ts` | **New**: Integration tests for abort/skip behavior |

---

### Task 1: Add PipelineIssue type to types.ts

**Files:**
- Modify: `src/types.ts` (after CrossStageIssue interface, around line 65)

- [ ] **Step 1: Add PipelineIssue interface**

After the `CrossStageIssue` interface in `src/types.ts`, add:

```ts
/** A single pipeline health check result. */
export interface PipelineIssue {
  /** Pipeline stage where the issue was detected. */
  stage: "data_collection" | "template_render" | "analyst_output" | "quality_gate" | "quality_review" | "cross_stage";
  /** abort = stop pipeline; skip = skip this item; warn = record only. */
  severity: "abort" | "skip" | "warn";
  /** Short check name (e.g. "placeholders_remaining"). */
  check: string;
  /** Human-readable description. */
  message: string;
  /** Optional context (role, placeholder names, etc.). */
  context?: Record<string, any>;
}
```

- [ ] **Step 2: Add pipeline_health to AnalysisReport**

In `AnalysisReport` interface (around line 86), add after `cross_stage_issues`:

```ts
  /** Pipeline health issues collected at each checkpoint. */
  pipeline_health?: PipelineIssue[];
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: clean compile (type is defined but not yet consumed).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add PipelineIssue type for pipeline health framework"
```

---

### Task 2: Implement PipelineHealth class (TDD)

**Files:**
- Create: `src/pipeline-health.ts`
- Create: `tests/ts/pipeline_health.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/ts/pipeline_health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PipelineHealth } from "../../src/pipeline-health";

describe("PipelineHealth", () => {
  it("starts with no issues", () => {
    const h = new PipelineHealth("run-1");
    expect(h.issues).toEqual([]);
    expect(h.hasAbort).toBe(false);
  });

  it("check() registers issue when condition is false", () => {
    const h = new PipelineHealth("run-1");
    h.check("data_collection", "abort", "majority_failed", false, "5/7 scripts failed");
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0].severity).toBe("abort");
    expect(h.hasAbort).toBe(true);
  });

  it("check() does nothing when condition is true", () => {
    const h = new PipelineHealth("run-1");
    h.check("data_collection", "abort", "majority_failed", true, "should not appear");
    expect(h.issues).toHaveLength(0);
  });

  it("add() registers an issue directly", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "template_render", severity: "skip", check: "placeholders_remaining",
      message: "news has 2 un-replaced placeholders", context: { role: "news" } });
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0].context?.role).toBe("news");
  });

  it("getIssues(stage) filters by stage", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "data_collection", severity: "warn", check: "a", message: "m1" });
    h.add({ stage: "template_render", severity: "skip", check: "b", message: "m2" });
    h.add({ stage: "data_collection", severity: "warn", check: "c", message: "m3" });
    expect(h.getIssues("data_collection")).toHaveLength(2);
    expect(h.getIssues("template_render")).toHaveLength(1);
  });

  it("toJSON() returns the issues array", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "cross_stage", severity: "warn", check: "test", message: "msg" });
    expect(h.toJSON()).toEqual(h.issues);
  });

  it("multiple severities: only abort sets hasAbort", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "template_render", severity: "skip", check: "a", message: "m" });
    expect(h.hasAbort).toBe(false);
    h.add({ stage: "analyst_output", severity: "warn", check: "b", message: "m" });
    expect(h.hasAbort).toBe(false);
    h.add({ stage: "data_collection", severity: "abort", check: "c", message: "m" });
    expect(h.hasAbort).toBe(true);
  });

  it("check() with context passes context through", () => {
    const h = new PipelineHealth("run-1");
    h.check("template_render", "skip", "placeholders", false, "unreplaced", { role: "sentiment" });
    expect(h.issues[0].context).toEqual({ role: "sentiment" });
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/ts/pipeline_health.test.ts`
Expected: FAIL — `PipelineHealth` is not a module.

- [ ] **Step 3: Implement PipelineHealth**

Create `src/pipeline-health.ts`:

```ts
import { PipelineIssue } from "./types";

/**
 * Collector for pipeline health issues. Instantiated once per run,
 * passed through each pipeline phase. Issues are registered via
 * check() (conditional) or add() (direct). At the end, toJSON()
 * produces the persistable array.
 */
export class PipelineHealth {
  private _issues: PipelineIssue[] = [];

  constructor(public readonly runId: string) {}

  /** Register an issue directly. */
  add(issue: PipelineIssue): void {
    this._issues.push(issue);
  }

  /**
   * Conditional check: if `condition` is false, registers an issue.
   * If true, does nothing (check passed).
   */
  check(
    stage: PipelineIssue["stage"],
    severity: PipelineIssue["severity"],
    checkName: string,
    condition: boolean,
    message: string,
    context?: Record<string, any>
  ): void {
    if (!condition) {
      this._issues.push({ stage, severity, check: checkName, message, context });
    }
  }

  /** True if any issue has severity "abort" — caller should stop the pipeline. */
  get hasAbort(): boolean {
    return this._issues.some(i => i.severity === "abort");
  }

  /** All issues collected so far. */
  get issues(): PipelineIssue[] {
    return this._issues;
  }

  /** Get issues filtered by stage. */
  getIssues(stage: string): PipelineIssue[] {
    return this._issues.filter(i => i.stage === stage);
  }

  /** Serialize for report persistence. */
  toJSON(): PipelineIssue[] {
    return this._issues;
  }
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/ts/pipeline_health.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline-health.ts tests/ts/pipeline_health.test.ts
git commit -m "feat: PipelineHealth collector class with 8 unit tests"
```

---

### Task 3: Wire CP1 (data_collection) and CP2 (template_render) into runAnalystPhase

**Files:**
- Modify: `src/orchestrator.ts` (runAnalystPhase function, lines ~420-540)

- [ ] **Step 1: Add PipelineHealth parameter to runAnalystPhase signature**

In `src/orchestrator.ts`, find the `runAnalystPhase` function signature (around line 369) and add the parameter:

```ts
async function runAnalystPhase(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger,
  runId: string,
  health: PipelineHealth  // NEW
): Promise<{ analystReports: AnalystReport[]; totalTokens: number; totalCostUsd: number; dataResults: Array<{ role: string; result: ScriptResult }> }> {
```

Add the import at the top of the file (with other imports):
```ts
import { PipelineHealth } from "./pipeline-health";
```

- [ ] **Step 2: Add CP1 — data collection checkpoint**

After the data collection completion log (line ~456, after `const dataFailed = ...`), insert:

```ts
  // CP1: Data collection gate
  health.check("data_collection", "abort", "majority_scripts_failed",
    dataFailed <= 3,
    `${dataFailed}/${ANALYST_CONFIGS.length} 数据源失败，无法进行有效分析`
  );
  if (health.hasAbort) {
    logProgress(runId, `❌ 管道中止: ${health.getIssues("data_collection").map(i => i.message).join("; ")}`);
    return { analystReports: [], totalTokens: 0, totalCostUsd: 0, dataResults };
  }
  for (const { role, result } of dataResults) {
    if (!result.success) {
      health.check("data_collection", "warn", "script_failed", false, `数据源 ${role} 获取失败: ${(result.error || "").slice(0, 60)}`, { role });
    }
  }
```

- [ ] **Step 3: Add CP2 — template rendering checkpoint**

After the `loadAndRender` call (around line 495), before the `callLLM` call, insert:

```ts
        // CP2: Template render gate — detect un-replaced placeholders
        const remainingPlaceholders = userMessage.match(/\{\{(\w+)\}\}/g);
        if (remainingPlaceholders) {
          health.add({
            stage: "template_render",
            severity: "skip",
            check: "placeholders_remaining",
            message: `${cfg.role} 有 ${remainingPlaceholders.length} 个占位符未替换: ${remainingPlaceholders.join(", ")}`,
            context: { role: cfg.role, placeholders: remainingPlaceholders.map(p => p.replace(/[{}]/g, "")) },
          });
          logProgress(runId, `  ⚠ 跳过 ${cfg.role}: 占位符未替换`);
          analystReports[idx] = {
            role: cfg.role,
            content: `[分析跳过: 模板占位符未替换 — ${remainingPlaceholders.join(", ")}]`,
            verdict: { direction: "中性", reason: "模板渲染异常，数据未注入" },
            data_sources_used: [],
          } as AnalystReport;
          continue; // skip the LLM call for this analyst
        }
```

- [ ] **Step 4: Add CP3 — analyst output checkpoint**

After `parseVerdict` (around line 511), insert:

```ts
        // CP3: Analyst output gate
        health.check("analyst_output", "warn", "verdict_missing",
          verdict !== null,
          `${cfg.role} VERDICT 解析失败，使用默认中性`,
          { role: cfg.role }
        );
        health.check("analyst_output", "warn", "content_too_short",
          llmResult.content.length >= 200,
          `${cfg.role} 输出过短 (${llmResult.content.length} chars)，可能敷衍`,
          { role: cfg.role, contentLength: llmResult.content.length }
        );
```

- [ ] **Step 5: Update call sites that invoke runAnalystPhase**

There are two call sites: `runQuickAnalysis` (line ~630) and `runFullAnalysis` (line ~775). Both need to pass `health`. Find the calls:

```ts
// In runQuickAnalysis — change:
const { analystReports, totalTokens, totalCostUsd, dataResults } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId);
// To:
const health = new PipelineHealth(runId);
const { analystReports, totalTokens, totalCostUsd, dataResults } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health);

// In runFullAnalysis — change:
const { analystReports, dataResults } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId);
// To:
const health = new PipelineHealth(runId);
const { analystReports, dataResults } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health);
```

Note: `health` must be declared before the call, so it can be used in later CP4-6 checkpoints too.

- [ ] **Step 6: Build and run tests**

Run: `npm run build && npm test`
Expected: All tests pass (existing tests don't use PipelineHealth, so backward compat). 254+ green.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: wire CP1-3 checkpoints into runAnalystPhase (data_collection, template_render, analyst_output)"
```

---

### Task 4: Wire CP4-6 into runQuickAnalysis and runFullAnalysis

**Files:**
- Modify: `src/orchestrator.ts`

- [ ] **Step 1: Add CP4 — quality gate checkpoint in runQuickAnalysis**

After the quality gate call (around line ~571), insert:

```ts
        // CP4: Quality gate — register layer-1 grades
        for (const g of quality.grades) {
          if (g.grade === "D" || g.grade === "F") {
            health.add({ stage: "quality_gate", severity: "warn", check: "layer1_grade",
              message: `${g.role} 质量门评级 ${g.grade}: ${(g.issues || []).join("; ")}`,
              context: { role: g.role, grade: g.grade } });
          }
        }
```

- [ ] **Step 2: Add CP5 — quality review checkpoint in runQuickAnalysis**

After the quality review call (around line ~573), insert:

```ts
        // CP5: Quality review — register layer-2 findings
        if (qualityReview) {
          for (const suspect of qualityReview.fabrication_suspects || []) {
            health.add({ stage: "quality_review", severity: "warn", check: "fabrication_suspect",
              message: `${suspect} 疑似编造数据`, context: { role: suspect } });
          }
        }
```

- [ ] **Step 3: Add same CP4-5 in runFullAnalysis**

Find the same quality gate and quality review calls in `runFullAnalysis` (around lines ~717-719) and add the identical CP4 and CP5 blocks.

- [ ] **Step 4: Add CP6 — cross-stage checkpoint in runFullAnalysis**

After `crossStageChecks` call (around line ~838), insert:

```ts
        // CP6: Cross-stage — register all issues
        for (const issue of crossIssues) {
          health.add({ stage: "cross_stage", severity: issue.severity === "error" ? "warn" : "warn",
            check: issue.check, message: issue.message });
        }
```

- [ ] **Step 5: Build and run tests**

Run: `npm run build && npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: wire CP4-6 checkpoints (quality_gate, quality_review, cross_stage)"
```

---

### Task 5: Persist pipeline_health in report-store and dashboard

**Files:**
- Modify: `src/report-store.ts`
- Modify: `src/dashboard-api.ts`
- Modify: `dashboard/index.html`

- [ ] **Step 1: Update save() signature in report-store.ts**

Find the `save` method signature (line ~45). Add `pipelineHealth` parameter:

```ts
  save(
    ticker: string, date: string, mode: "quick" | "full",
    result: QuickAnalysisResult, durationMs: number,
    totalTokens: number, totalCostUsd: number,
    runId?: string, warnings: FallbackWarning[] = [],
    pipelineHealth: PipelineIssue[] = []   // NEW
  ): void {
```

Add import at top:
```ts
import { PipelineIssue } from "./types";
```

In the `save` method body, where the summary JSON is assembled (look for `warnings`), add:
```ts
      pipeline_health: pipelineHealth,
```

- [ ] **Step 2: Update saveFull() signature in report-store.ts**

Same pattern for `saveFull` (line ~102). Add after `crossStageIssues`:

```ts
  saveFull(
    ...existing params...,
    crossStageIssues: CrossStageIssue[] = [],
    pipelineHealth: PipelineIssue[] = []   // NEW
  ): void {
```

In the body, add `pipeline_health: pipelineHealth` to the summary JSON.

- [ ] **Step 3: Update call sites in orchestrator.ts**

In `runQuickAnalysis` (save call around line ~652):
```ts
// Change:
reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost, runId, traceLogger.warnings);
// To:
reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost, runId, traceLogger.warnings, health.toJSON());
```

In `runFullAnalysis` (saveFull call around line ~838):
```ts
// Change:
reportStore.saveFull(ticker, date, result, durationMs, traceLogger.totalTokens, traceLogger.totalCostUsd, runId, traceLogger.warnings, crossIssues);
// To:
reportStore.saveFull(ticker, date, result, durationMs, traceLogger.totalTokens, traceLogger.totalCostUsd, runId, traceLogger.warnings, crossIssues, health.toJSON());
```

- [ ] **Step 4: Update dashboard-api.ts ReportSummary**

In `ReportSummary` interface (line ~24), add:
```ts
  pipeline_health?: Array<{ stage: string; severity: string; check: string; message: string; context?: Record<string, any> }>;
```

In `toSummary` function (around line ~234), add:
```ts
    pipeline_health: raw.pipeline_health || [],
```

- [ ] **Step 5: Update dashboard/index.html renderReviewFlags**

Find the `renderReviewFlags` function. After the existing `cross_stage_issues` and `warnings` rendering, add a section for `pipeline_health`:

```js
  // Pipeline health issues
  const ph = report.pipeline_health || [];
  if (ph.length > 0) {
    const aborts = ph.filter(i => i.severity === "abort");
    const skips = ph.filter(i => i.severity === "skip");
    const phWarns = ph.filter(i => i.severity === "warn");
    html += `<div class="flag-section"><strong>管道健康</strong> `;
    if (aborts.length) html += `<span class="flag-err">${aborts.length} 中止</span> `;
    if (skips.length) html += `<span style="color:#e67e22">${skips.length} 跳过</span> `;
    if (phWarns.length) html += `<span class="flag-warn">${phWarns.length} 警告</span>`;
    html += `</div>`;
    for (const i of ph) {
      const cls = i.severity === "abort" ? "flag-err" : i.severity === "skip" ? "" : "flag-warn";
      html += `<div class="flag-item ${cls}">[${i.severity}] ${i.stage}.${i.check}: ${escHtml(i.message)}</div>`;
    }
  }
```

- [ ] **Step 6: Build and run tests**

Run: `npm run build && npm test`
Expected: All tests pass. Existing tests pass `[]` as default for the new parameter.

- [ ] **Step 7: Commit**

```bash
git add src/report-store.ts src/dashboard-api.ts dashboard/index.html src/orchestrator.ts
git commit -m "feat: persist pipeline_health in reports + dashboard rendering"
```

---

### Task 6: Integration tests for abort/skip behavior

**Files:**
- Create: `tests/ts/orchestrator_pipeline.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/ts/orchestrator_pipeline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PipelineHealth } from "../../src/pipeline-health";

describe("Pipeline Health Integration", () => {
  it("CP1: aborts when majority of scripts fail", () => {
    const h = new PipelineHealth("run-test");
    h.check("data_collection", "abort", "majority_scripts_failed", false, "5/7 scripts failed");
    expect(h.hasAbort).toBe(true);
    expect(h.getIssues("data_collection")).toHaveLength(1);
    expect(h.getIssues("data_collection")[0].severity).toBe("abort");
  });

  it("CP1: passes when scripts succeed", () => {
    const h = new PipelineHealth("run-test");
    h.check("data_collection", "abort", "majority_scripts_failed", true, "should not appear");
    expect(h.hasAbort).toBe(false);
    expect(h.issues).toHaveLength(0);
  });

  it("CP2: skip when template placeholders remain", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "template_render", severity: "skip", check: "placeholders_remaining",
      message: "news 有 2 个占位符未替换", context: { role: "news", placeholders: ["stock_news", "macro_news"] } });
    expect(h.hasAbort).toBe(false); // skip != abort
    expect(h.getIssues("template_render")).toHaveLength(1);
    expect(h.getIssues("template_render")[0].severity).toBe("skip");
  });

  it("CP3: warns on short analyst output", () => {
    const h = new PipelineHealth("run-test");
    h.check("analyst_output", "warn", "content_too_short", false, "news only 50 chars", { role: "news", contentLength: 50 });
    expect(h.hasAbort).toBe(false);
    expect(h.getIssues("analyst_output")).toHaveLength(1);
  });

  it("CP4-6: accumulating issues from multiple stages", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "quality_gate", severity: "warn", check: "layer1_grade", message: "news grade D" });
    h.add({ stage: "quality_review", severity: "warn", check: "fabrication_suspect", message: "fundamentals suspect" });
    h.add({ stage: "cross_stage", severity: "warn", check: "retries_exhausted", message: "retries exhausted" });
    expect(h.issues).toHaveLength(3);
    expect(h.hasAbort).toBe(false);
    expect(h.toJSON()).toHaveLength(3);
  });

  it("abort blocks even with other warn issues", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "analyst_output", severity: "warn", check: "verdict_missing", message: "m" });
    h.add({ stage: "data_collection", severity: "abort", check: "majority_failed", message: "m" });
    h.add({ stage: "cross_stage", severity: "warn", check: "test", message: "m" });
    expect(h.hasAbort).toBe(true);
    expect(h.issues).toHaveLength(3);
  });

  it("toJSON is safe to serialize for report", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "template_render", severity: "skip", check: "placeholders_remaining",
      message: "test", context: { role: "news" } });
    const json = JSON.stringify(h.toJSON());
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].stage).toBe("template_render");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/ts/orchestrator_pipeline.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: All tests pass (260+).

- [ ] **Step 4: Commit**

```bash
git add tests/ts/orchestrator_pipeline.test.ts
git commit -m "test: integration tests for pipeline health abort/skip/warn behavior"
```

---

### Task 7: Final build + verify + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Full build + test**

Run: `npm run build && npm test`
Expected: All tests pass, build clean.

- [ ] **Step 2: Update CHANGELOG.md**

Under `[Unreleased]` > `工程稳健性`, add:

```markdown
- 管道健康关卡框架（`src/pipeline-health.ts` + `src/orchestrator.ts`）：PipelineHealth 收集器贯穿全管道，6 个关卡（数据采集/模板渲染/分析师输出/质量门/可信度复核/跨阶段），三级拦截（abort=中止/skip=跳过/warn=记录）。核心新增 CP2 模板渲染门——检测 `{{...}}` 占位符未替换，跳过该分析师 LLM 调用（防 buildTemplateVars 修复前的同类 bug 重演）。所有关卡结果落 summary JSON + dashboard 告警条
- `buildTemplateVars` 模板数据映射修复（`src/orchestrator.ts`）：news/sentiment/policy 三个分析师的模板占位符（`{{stock_news}}`/`{{macro_news}}`/`{{sentiment_data}}`）与代码注入变量名（`news`/`sentiment`）不匹配，数据从未注入 prompt。新增 `buildTemplateVars()` 按 role 拆分数据 JSON 为模板期望的多变量映射。实跑 600315 验证：sentiment 从"中性滑水"变为有观点的"看空"
```

- [ ] **Step 3: Commit and push**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 补 pipeline health 框架 + buildTemplateVars 修复"
git push origin main
```
