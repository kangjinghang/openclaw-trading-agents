# LLM 基准对比工具设计（watchlist trace 回放评测）

> 日期：2026-06-24
> 状态：设计中
> 依赖：[`src/llm-client.ts`](../../../src/llm-client.ts)、[`src/trace-logger.ts`](../../../src/trace-logger.ts)、rank/rebalance trace 产物
> 范围：把一次性脚本 `tests/thinking-compare.mjs` 升级为项目级、配置驱动的 LLM 对比工具，用于在 watchlist pipeline 的 rank / rebalance 环节寻找质量与速度平衡的模型和请求参数

## 1. 问题背景

### 1.1 现状

watchlist pipeline 有两类 LLM 调用环节：

| 环节 | 调用形态 | trace 数量 | 输入规模 |
|------|---------|-----------|---------|
| **rank** | 整个 watchlist 一次排序，分 LONG/SHORT 两组 | 每次 run 仅 2 个 trace（`long-ranker` + `short-ranker`） | system_prompt ~2KB + user_message ~12KB（多股摘要拼装） |
| **rebalance（shallow-analyzer）** | 每只股票独立分析一次 | 多个 trace，每只股一个（`analyst-shallow-trace-*` / `risk-shallow-trace-*`） | 单股上下文，user_message ~1-3KB |

当前生产配置固定为 GLM（智谱）单厂商、`thinking: disabled`。要回答"换 DeepSeek 更好吗"、"GLM-5.2 开 thinking 质量提升多少值不值得变慢"、"同模型 temperature 调多少"这类问题，缺乏可复现的评测手段。

### 1.2 现有一次性脚本

`tests/thinking-compare.mjs`（167 行）能做的事：
- 从 `~/.openclaw/watchlist/scan/{date}/traces/` 和 `.../rebalance/{date}/traces/` 读 trace
- 对 thinking on/off 各调一次 LLM，对比排序一致性 / 字段一致性

它的局限：
1. **单次对比**——每个配置只跑 1 次，LLM 有随机性（即便 temperature=0），单次结果易误判
2. **写死 GLM 单厂商**——base_url / api_key 硬编码，无法跨厂商
3. **不可配置、不可复现**——选哪些 trace、对比什么，全靠改源码
4. **质量度量粗糙**——只有"JSON 是否一致"这种二值判断，无稳定性 / 成本 / 分位耗时统计

### 1.3 核心需求

| # | 需求 | 本设计如何满足 |
|---|------|---------------|
| 1 | 对比不同厂商 / 同厂商不同模型 / 同模型不同参数 | 配置文件 `configs[]` 数组，每条配置独立指定 provider+model+参数 |
| 2 | 提示词用真实 trace，不自己造 | 回放直接读 `trace.request.{system_prompt, user_message}`，原样喂给 LLM |
| 3 | 拆分到环节底层，避免只跑一次被随机性误导 | `repeats` 参数；每个选中 trace × 每个配置跑 N 次 |
| 4 | 质量 / 效果优先，速度次要 | 产物以"逐样本原始输出 + 稳定性"为主载体，速度作为次要列 |
| 5 | 由 ZCode 评判、人工最终审核 | 工具产出结构化 `results.json`（全部原始输出）+ 可读 `report.md`，评判由读产物完成，不内置 judge LLM |

### 1.4 关键设计决策（已与用户对齐）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 质量度量 | 质量/效果优先，速度次要 | 用户要找"足够好"的配置而非"最快凑合" |
| 判断归属 | 工具产统计+逐样本原始输出，ZCode 读后评判，用户审核 | 无标准答案时，工具忠实呈现，判断交给人 |
| 对比定义 | 配置文件驱动 | 可复现、可入库 git |
| 调用次数 | 统一 `repeats`：选中 trace × 配置数 × repeats | 文件多靠样本多样性、文件少靠重复次数压制随机性 |
| 密钥 | `providers` 块 + 引用，key 支持 `$ENV` | 跨厂商 key 隔离，避免明文进 git |
| 覆盖范围 | 仅 watchlist 的 rank / rebalance，单日期不跨日期 | 聚焦当前痛点，避免过度泛化 |
| 工具形态 | 单 CLI（`src/llm-bench-cli.ts`）+ 配置文件 | 与 rank-cli/rebalance-cli 风格一致；统计/回放抽纯函数配 vitest |

