# 延期设计：跨次记忆（P3）与自我反思（P2-a）

> **状态**：延期，未实现。本文档为**实现级深度设计**，供后期立项时直接参考。
> **依赖关系**：P2-a 的"跨次复盘"形态**依赖** P3 记忆系统才能落地；P2-a 的"in-run 一致性校验"形态可独立先做。
> **来源**：竞品 TradingAgents-AShare（详见 [../competitor-analysis.zh.md](../competitor-analysis.zh.md) §2.5、§5）。

---

## 0. TL;DR

| 项 | 一句话 | 是否依赖 P3 |
|---|---|---|
| **P3 跨次记忆** | 把每次分析的"情境→决策"存档，下次分析时检索相关历史经验注入 prompt | — |
| **P2-a 反思（in-run）** | 单次运行内，研究经理决策后做一次"一致性校验"（核 Hold 条件 / 证据一致 / 置信度校准） | 否，可先做 |
| **P2-a 反思（cross-run）** | TA 式跨次复盘：本次判成败→写入记忆→下次借鉴 | **是**，等 P3 |

**推荐实施顺序**：P2-a(in-run) → P3(记忆) → P2-a(cross-run 复盘)。

---

## 1. 背景：TradingAgents-AShare 怎么做（已源码核实）

### 1.1 记忆（memory）
- `tradingagents/graph/setup.py:65-81` 为 5 个角色各建独立记忆：`bull_memory` / `bear_memory` / `trader_memory` / `invest_judge_memory` / `risk_manager_memory`。
- 记忆源自上游 TradingAgents（LangGraph）的全局记忆组件，按**情境相似度检索**过往建议。
- 关键 API：`memory.add_situations([(situation, result)])` 写入；agent 节点构造时传入对应 memory，运行时检索相关条目。

### 1.2 反思（reflection）—— ⚠️ 在 TA 中是死代码
- `tradingagents/graph/reflection.py` 定义 `Reflector(quick_thinking_llm)`，`invoke` 在 `reflection.py:42`。
- `tradingagents/graph/trading_graph.py:468` 的 `reflect_and_remember` 方法**定义了但全代码库无任何调用**（API / backtest / tests 都未触发）。当前 pipeline 实际 +0 调用。
- 反思 prompt（`tradingagents/prompts/zh.py:331` `reflection_system_prompt`）：
  > 你是资深交易复盘分析师……1. 判断本次决策是成功还是失败，并给出客观依据。2. 拆解成因：市场环境、技术面、情绪面、新闻面、基本面分别起了什么作用。3. 指出可改进项……4. 输出未来可执行的修正动作……5. 给出可复用经验清单……
- 若启用：对 bull/bear/trader/invest_judge/risk_judge 各反思 1 次 → **+5 LLM 调用**。
- 产出**仅写入 per-agent memory**（`memory.add_situations`），**不改当前决策、不循环、纯标注**。

### 1.3 关键结论
**TA 的反思与记忆是耦合的**：反思的价值闭环 = "本次复盘 → 写记忆 → 下次同类标的检索借鉴"。没有记忆系统，反思结果无处落地。这正是我们暂缓照搬的原因——**不是抄一段代码，而是要建一套子系统**。

---

## 2. 为什么现在暂缓

1. **P3 是架构性改动**：引入持久化存储 + 检索 + 注入管线，触及配置、types、orchestrator、所有 agent prompt、报告存储。非加法式小改。
2. **outcome 回录是难点**：记忆要"有用"必须有"结果"（决策对不对）。自动获取结果需要价格随访（N 日前向收益）或人工标注——两者都需额外基础设施。在 outcome 缺失前，记忆只是"我上次这么说过"，价值有限。
3. **P2-a(cross-run) 没有记忆就没落点**（见 1.3）。
4. **当前优先级**：P0–P2 的独立可落地项已全部上线（decision_deep / Hold 门 / 方向锚定 / financial_health / market 维度纪律）。这两个是"下一阶段"事项。

---

## 3. P3 深度设计：跨次 per-agent 记忆

