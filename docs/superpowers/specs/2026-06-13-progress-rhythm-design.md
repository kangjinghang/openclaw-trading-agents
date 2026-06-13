# 分析过程节奏感知设计（总进度 + 已用时间）

日期: 2026-06-13

## 概述

为分析过程增加一条常驻"总进度 + 累计已用时间"行，让用户在漫长的分析（尤其分析师阶段占约 80% 时间）里有节奏感。

**明确不做**：ETA 预估（LLM 调用时长波动大，算不准会伤信任）。只产出两个准确信号：总体百分比 + 累计已用秒数。

这是继"结果展示 / 进度反馈 / 错误体验"三项聊天窗口内改善之后，针对**分析过程节奏感**的专项改善。

## 背景：现状与缺口

现状进度输出已有：
- 阶段编号 `[N/4]`（quick）/`[N/7]`（full）
- 分析师阶段原地投票统计行 `⏳ [2/4] 分析师 3/7 (1看多/1中性/1看空)`（id=`analyst-progress`）
- append 详情行 `✓ 分析师 market: 看多 (1.2k tokens)`
- 部分阶段的单阶段耗时

**缺口**：
1. 没有**累计**已用时间（只有单阶段）
2. 没有**总体百分比**（用户不知道走到 30% 还是 70%）
3. 在最漫长的分析师阶段，唯一在动的是 `[2/4]` 标签里的 3/7——没有全局视角

## 方案

### 显示形态：双行分离

- **overall 行**（新增，id=`overall-progress`，原地更新）：`总进度 35% · 已用 90s`
- **analyst 行**（现有，id=`analyst-progress`，保留不动）：`⏳ [2/4] 分析师 3/7 (1看多/1中性/1看空)`
- 现有 append 阶段行与详情行全部保留

分析师阶段两行同时原地更新；其他阶段只有 overall 行 + append 阶段行。

### 百分比加权：时长加权固定映射

分析师阶段占约 80% 时间，等权（每阶段 25%）会让进度条在分析师阶段卡死。采用时长加权：

**Quick 模式**：
| 阶段 | % 范围 |
|------|--------|
| [1/4] 数据采集 | 0–5% |
| [2/4] 分析师×7 | 5–80%（每个 ≈ 10.7%）|
| [3/4] PM | 80–97% |
| [4/4] 保存 | 97–100% |

**Full 模式**：
| 阶段 | % 范围 |
|------|--------|
| [1/7] 数据采集 | 0–3% |
| [2/7] 分析师×7 | 3–55%（每个 ≈ 7.4%）|
| [3/7] 多空辩论 | 55–72% |
| [4/7] 研究经理 | 72–80% |
| [5/7] 交易员 | 80–88% |
| [6/7] 风控辩论 | 88–95% |
| [7/7] 风控经理 | 95–100% |

属性：单调递增；分析师主导。**单调性保证**：每个 stage 的 emit 只在首次完成时触发；风控 revise 回路重跑 trader/riskDebate 时**不再 re-emit** 这些低阶段（否则 95%→80% 回退），overall 在 revise 期间停留在 95%（riskDebate 完成水位），最终 riskMgr 判定后 →100%。

### 已用时间格式

- `< 60s` → `已用 45s`
- `≥ 60s` → `已用 1m30s` / `已用 4m0s`（分:秒，提升长跑可读性）

## 实现

### 机制：ProgressTracker

在 `src/orchestrator.ts` 内新增轻量类：

```typescript
type WeightMap = Record<string, [number, number]>;

const QUICK_WEIGHTS: WeightMap = {
  data: [0, 5], analysts: [5, 80], pm: [80, 97], save: [97, 100],
};
const FULL_WEIGHTS: WeightMap = {
  data: [0, 3], analysts: [3, 55], debate: [55, 72], research: [72, 80],
  trader: [80, 88], riskDebate: [88, 95], riskMgr: [95, 100],
};

function pctInRange(range: [number, number], frac: number): number {
  return Math.round(range[0] + (range[1] - range[0]) * Math.max(0, Math.min(1, frac)));
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

class ProgressTracker {
  constructor(
    private startTime: number,
    private log: LogProgressFn,
    private weights: WeightMap,
  ) {}
  emit(stage: string, frac = 1): void {
    const range = this.weights[stage];
    if (!range) return;  // 未知 stage 静默跳过
    const pct = pctInRange(range, frac);
    const elapsed = formatElapsed(Date.now() - this.startTime);
    this.log(`总进度 ${pct}% · 已用 ${elapsed}`, undefined, undefined, "overall-progress");
  }
}
```