## 2. 总体架构

```
┌─────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ bench 配置   │   │  trace 选择器          │   │  providers 解析        │
│ *.json       │──▶│  phase+date+roles→文件 │   │  $ENV→环境变量         │
└─────────────┘   └──────────┬───────────┘   └──────────┬───────────┘
                             │                           │
                             ▼                           ▼
                  ┌──────────────────────────────────────────┐
                  │  回放执行器（replayRunner）                  │
                  │  对每个 trace × config × repeat 调 callLLM  │
                  │  临时 TraceLogger（写 tmpdir）复用限流/重试    │
                  │  RateLimitCoordinator 按 provider 隔离       │
                  │  失败不中断，记 ok:false+error                │
                  └──────────────────────┬─────────────────────┘
                                         │ raw calls[]
                                         ▼
                  ┌──────────────────────────────────────────┐
                  │  统计计算器（computeStats）——纯函数            │
                  │  耗时分位 / 成功率 / tokens 中位数 /          │
                  │  CV / 众数一致率 / top-K 一致率 / 解析成功率    │
                  └──────────────────────┬─────────────────────┘
                                         │
                            ┌────────────┴────────────┐
                            ▼                         ▼
                  ┌──────────────┐          ┌────────────────┐
                  │ report.md    │          │ results.json    │
                  │ 概览+稳定性+  │          │ 全部原始输出     │
                  │ 逐样本网格     │          │（评判依据）       │
                  └──────────────┘          └────────────────┘
```

### 2.1 新增文件

| 文件 | 角色 |
|------|------|
| `src/llm-bench-cli.ts` | CLI 入口：读配置→选 trace→回放→写产物。`npm run bench` |
| `src/watchlist/bench-runner.ts` | 回放执行器 + 统计计算器（纯函数，可单测） |
| `src/watchlist/bench-types.ts` | 配置/结果/统计的 TypeScript 接口 |
| `bench/*.json` | 评估配置文件目录（示例配置随设计提交） |
| `tests/ts/bench-stats.test.ts` | 统计计算器单元测试（fixture，不调真 API） |

### 2.2 复用现有基础设施

| 复用项 | 来源 | 用途 |
|--------|------|------|
| `callLLM` | `src/llm-client.ts` | 回放的单次调用——白拿重试/429 退避/超时/cost 计算 |
| `TraceLogger` | `src/trace-logger.ts` | 临时实例（tmpdir），仅满足 callLLM 签名要求，bench 不依赖其 trace 文件 |
| `RateLimitCoordinator` | `src/llm-client.ts` | 按 provider 隔离限流协调 |
| `extractTaggedJson` | `src/llm-client.ts` | 解析回放输出（rank 用 json_object 直出，shallow 同理） |

## 3. 配置文件 Schema

配置文件放 `bench/` 目录（属评估输入，入 git）。`api_key` 支持 `$ENV` 前缀读环境变量。