### 3.1 目标
每次分析后把"**情境摘要 → 决策 → (后续)结果**"持久化；下次分析时按相关性检索历史，注入对应角色的 prompt 作为"历史经验回看"，形成跨次学习闭环。

### 3.2 存储布局

复用现有 `report_dir`（`~/.openclaw/trading-reports/`），新增 `_memory/` 子目录：

```
~/.openclaw/trading-reports/
├── 600519/                     # 单次报告（现有）
│   └── 2026-06-09_full/
└── _memory/                    # 新增：跨次记忆
    ├── index.json              # 索引：entry_id → {role, ticker, industry, date, tags}
    ├── entries/                # 每条记忆一个 JSON 文件（或改 SQLite）
    │   ├── 0001.json
    │   └── ...
    └── embeddings/             # 可选：向量索引（Phase C）
```

**单条记忆 schema**（`entries/<id>.json`）：
```jsonc
{
  "id": "0001",
  "role": "research_manager",          // bull|bear|trader|invest_judge|risk_manager（先做这 5 个）
  "ticker": "600519",
  "industry": "白酒",                  // 来自 stock_info.industry，便于跨标的检索
  "date": "2026-06-09",
  "situation_digest": "PE 30x 处于 5 年 60%分位；MA 多头排列；北向 5 日净流入；商誉占比 0%",
  "decision": { "direction": "Overweight", "confidence": 0.72, "bull_score": 75, "bear_score": 45 },
  "key_claims": ["北向持续流入", "估值回归合理"],   // 决策依据摘要（≤5 条）
  "tags": ["消费", "外资流入", "低估回归"],         // 检索/聚类用
  "outcome": null,                      // Phase B 填写：{horizon_days, forward_return, hit, note}
  "reflection": null,                   // P2-a(cross-run) 填写：复盘文本 + 可复用经验
  "created_at": "2026-06-09T11:30:00Z"
}
```

> **选择 JSON 而非 SQLite**：与现有 report-store.ts 风格一致、零依赖、易审阅；条目量级（百~千级）下检索性能足够。若后续上量再迁 SQLite/向量库。

### 3.3 写入时机与内容
- **时机**：`runFullAnalysis` 末尾、`saveFull()` 之后（详见 `src/orchestrator.ts` `runFullAnalysis`）。
- **内容来源**：复用已产出的结构化数据——
  - `situation_digest`：从 7 个分析师报告 + 辩论关键论点（`DebateResult.rounds[].*_claims`）各取 1-2 句拼接，**控制 ≤300 字**（避免膨胀）。
  - `decision` / `key_claims`：直接取 `ResearchDecision` + `key_debate_points`。
  - `industry` / `tags`：取 fundamentals 的 `stock_info.industry` + 由研究经理产出（可加一个 `tags` 字段到 `ResearchDecision`）。

### 3.4 检索与注入
- **时机**：`runAnalystPhase` 之前（数据/分析师 prompt 渲染前），按当前 ticker + industry 检索。
- **检索策略（分阶段）**：
  - **Phase A（无向量）**：精确匹配 ticker → 同 industry → 按 tags 重叠。取 top-3~5 条，优先有 `outcome` 的。
  - **Phase C（向量）**：对 `situation_digest` 做 embedding，余弦相似 top-k。需引入 embedding 模型（可复用 GLM embedding 或本地 sentence-transformers）。
- **注入**：所有 agent prompt 模板新增 `{{memory}}` 占位符；渲染时填入检索到的历史条目**摘要**（只放 situation_digest + decision + outcome 命中与否，**不放长文**），格式：
  ```
  ## 历史经验回看（同类情境，供参考非结论）
  - [2026-05-12 同行业白酒] 当时有"北向流入+低估"信号→判 Overweight，5日后 +3.2%（命中）。本案注意……
  - [2026-04-01 本标的] 上次判 Hold（量价无趋势），后 5 日 -1.1%（小幅命中）。……
  ```
