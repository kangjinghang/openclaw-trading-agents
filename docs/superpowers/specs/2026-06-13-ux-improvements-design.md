# 用户体验改善设计

日期: 2026-06-13

## 概述

改善 trading-agents 插件三个阶段的用户体验：
1. 分析过程反馈（已有 onUpdate 基础，增强进度展示）
2. 结果展示优化（精简摘要 + markdown 格式化）
3. 错误体验改善（友好提示 + 部分失败信息）

## 1. 结果展示优化

### 问题

当前 `toolResult()` 返回完整 JSON（7 个分析师完整文本），用户在 OpenClaw 聊天窗口里看到一大坨数据，可读性差。LLM 也难以高效地基于完整 JSON 与用户对话。

### 方案

改造 `toolResult()` 和 `execute()` 返回值：

**content（用户可见）**：精简摘要 + markdown 报告

```
📊 600519 (贵州茅台) — 2026-06-13 Quick 分析

方向: Hold | 置信度: 62% | 耗时: 155s
分析师: 2看多/3中性/2看空 | 数据源: 7/7 成功

## 核心理由
均线空头排列完好，短期超卖但量能不足...

## 关键价位
目标价: 4.65 | 止损: 4.19 | 当前: 4.29

## 风控状态
通过 (风险评分 45/100)

---
完整报告已保存，输入 trading_report 查看详情。
```

**details（结构化数据，供 LLM 引用）**：完整原始数据

### 实现

改造 `src/index.ts` 中的 `toolResult()` 函数：

```typescript
function toolResult(data: unknown, isError = false) {
  // 如果是分析结果，生成精简摘要
  if (!isError && isAnalysisResult(data)) {
    const summary = formatSummary(data);
    return {
      content: [{ type: "text", text: summary }],
      details: data,
    };
  }
  // 错误或其他情况保持原样
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
    isError,
  };
}
```

新增 `formatSummary()` 函数（在 `src/index.ts` 内或提取到独立文件）：

- Quick 模式：direction + confidence + 分析师统计 + 核心理由 + 关键价位（仅 full 模式有）
- Full 模式：额外包含交易计划摘要（direction/target/stop_loss/position_pct）+ 风控状态
- 底部提示用户用 `trading_report` 查看完整报告

关键数据来源：
- `result.final.direction` — 方向
- `result.final.confidence` — 置信度
- `result.analysts[].verdict.direction` — 分析师投票统计
- `result.final.decision_rationale` — 核心理由
- Full 模式: `result.trading_plan` / `result.risk_assessment`

## 2. 分析过程反馈

### 现状

刚实现了 `onUpdate` + `AgentToolProgress`（`visibility: "channel"`），进度文本已能实时显示。但每次都是追加新行，进度信息散乱。

### 方案

**A) 用 `progress.id` 做原地更新**

对持续性状态（如进度条、分析师统计）使用固定 id，原地替换：

```typescript
// 进度条 — 固定 id，原地更新
onUpdate({
  content: [], details: undefined,
  progress: { text: "⏳ [2/4] 分析师 3/7 完成 (1看多/1中性/1看空)",
              visibility: "channel", privacy: "public", id: "analyst-progress" },
});

// 阶段切换 — 无 id，追加显示
onUpdate({
  content: [], details: undefined,
  progress: { text: "✅ [2/4] 分析师阶段完成",
              visibility: "channel", privacy: "public" },
});
```

**B) 实时分析师投票统计**

每完成一个分析师，更新投票统计：

```
⏳ [2/4] 分析师 3/7 完成 (1看多/1中性/1看空)
```

下一个完成后原地替换为：

```
⏳ [2/4] 分析师 4/7 完成 (1看多/2中性/1看空)
```

**C) 阶段完成时显示耗时**

```
✅ [2/4] 分析师阶段完成 (44.3s, 7/7 成功)
```

### 实现

改动在 `src/orchestrator.ts` 的 `runAnalystPhase` 和两个主函数中：

1. 在 `runAnalystPhase` 的并行循环里维护一个计数器和投票统计
2. 每个分析师完成后，用 `log(id: "analyst-progress")` 更新进度行
3. 阶段完成时用 `log()` 追加完成行

需要给 `LogProgressFn` 增加 `id` 参数支持：

```typescript
type LogProgressFn = (message: string, tokens?: number, costUsd?: number, id?: string) => void;
```

`makeLogProgress` 内部在有 `id` 时传给 `onProgress` 的 `progress.id` 字段。

## 3. 错误体验改善

### 问题

- 429 限流时用户看到原始错误 `"429 余额不足或无可用资源包"`，不知道怎么办
- 部分分析师失败时，结果里没有明确的失败信息
- 超时被 OpenClaw kill 时，用户只看到 "This operation was aborted"

### 方案

**A) 429 限流友好提示**

在 `execute()` 的 catch 中检测 429 错误，返回包含诊断建议的结果：

```typescript
catch (err: any) {
  if (err.status === 429 || err.message?.includes("429")) {
    return toolResult({
      error: true,
      message: "API 限流，请尝试以下方案：",
      suggestions: [
        "降低并发: llm_concurrency 设为 1",
        "换用更快的模型: analyst 设为 glm-5-turbo",
        "稍后重试",
      ],
      ticker: params.ticker,
    }, true);
  }
  ...
}
```

**B) 部分失败标注**

在结果摘要（`formatSummary`）里标注成功率：

```
分析师: 5/7 成功 (2个因API限流失败) | 方向: Hold
```

数据来源：已有的 `analystReports` 中 `content.startsWith("[分析失败")` 的计数。

**C) 超时诊断提示**

在 `execute()` 中检测 AbortError，返回友好提示：

```typescript
if (err.name === "AbortError") {
  return toolResult({
    error: true,
    message: "分析超时被中断。请尝试：",
    suggestions: [
      "在 openclaw.json 中增大 diagnostics.stuckSessionAbortMs (建议 1800000 = 30分钟)",
      "使用更快的模型 (glm-5-turbo + analyst_thinking: disabled)",
    ],
    ticker: params.ticker,
  }, true);
}
```

### 实现

改动在 `src/index.ts` 的 `execute()` catch 块中，对 429 和 AbortError 分别处理。

## 实施顺序

1. **结果展示优化** — 改 `toolResult()` + 新增 `formatSummary()`，影响最直接
2. **错误体验改善** — 改 `execute()` catch 块，改动小
3. **分析过程反馈** — 改 `makeLogProgress` + `runAnalystPhase`，需要更多测试

## 不做的事

- 不做首次使用引导流程（需要 OpenClaw 层面支持）
- 不做 Dashboard UI 改动（前端工作量太大，独立任务）
- 不改 `trading_report` 工具的行为