`log` 复用现有 `makeLogProgress` 返回的闭包，其第 4 参数 `id` 已支持（`analyst-progress` 行就是用它）。`onProgress` 未提供时（如多数测试），emit 只走 `console.error`，无副作用。

### 接入点

`runAnalystPhase` 现签名（`src/orchestrator.ts:522-531`）末参数为 `log: LogProgressFn`。新增可选参数 `tracker?: ProgressTracker`。其内部 `completedCount++` 共两处（成功路径 `:675`、catch 路径 `:701`），紧随其后追加：

```typescript
tracker?.emit("analysts", completedCount / ANALYST_CONFIGS.length);
```

（两处都加，确保成功/失败都推进 overall。）

**`runQuickAnalysis`** 顶部建 tracker，各阶段边界 emit：

```typescript
const tracker = new ProgressTracker(Date.now(), log, QUICK_WEIGHTS);
// [1/4] 数据采集后
tracker.emit("data");
// runAnalystPhase(..., tracker) — 内部按分析师推进
// [3/4] PM 后
tracker.emit("pm");
// [4/4] 保存后
tracker.emit("save");
```

**`runFullAnalysis`** 同构，FULL_WEIGHTS：

```typescript
const tracker = new ProgressTracker(Date.now(), log, FULL_WEIGHTS);
tracker.emit("data");
// runAnalystPhase(..., tracker)
tracker.emit("debate");
tracker.emit("research");
tracker.emit("trader");
tracker.emit("riskDebate");
tracker.emit("riskMgr");
```

调用方传 `tracker`：`runAnalystPhase(..., log, tracker)`。

**单调性实现**（Full revise 回路）：trader/riskDebate/riskMgr 的 emit 只在首次执行路径触发；revise 重试里重跑 trader、riskDebate 时**跳过 emit**（overall 保持在 riskDebate 水位 95%），最终 riskMgr 判定 emit 一次到 100%。可用 `Set<string>` 记录已 emit 的 stage，或在 orchestrator 里用布尔标记控制首次路径。

### 显示效果（用户视角）

分析师阶段（两行同时原地更新）：
```
总进度 35% · 已用 90s
⏳ [2/4] 分析师 3/7 (1看多/1中性/1看空)
  ✓ 分析师 market: 看多 (1.2k tokens)
  ✓ 分析师 news: 中性 (0.8k tokens)
```

辩论阶段（仅 overall 行 + append 阶段行）：
```
总进度 60% · 已用 110s
[3/7] 多空辩论 (2 轮)...
```

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/orchestrator.ts` | 新增 `ProgressTracker` + 权重映射 + `pctInRange`/`formatElapsed`；两主函数建 tracker 并 emit；`runAnalystPhase` 加可选 `tracker` 参数及两处 emit |
| `tests/ts/` | `ProgressTracker` 单测；集成测试回归 |

不动：`types.ts`、prompts、`index.ts`、其他源文件。不破坏现有 `analyst-progress` 行与 append 行。

## 测试

- **`ProgressTracker` 单测**（新文件或并入现有 orchestrator 测试）：
  - `pctInRange([5,80], 0)` = 5，`pctInRange([5,80], 0.5)` = 43，`pctInRange([5,80], 1)` = 80
  - `pctInRange` 对 `frac > 1` / `frac < 0` 截断到端点
  - `formatElapsed(45000)` = `45s`，`formatElapsed(90000)` = `1m30s`，`formatElapsed(240000)` = `4m0s`
  - `emit` 未知 stage → 不调用 log（静默）
  - `emit` 已知 stage → log 收到 `id="overall-progress"` 且文案含 `%` 与 `已用`
- **集成回归**：现有 12 个集成用例不破；可选断言 progress 输出里 `overall-progress` id 出现且百分比单调递增

## 不做的事

- **ETA 预估**：需要历史阶段平均时长，LLM 波动大、算不准伤信任。明确排除。
- **ASCII 进度条**（▓░）：采用纯 % + 已用（双行分离方案），不加条。
- **改 `analyst-progress` 行**：保留现有形态，只新增 overall 行。
- **改 prompt/types**：纯 orchestrator 内部机制，无对外接口变化。