- **新增文件**：`src/memory-store.ts`（`loadRelevantMemory(ticker, industry, tags, topK)` / `writeMemoryEntry(entry)`）。

### 3.5 outcome 回录（Phase B，难点）
记忆"有用"的前提是知道决策对错。两条路：
1. **自动：价格随访**——分析日 T 的决策，记录 T+1/T+5/T+20 前向收益，对照方向（Buy/Overweight 看涨、Sell/Underweight 看跌、Hold 看震荡）。需一个**离线随访任务**（cron 或下次同标的分析时补录），读 kline 历史。
   - 实现：`scripts/backfill-outcome.ts`，遍历无 outcome 的 entries，按 ticker+date 查 K 线计算前向收益，回填 `outcome`。
2. **人工：用户标注**——`trading_report` 工具或 dashboard 加一个"标记对错"入口。

**建议**：先 Phase A（无 outcome，仅"我上次这么说过"回看），再 Phase B 自动随访（价值跃升），Phase C 向量检索。

### 3.6 集成清单（实现时要动的）
| 文件 | 改动 |
|---|---|
| `src/types.ts` | 新增 `MemoryEntry` 接口；`ResearchDecision` 加可选 `tags?: string[]` |
| `src/memory-store.ts` | **新建**：读写 `_memory/` |
| `src/orchestrator.ts` | `runFullAnalysis` 末尾写入；`runAnalystPhase` 前检索注入 |
| `skills/trading-analysis/prompts/**/*.md` | 各模板加 `{{memory}}` 占位符（默认空字符串，向后兼容） |
| `src/index.ts` | config 加 `memory_enabled?: boolean`、`memory_dir?` |
| `tests/ts/memory_store.test.ts` | **新建**：写入/检索/降级（无记忆→空注入） |

### 3.7 风险与开放问题
- **记忆污染**：早期错误决策会污染检索。对策：Phase B 有了 outcome 后，检索时**优先高命中率的条目**，低命中标注"前车之鉴"。
- **注入膨胀**：历史条目挤占上下文。硬限制 top-3、每条 ≤80 字摘要。
- **数据时效**：旧记忆可能过时（公司基本面变化）。加 `max_age_days` 过滤（默认 180 天）。
- **同标的不同情境**：同 ticker 不同时点情境差异大——靠 `situation_digest` 相似度而非纯 ticker 匹配缓解（Phase C 向量）。
- **隐私/审阅**：本地 JSON 可手动编辑/删除误条目。

---

## 4. P2-a 深度设计：自我反思（两种形态）

### 4.1 形态一：in-run 决策一致性校验（可先做，不依赖 P3）

**位置**：`runResearchManager` 之后、`runTrader` 之前（full 模式）。**+1 调用，不循环**。

**为什么不学 TA 的泛泛"判成败"**：LLM self-critique 通病是"自信地啰嗦"，advisory 沦为噪声。用**具体可查的清单**对冲：

| 检查项 | 查什么 | 命中处置 |
|---|---|---|
| **Hold 闸门回核**（衔接 P1-b） | 若判 Hold，"无趋势/无资金/无催化剂"三条件是否**逐条**有数据支撑？还是挥手？ | flag `hold_gate_unsubstantiated` |
| **证据-结论一致性** | 方向是否引用了辩论中**最强**论点（按 confidence/得分），还是 cherry-pick 弱论点？ | flag `weak_evidence_basis` |
| **置信度校准** | confidence 是否与 `bull_score - bear_score` 匹配？（如 75 vs 45 却给 0.5 = 失配） | 建议 `confidence_delta` |

**产出协议**（复用现有 HTML 注释 JSON 模式，第 5 个结构化协议）：
```
<!-- REFLECTION: {
  "hold_gate_ok": true,
  "evidence_consistent": true,
  "confidence_suggested": 0.72,
  "confidence_delta": 0.0,
  "caveats": ["置信度略低于多空得分差所暗示，已上调 0.05"],
  "action": "keep"            // keep | adjust_confidence | re_look
} -->
```