```jsonc
{
  "name": "glm5.2-thinking-vs-deepseek",
  "note": "对比 GLM-5.2 开关 thinking 与 DeepSeek 的 shallow 质量",

  // 从哪些 trace 回放
  "traces": {
    "phase": "rebalance",            // "rank" | "rebalance"
    "date": "2026-06-23",            // 可选，缺省取该 phase 最新日期
    "roles": ["analyst-shallow"],    // 可选过滤；缺省=该 phase 全部 role
    "limit": 4                       // 可选，最多取 N 个 trace（避免一次跑太多）
  },

  // 每个选中 trace 跑几次（压制随机性）
  "repeats": 5,

  // 厂商定义，key 支持 $ENV 读环境变量（避免明文进 git）
  "providers": {
    "zhipu":    { "base_url": "https://open.bigmodel.cn/api/coding/paas/v4", "api_key": "$ZHIPU_API_KEY" },
    "deepseek": { "base_url": "https://api.deepseek.com",                     "api_key": "$DEEPSEEK_API_KEY" }
  },

  // 要对比的配置（≥2 个才有意义；允许 1 个做基线重测）
  "configs": [
    { "id": "glm-thinking-on",  "provider": "zhipu",    "model": "glm-5.2",
      "thinking": { "type": "enabled" },  "temperature": 0, "max_tokens": 32000,
      "responseFormat": { "type": "json_object" } },
    { "id": "glm-thinking-off", "provider": "zhipu",    "model": "glm-5.2",
      "thinking": { "type": "disabled" }, "temperature": 0, "max_tokens": 32000,
      "responseFormat": { "type": "json_object" } },
    { "id": "deepseek",         "provider": "deepseek", "model": "deepseek-chat",
      "temperature": 0, "max_tokens": 32000 }
  ]
}
```

### 3.1 字段语义

| 字段 | 必填 | 语义 |
|------|------|------|
| `name` | 是 | bench 名称，用作产物目录名前缀 |
| `traces.phase` | 是 | `"rank"` → `scan/{date}/traces/`；`"rebalance"` → `rebalance/{date}/traces/` |
| `traces.date` | 否 | 缺省扫描该 phase 下所有日期取最新 |
| `traces.roles` | 否 | 按 trace 文件名前缀（=role）过滤，如 `["analyst-shallow", "risk-shallow"]` |
| `traces.limit` | 否 | 取前 N 个 trace 文件（按文件名排序） |
| `repeats` | 是 | 每个选中 trace × 每个配置跑几次 |
| `providers` | 是 | 厂商池；`api_key` 若以 `$` 开头则读对应环境变量，否则当字面量 |
| `configs[].id` | 是 | 配置标识，报告里用它做列名 |
| `configs[].provider` | 是 | 引用 `providers` 里的 key |
| `configs[].model` | 是 | 模型名 |
| `configs[].thinking` | 否 | 透传 callLLM，如 `{ "type": "disabled" }` |
| `configs[].responseFormat` | 否 | 透传 callLLM，如 `{ "type": "json_object" }` |
| `configs[].temperature` | 否 | 缺省 callLLM 默认值（0.4） |
| `configs[].max_tokens` | 否 | 缺省 `LLM_DEFAULT_MAX_TOKENS`（32000） |

### 3.2 覆盖的对比场景

三种场景都是 `configs[]` 数组的不同写法，无需额外参数：

| 场景 | configs 写法 |
|------|-------------|
| 跨厂商 | 多个 config 引用不同 provider |
| 同厂商不同模型 | 同 provider，model 不同 |
| 同模型不同参数 | 同 provider+model，thinking/temperature/max_tokens 不同 |

## 4. 回放执行流程

```
对每个选中的 trace 文件（M 个）:
  对每个 config（C 个）:
    对每次 repeat（N 次）:
      → 取 trace.request.{system_prompt, user_message} 作为输入（绝不重新生成 prompt）
      → 用 config 的 provider/model/thinking/temperature/max_tokens 调 callLLM
      → 记录: { trace_id, config_id, repeat_index, content, duration_ms, usage, ok, error }
```

### 4.1 设计决策

**prompt 来源**：直接用 `trace.request.system_prompt` + `trace.request.user_message` 原样回放。工具不碰 prompt 内容。rank 的 12KB user_message、shallow 的多 KB 上下文全部从 trace 读。

