# Design: Pipeline Health Checkpoint Framework

## Context

实跑 600315 发现 news/sentiment/policy 三个分析师声称"数据缺失"——根因是模板占位符 `{{stock_news}}`/`{{macro_news}}`/`{{sentiment_data}}` 未被替换，数据从未注入 prompt。现有质量检查（Layer-1/2、跨阶段检查、warnings）全在 LLM 输出侧工作，无法检测输入侧故障。policy 分析师甚至拿到了 A 级——输出侧检查被空数据驱动的空转分析骗过。

需要一个端到端的管道健康检查框架：关卡式拦截（发现严重问题就停），覆盖数据采集 → 模板渲染 → LLM 调用 → 解析 → 落盘全链路。

## Architecture

**核心原则**：PipelineHealth 是**收集器**，不是检查器。现有检查逻辑留在原文件，只把结果注册进来。新增的检查（模板渲染验证、数据采集门）才在 orchestrator 里直接调用。

### PipelineIssue

```ts
interface PipelineIssue {
  stage: string;        // "data_collection" | "template_render" | "analyst_output" | "quality_gate" | "quality_review" | "cross_stage"
  severity: "abort" | "skip" | "warn";
  check: string;        // "placeholders_remaining" | "majority_scripts_failed" | ...
  message: string;
  context?: Record<string, any>;
}
```

### Three severity levels

| Level | Meaning | Typical scenario |
|---|---|---|
| `abort` | Stop entire pipeline | >3 data scripts failed, no market data |
| `skip` | Skip this one item, continue others | One analyst's template has un-replaced placeholders |
| `warn` | Record but continue | VERDICT parsing failed, content too short |

### PipelineHealth class

New file: `src/pipeline-health.ts`

- `constructor(runId: string)`
- `check(stage, severity, checkName, condition, message, context?)` — auto-register on condition=false
- `add(issue)` — register an issue directly
- `get hasAbort(): boolean` — any abort-level issue exists
- `getIssues(stage?): PipelineIssue[]`
- `toJSON(): PipelineIssue[]`

### Checkpoints

| CP | Stage | Key checks | Severity |
|---|---|---|---|
| CP1 | data_collection | majority_scripts_failed, market_data_empty | abort, warn |
| CP2 | template_render | placeholders_remaining | **skip** (core fix) |
| CP3 | analyst_output | verdict_missing, content_too_short | warn |
| CP4 | quality_gate | layer1 grades → warn | warn |
| CP5 | quality_review | fabrication_suspect, low_credibility | warn |
| CP6 | cross_stage | existing 6 checks | warn |

### Data flow in orchestrator

```
runAnalystPhase:
  dataResults → CP1 (abort check)
  (per analyst):
    renderTemplate → CP2 (skip check) → [skip] continue / [pass] callLLM
    analystOutput → CP3 (warn checks)
  qualityGate → CP4 (register grades)
  qualityReview → CP5 (register credibility)

runFullAnalysis (additional):
  crossStageChecks → CP6 (register issues)

save → report.pipeline_health = health.toJSON()
```

### Persistence

- `AnalysisReport.pipeline_health?: PipelineIssue[]` — alongside existing `warnings` and `cross_stage_issues`
- `ReportSummary.pipeline_health` in dashboard-api.ts
- Dashboard: extend `renderReviewFlags()` to include pipeline_health items (abort=red, skip=orange, warn=yellow)

### Existing systems — zero changes

| File | Status |
|---|---|
| quality-gate.ts | Unchanged. Grades registered into health by orchestrator |
| quality-review.ts | Unchanged. Results registered into health by orchestrator |
| cross-stage-checks.ts | Unchanged. Results registered into health by orchestrator |
| trace-logger.ts | Unchanged. Warnings stay independent |

### Files to modify

| File | Change |
|---|---|
| `src/pipeline-health.ts` | **New**: PipelineHealth class |
| `src/types.ts` | Add PipelineIssue interface; AnalysisReport add pipeline_health field |
| `src/orchestrator.ts` | Instantiate PipelineHealth; insert 6 checkpoints |
| `src/report-store.ts` | save/saveFull persist pipeline_health |
| `src/dashboard-api.ts` | ReportSummary add pipeline_health |
| `dashboard/index.html` | Render pipeline_health in alert banner |
| `tests/ts/pipeline_health.test.ts` | **New**: unit tests |
| `tests/ts/orchestrator_pipeline.test.ts` | **New**: integration tests for abort/skip behavior |