**能否行动**：命中失配时**实际调整 confidence**（写入 `ResearchDecision.confidence`），否则价值打折——advisory-only 不值得加。

**新增/改动**：
| 文件 | 改动 |
|---|---|
| `src/reflection.ts` | **新建**：`runReflection(decision, debate, config, client, trace)` + `parseReflection()` |
| `skills/trading-analysis/prompts/debate/reflection.md` | **新建**：反思 prompt + REFLECTION 协议要求 |
| `src/types.ts` | `ReflectionResult` 接口；`ResearchDecision` 加 `reflection?: ReflectionResult` |
| `src/orchestrator.ts` | research manager 后插入 reflection 调用；按 `action` 调整 confidence |
| `src/llm-client.ts` | （复用 callLLM，phase: "reflection"） |
| `tests/ts/reflection.test.ts` | **新建**：解析/校准/降级 |

**价值/风险（诚实）**：中价值。收益不确定（self-critique 证据混杂）。**建议做完后跑 5-10 只票对比**（有/无 reflection 的决策稳定性）再定保留力度。强在"具体清单"——核 Hold 条件、证据引用、置信度匹配都是可判定的，比"反思成败"锐利。

### 4.2 形态二：cross-run 复盘（依赖 P3）

即 TA 的形态：分析后判成败→写记忆。**必须等 P3 记忆落地**才有落点。

**与 P3 的接口**：`runFullAnalysis` 末尾，若 `outcome` 可得（Phase B 随访已回填历史条目）或本次为补录，调 `runReflection(cross-run)` 产出 `reflection` 文本 + `可复用经验清单`，写入对应角色的 `MemoryEntry.reflection`。

**反思 prompt**：直接参考 TA `zh.py:331` 的 `reflection_system_prompt`（判成败→拆解成因→改进项→可复用经验清单），中文化适配我们的 5 角色与 A 股维度。

**触发条件**：仅当该次决策有 `outcome`（随访已回填）时才值得复盘——否则判不了成败。

---

## 5. 推荐实施顺序与里程碑

1. **P2-a(in-run 一致性校验)** —— 独立、+1 调用、可量化。先做，验证 self-critique 在我们 pipeline 的实际收益。
2. **P3 Phase A** —— 记忆存储 + 同 ticker/industry 检索注入（无 outcome）。建立基础设施。
3. **P3 Phase B** —— outcome 自动随访（`backfill-outcome.ts`）。记忆价值跃升。
4. **P2-a(cross-run 复盘)** —— 接 P3，判成败写记忆，闭环。
5. **P3 Phase C** —— 向量检索（embedding），跨标的情境相似度。

---

## 6. 验证计划（实施时）

- **P2-a(in-run)**：A/B 跑 5-10 只票（有/无 reflection），对比决策稳定性、置信度合理性、是否拦截明显失配。
- **P3 Phase A/B**：构造历史记忆 fixture，验证检索召回 + 注入不膨胀 + 向后兼容（无记忆→空 `{{memory}}`）。
- **回归**：`npm test` 全绿；新增 memory_store / reflection 测试。

---

## 7. 参考溯源

| 事实 | TA 源码位置 |
|---|---|
| 5 角色独立记忆 | `TradingAgents-AShare/tradingagents/graph/setup.py:65-81` |
| Reflector 类 | `TradingAgents-AShare/tradingagents/graph/reflection.py`（invoke L42） |
| 反思方法（**死代码，未调用**） | `TradingAgents-AShare/tradingagents/graph/trading_graph.py:468` `reflect_and_remember` |
| 反思 prompt 原文 | `TradingAgents-AShare/tradingagents/prompts/zh.py:331` `reflection_system_prompt` |
| memory API | `memory.add_situations([(situation, result)])` |

> 本项目相关：`src/orchestrator.ts`（`runFullAnalysis`/`runAnalystPhase`）、`src/report-store.ts`（`saveFull`）、`src/quality-gate.ts`（输入层预检，**不与反思重叠**）、`docs/competitor-analysis.zh.md` §2.5。