**复用 callLLM**：bench 给每个 run 建一个**临时 TraceLogger**（`os.tmpdir()` 下），仅满足 callLLM 强制要求的 `traceLogger` 参数签名。bench 不依赖其写出的 trace 文件（跑完即弃），但白拿 callLLM 的：重试逻辑、429 指数退避、`LLM_TIMEOUT_MS` 超时、`calculateCost` 成本计算。不在 bench 里重写第二套调用逻辑。

**并发控制**：
- 同 config 内 repeats **串行**（避免单 provider 自己把自己打满 429）
- 不同 config **可并行**，但同 provider 的 config 共享一个 `RateLimitCoordinator`（一个 429 让同 provider 其他调用退避），不同 provider 各自独立
- 默认全并行不同 config；若同 provider 多 config，由共享 coordinator 自然串行化限流

**失败处理**：单次调用失败（超时 / 429 耗尽 / content 空）不中断整批，记为 `ok:false + error`。失败率本身是质量/可用性信号，在报告概览单独成列。某配置频繁失败 = 不可用，这是评估该结论的一部分。

**解析**：调用后对 `raw_content` 做 JSON 解析（rank/shallow 均用 json_object 模式直出 JSON）。解析成功则提取关键字段入 `parsed`，失败记 `_parse_ok:false`。结构完整性作为独立指标统计。

## 5. 产物格式

每次 bench run 在 `~/.openclaw/watchlist/bench/` 下建目录，产出两文件：

```
~/.openclaw/watchlist/bench/<config.name>-<timestamp>/
├── report.md        # 人类/ZCode 阅读的对比报告（主载体）
└── results.json     # 全部原始输出（评判依据，精确回查）
```

### 5.1 results.json 结构

```jsonc
{
  "bench_name": "glm5.2-thinking-vs-deepseek",
  "config_path": "bench/glm-vs-deepseek.json",
  "started_at": "2026-06-24T...",
  "finished_at": "...",
  "trace_count": 4,            // 选中 4 个 trace 文件
  "repeats": 5,
  "config_count": 3,
  "total_calls": 60,           // 4×3×5
  "traces": [                  // 选中的 trace 元信息
    { "file": "analyst-shallow-trace-...json", "role": "analyst-shallow", "phase": "rebalance",
      "ticker": "002167", "baseline_duration_ms": 8421,
      "baseline_parsed": { "fitness_score": 4 } }     // trace 原始输出的解析字段
  ],
  "results": [                 // 每条 = 一次调用
    {
      "trace_file": "...", "config_id": "glm-thinking-on", "repeat": 0,
      "ok": true,
      "duration_ms": 9120, "usage": { "prompt_tokens": 2150, "completion_tokens": 380, "total_tokens": 2530 },
      "cost_usd": 0.012,
      "raw_content": "...完整原始输出...",               // 评判时逐字读
      "parsed": { "fitness_score": 7, "thesis": "...", "_parse_ok": true }
    },
    { "trace_file": "...", "config_id": "glm-thinking-off", "repeat": 0, "ok": false, "error": "429 exhausted" }
  ]
}
```

`raw_content` 完整保留——这是 ZCode 评判质量的逐字依据。`parsed` 存解析后的关键字段（rank: `ranked` 数组；shallow analyst: `fitness_score`/`thesis`；shallow risk: `overall_risk`/`risk_flags`/`deal_breaker`）+ `_parse_ok` 标志。

### 5.2 report.md 结构

```markdown
# Bench: glm5.2-thinking-vs-deepseek
日期 2026-06-23 · 4 traces × 5 repeats × 3 configs = 60 calls · 失败 2

## 概览（按 config 汇总）

| config | 成功率 | 耗时中位数 | p90 耗时 | prompt tok 中位 | completion tok 中位 | 解析成功率 | cost |
|--------|--------|-----------|---------|----------------|--------------------|-----------|------|
| glm-thinking-on  | 20/20 | 9.1s  | 14.2s | 2150 | 380 | 20/20 | $0.12 |
| glm-thinking-off | 20/20 | 3.2s  | 5.1s  | 2150 | 210 | 20/20 | $0.07 |
| deepseek         | 18/20 | 4.5s  | 6.8s  | 2050 | 240 | 18/18 | $0.09 |

## 稳定性（按 config × trace 汇总）

| config | trace(002167) | trace(600519) | ... |
|--------|---------------|---------------|-----|
| glm-thinking-on  | fitness CV=0.08 | fitness CV=0.12 | ... |
| glm-thinking-off | fitness CV=0.21 | fitness CV=0.35 | ... |
| deepseek         | fitness CV=0.15 | fitness CV=0.20 | ... |

（rank phase 时此表换为 top-K 一致率 + 分数差均值）

## 逐样本（每只股票/每个 rank 组一块）

### 002167 东方锆业 (analyst-shallow)
trace 基线 fitness=4 (8.4s)
| config | rep0 | rep1 | rep2 | rep3 | rep4 |
|--------|------|------|------|------|------|
| glm-thinking-on  | f=4 | f=4 | f=5 | f=4 | f=4 |
| glm-thinking-off | f=4 | f=5 | f=6 | f=3 | f=5 |
| deepseek         | f=4 | f=4 | f=4 | f=4 | f=4 |
（thesis / ranked 全文见 results.json 对应条目）

### rank long-ranker
trace 基线 top-3: 1.002167 2.600519 3.000725
| config | top-3 一致率 | 分数差均值 | 耗时中位 |
...
```

### 5.3 产物取舍

report.md **不**把每条 thesis/ranked 全文贴进来（4 trace × 3 config × 5 repeat = 60 段长文本会让 md 爆炸）。md 只放分数网格 + 概览 + 稳定性汇总，逐字明细全部在 results.json。这样 md 保持可读，json 保持完整。ZCode 评判时优先读 results.json。

## 6. 统计指标定义

报告里每个数字的计算口径，定死后实现无歧义。

### 6.1 耗时统计（per config，跨该 config 所有成功调用）

- **中位数 / p90**：对该 config 所有 `ok:true` 的 `duration_ms` 排序取分位。p90 索引 = `ceil(0.9 * n) - 1`。
- 失败调用不纳入耗时分布（无正常返回），但计入成功率分母。

### 6.2 成功率（per config）

- `成功数 / 应调用数`，应调用数 = trace 数 × repeats。
- `ok:true` 判定：callLLM 正常返回且 `raw_content` 非空。content 为空（callLLM 兜底空串）也算失败。

### 6.3 tokens / cost（per config）

- **prompt_tokens / completion_tokens 取中位数**（不是总和——总和受调用数影响，中位数反映单次开销）。
- **cost 单列该 config 总 cost**（跨成功调用累加），用于横向比成本。

### 6.4 稳定性 — shallow analyst（数值型，per config × trace）

- 提取字段：`fitness_score`（数值）。
- 对「同一 trace × 同一 config」的 N 个 repeat 的 fitness 值算：
  - **CV（变异系数）** = 标准差 / |均值|。均值=0 时记 `null` 并标注。
  - 另附**分布**（每个值出现次数）和**极差**（max - min），放逐样本块。
- CV 越小 = 越收敛。

### 6.5 稳定性 — shallow risk（离散型，per config × trace）

risk-shallow 输出无单一数值字段（`overall_risk` 是 high/medium/low 枚举 + `risk_flags` 数组 + `deal_breaker` bool），不强行套数值 CV：
- **`overall_risk` 众数一致率**：N 个 repeat 里出现最多的值占比。例 5 次里 4 次 high → 80%。
- **`risk_flags` 数量 CV**：flag 个数的变异系数（抓取风险点数量是否稳定）。
- **`deal_breaker` true 占比**。

### 6.6 稳定性 — rank（排序型，per config × trace）

- 对「同一 trace × 同一 config」的 N 个 repeat，每个解析出 `ranked` 数组（ticker 列表）。
- **top-K 一致率**（K=3）：所有 repeat 两两组合，计算 top-3 重叠率（交集数 / 3），求平均。N=5 时有 C(5,2)=10 对。
- **分数差均值**：对 baseline 每个 ticker，取各 repeat 分数，算与 baseline 的平均绝对差（复用现有 mjs `compareRankings` 逻辑）。

### 6.7 结构完整性（per config）

- **解析成功率**：`parsed._parse_ok=true` 占比。
- 解析失败的具体错误（JSON 坏、字段缺）记入 results.json 的 `parsed`，md 概览只放占比。

### 6.8 ticker 提取（从 user_message）

- **rank trace**：user_message 本身是多股摘要，ticker 在 `### 1. SH600353 ...` 标题里。trace 元信息用 role（`long-ranker`/`short-ranker`）标识，不强提 ticker。
- **shallow trace**：user_message 含单股上下文，用正则 `(?:(?<=ticker|股票)[^A-Z]*)([A-Z0-9]{6,8})` 提取；提不出标 `unknown`。

## 7. CLI 接口

```
npm run bench -- --config bench/glm-vs-deepseek.json
node dist/llm-bench-cli.js --config bench/glm-vs-deepseek.json [--watchlist-dir <dir>] [--dry-run]
```

| 参数 | 语义 |
|------|------|
| `--config <path>` | 必填，bench 配置文件路径 |
| `--watchlist-dir <dir>` | 可选，覆盖默认 `~/.openclaw/watchlist`（trace 来源 + 产物输出根） |
| `--dry-run` | 可选，只解析配置 + 列出将回放的 trace 清单与总调用数（= trace 数 × 配置数 × repeats），不真正调 LLM。用于跑前确认耗时与费用 |

### 7.1 错误处理

- 配置文件缺字段 / provider 引用不存在 / `$ENV` 变量未设 → 报错退出，提示具体缺失项。
- `--dry-run` 列出选中 trace 列表 + 总调用数 + 预估总调用数，供跑前评估耗时和费用。
- 回放中途整体异常（配置全错）退出码 1；单条调用失败不退出（记入 results）。

## 8. 测试策略

| 层级 | 范围 | 方式 |
|------|------|------|
| 统计计算器 | CV / 众数一致率 / top-K 一致率 / 分位数 | vitest，fixture 数组断言，纯函数无 LLM 无 IO |
| 配置解析 | `$ENV` 展开、provider 引用校验、字段缺省 | vitest，构造配置对象断言 |
| 回放执行器 | 失败不中断、并发不串结果 | vitest，mock callLLM 返回固定/抛错序列，断言 results 结构 |
| 产物格式化 | report.md / results.json 结构 | vitest，fixture 调用结果断言输出包含预期表头/字段 |

不测真实 LLM 调用（与项目现有测试约定一致——所有外部调用 mock）。

## 9. 范围外（明确不做）

- **不覆盖 `trading_quick` / `trading_full` 的 analyst/debate/risk traces**——仅 watchlist rank/rebalance。如未来需要可扩 phase 枚举。
- **不跨日期混合采样**——`traces.date` 是单值。
- **不内置 LLM judge**——质量判断由 ZCode 读产物完成，工具不内置第二层评判模型（避免 judge 偏见与额外成本）。
- **不交互式选 trace**——配置文件驱动，无 TUI。
- **不替换/改动现有 trace 产出逻辑**——只读 trace，不改 rank-cli/rebalance-cli。

## 10. 迁移与清理

- 新工具上线后，`tests/thinking-compare.mjs` 的能力被 `bench/` 配置完全覆盖（thinking on/off 只是 configs 数组的一种写法）。
- 不立即删除 `thinking-compare.mjs`（保留作历史参考）；在其顶部加注释指向新工具。
- 示例配置 `bench/thinking-on-off.json` 复刻原脚本对比场景，作为迁移示范。
