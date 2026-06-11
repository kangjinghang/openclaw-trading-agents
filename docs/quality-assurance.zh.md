# 报告质量保证体系评估

> 基于 601111（中国国航）2026-06-11 Full 模式报告的深度审查
> 版本: 2.0（修正版）

---

## 一、Pipeline 产物全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        完整 Pipeline 产物清单                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Stage 0: 数据采集                                                          │
│  ├── 07_data/market_raw.json          (K线 OHLCV 120条)                    │
│  ├── 07_data/fundamentals_raw.json    (PE/PB/ROE/财报)                     │
│  ├── 07_data/news_raw.json            (个股+宏观新闻)                       │
│  ├── 07_data/sentiment_raw.json       (情绪指标)                           │
│  ├── 07_data/policy_raw.json          (政策事件)                           │
│  ├── 07_data/hot_money_raw.json       (北向/主力/龙虎榜+行业排名)          │
│  └── 07_data/lockup_raw.json          (解禁/减持)                          │
│                                                                             │
│  Stage 1: 分析师报告 (7个)                                                   │
│  ├── 01_analysts/market.json          (技术面)                             │
│  ├── 01_analysts/fundamentals.json    (基本面)                             │
│  ├── 01_analysts/news.json            (新闻)                               │
│  ├── 01_analysts/sentiment.json       (情绪)                               │
│  ├── 01_analysts/policy.json          (政策)                               │
│  ├── 01_analysts/hot_money.json       (资金面)                             │
│  └── 01_analysts/lockup.json          (解禁)                               │
│                                                                             │
│  Stage 2: 质量门控                                                          │
│  └── 00_quality.json                  (Layer-1 + Layer-2)                  │
│                                                                             │
│  Stage 3: 多空辩论 (2轮)                                                    │
│  ├── 02_debate/round_1.json                                                │
│  └── 02_debate/round_2.json                                                │
│                                                                             │
│  Stage 4: 研究经理                                                          │
│  └── 03_research.json                                                      │
│                                                                             │
│  Stage 5: 交易员                                                            │
│  └── 04_trading_plan.json                                                  │
│                                                                             │
│  Stage 6: 风控                                                              │
│  ├── 05_risk/risk_debate.json                                               │
│  └── 05_risk/risk_manager.json                                              │
│                                                                             │
│  Stage 7: 审计追踪                                                          │
│  ├── 06_traces/run_summary.json       (运行元数据)                         │
│  └── 06_traces/*/trace-*.json         (23个LLM调用trace)                   │
│                                                                             │
│  Stage 8: 最终报告                                                          │
│  ├── ${ticker}_${date}_${mode}.json   (汇总JSON)                          │
│  ├── report.md                        (Markdown报告)                       │
│  └── report.html                      (HTML报告)                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

注: sector（行业排名）数据已合并到 hot_money.py，不是独立脚本。
    07_data 中没有 sector_raw.json 是正常的。
```

---

## 二、产物质量评估矩阵

| 产物 | 数据完整性 | 结构化程度 | 可审计性 | Agent可用性 | 人类可读性 |
|------|-----------|-----------|---------|------------|-----------|
| **07_data/*.json** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **01_analysts/*.json** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **00_quality.json** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **02_debate/*.json** | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **03_research.json** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| **04_trading_plan.json** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **05_risk/*.json** | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **06_traces/*.json** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **最终报告** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

---

## 三、已有质量保证能力（已实现）

### 3.1 数据采集层（Stage 0）

| 检查项 | 实现位置 | 严重度 | 说明 |
|--------|---------|--------|------|
| 数据源成功率检查 | `orchestrator.ts` CP1 | abort | ≥6 失败中止流水线 |
| K线条数完整性 | `orchestrator.ts` | warn | 需 ≥50 条（技术指标要求） |
| 数据新鲜度检查 | `orchestrator.ts` | warn | 近期分析需检查数据时效 |

### 3.2 分析师质量层（Stage 1-2）

| 检查项 | 实现位置 | 严重度 | 说明 |
|--------|---------|--------|------|
| Layer-1 确定性门控 | `quality-gate.ts` | 多级 | 空报告/F级、失败标记、长度、数据缺失哨兵 |
| Layer-2 LLM 可信度复核 | `quality-review.ts` | warn | 识别数据捏造、陈旧数据、内部矛盾 |
| VERDICT 解析检查 | `quality-gate.ts` | warn | 检查 direction 是否可解析 |
| 字段引用检查 | `quality-gate.ts` | warn | 检查分析师是否真正使用了数据（关键词+数值引用） |
| 模板渲染门 | `orchestrator.ts` CP2 | abort | 检查 prompt 模板是否正确渲染 |

### 3.3 跨阶段一致性层（Stage 6-8）

| 检查项 | 实现位置 | 严重度 | 说明 |
|--------|---------|--------|------|
| 目标价方向检查 | `cross-stage-checks.ts` | warn | Buy 方向但目标价低于现价 |
| 止损价方向检查 | `cross-stage-checks.ts` | warn | Buy 方向但止损价 ≥ 现价 |
| 分析师共识冲突 | `cross-stage-checks.ts` | warn | 看空多数但研究方向为 Buy |
| 保守风控被否决 | `cross-stage-checks.ts` | warn | 保守风控 reject 但最终 pass |
| 风控重试耗尽 | `cross-stage-checks.ts` | warn | revise 重试后仍未通过 |
| reject 但有执行计划 | `cross-stage-checks.ts` | error | 风控拒绝但仍有非空执行计划 |

### 3.4 流水线健康监控

| 检查项 | 实现位置 | 说明 |
|--------|---------|------|
| PipelineHealth 收集器 | `pipeline-health.ts` | 贯穿全流程，收集各阶段问题 |
| 运行元数据 | `run_summary.json` | 记录 duration、tokens、cost、warnings |
| 问题持久化 | `report-store.ts` | pipeline_health + cross_stage_issues 写入报告 |

---

## 四、从 AI Agent 角度评估

### 4.1 已具备的能力

| 检查项 | 产物来源 | 实现状态 |
|--------|---------|---------|
| **数据完整性检查** | `07_data/*.json` → `success` | ✅ CP1 abort 级 |
| **VERDICT 格式合规** | `01_analysts/*.json` | ✅ CP2 + CP3 检查 |
| **分析师一致性检查** | `cross-stage-checks.ts` | ✅ consensus_conflict |
| **风险收益比计算** | `04_trading_plan.json` | ✅ target_price_band |
| **风控约束验证** | `05_risk/risk_manager.json` | ✅ retries_exhausted |
| **LLM 成本审计** | `06_traces/*/meta.usage` | ✅ run_summary.json |
| **跨阶段一致性** | `cross-stage-checks.ts` | ✅ 6 条确定性检查 |
| **数据质量门控** | `00_quality.json` | ✅ Layer-1 + Layer-2 |
| **决策链追溯** | provenance 数组 | ✅ 5 阶段横向流水线 |

### 4.2 缺失的能力

| 检查项 | 缺失原因 | 影响 |
|--------|---------|------|
| **决策理由追溯** | `FinalDecision` 缺少 `decision_rationale` 字段 | Agent 无法理解「为何技术面看空但仍买入」|
| **辩论关键分歧提取** | `03_research.json` 的 `key_debate_points` 为空 | Agent 无法判断辩论是否产生了增量信息 |
| **辩论收敛判定** | 无 `convergence_score`，且数据可能发散 | Agent 无法判断辩论是否有价值 |
| **风控评分细则** | `risk_score: 50` 无扣分逻辑 | Agent 无法复现风控评分 |
| **保守风控观点提取** | Parser 正则只匹配 `###` 标题，LLM 输出用 `##` | Agent 无法读取保守方的详细分析 |
| **入场信号实时状态** | 入场信号是静态的，无实时更新 | Agent 无法判断「现在是否应该建仓」|
| **历史报告对比** | 无跨期报告的 diff 机制 | Agent 无法判断分析师是否「改口」|
| **数据源健康度** | 无数据源可用性历史记录 | Agent 无法预判数据采集风险 |
| **reason 内容语义检查** | CP3 只检查 VERDICT 有没有，不看 reason 内容 | hot_money 说「数据缺失」但给了 A |

---

## 五、从人类角度评估

### 5.1 已具备的能力

| 能力 | 产物支持 | 人类体验 |
|------|---------|---------|
| **完整决策链追溯** | provenance 数组 + trace 文件 | ⭐⭐⭐⭐ 可以从最终决策追溯到每个分析师 |
| **多空论点对比** | `report.md` 中的辩论摘要 | ⭐⭐⭐⭐⭐ 人类可快速理解分歧点 |
| **风险提示** | `key_risks` 数组 + 风控意见 | ⭐⭐⭐⭐ 风险被明确列出 |
| **执行计划** | `trading_plan.json` 的详细计划 | ⭐⭐⭐⭐⭐ 分批建仓、入场/退出信号清晰 |
| **成本透明** | `run_summary.json` | ⭐⭐⭐⭐ 人类可以评估 ROI |
| **跨阶段异常检测** | `cross_stage_issues` | ⭐⭐⭐⭐ 风控 revise 等问题被标记 |

### 5.2 缺失的能力

| 能力 | 缺失原因 | 人类体验影响 |
|------|---------|-------------|
| **「为什么买」的决策理由** | 缺少 decision_rationale | 人类必须自己推断 |
| **辩论胜负判定** | 无 key_debate_points | 人类必须自己判断辩论是否有价值 |
| **风控扣分明细** | risk_score 无解释 | 人类无法复现风控评分 |
| **保守风控观点缺失** | Parser 未提取 LLM 生成的 2492 字分析 | 人类看不到涨跌停板陷阱等关键风控观点 |
| **「现在该不该买」的明确建议** | 入场信号未满足但未明确警告 | 人类可能误以为应该立即买入 |
| **与历史分析的对比** | 无 diff 机制 | 人类无法快速判断「分析师是否改口」|
| **置信度校准** | 无历史准确率统计 | 人类无法判断 50% 置信度意味着什么 |

---

## 六、本次报告发现的深层问题

### 6.1 辩论发散问题（严重）

**现象**：Round 1 有 3 个 unresolved 论点，Round 2 增加到 5 个。辩论越吵越散，没有收敛。

**数据**：
- Round 1: `unresolved_ids: ["BULL-1", "BULL-2", "BULL-3"]`（3个）
- Round 2: `unresolved_ids: ["BULL-1", "BULL-2", "BULL-3", "BEAR-1", "BEAR-2"]`（5个）

**根因分析**：
1. 多头没有有效反驳空头的核心论点（深航-104亿黑洞、低基数幻觉）
2. 空头的反驳只是重复了论据，没有真正「解决」多头的论点
3. 2 轮辩论可能不够 — 需要更多轮次或强制解决关键分歧

**影响**：研究经理给出 50:50 的平局，说明辩论没有产生增量信息。这是 LLM tokens 的浪费。

### 6.2 hot_money 数据缺失但质量门给了 A（中等）

**现象**：hot_money 分析师报告中说「个股资金数据缺失」，但质量门给了 A 级。

**根因**：
- `quality-gate.ts` 的 CP3 只检查 VERDICT 有没有，不检查 reason 内容
- hot_money 分析师用了宏观数据（全市场北向资金）推断，触发了字段引用检查的关键词（北向、资金）
- 但「个股资金数据缺失」这个关键信息没有被质量门捕获

**影响**：hot_money 的「中性」结论可能不可靠 — 它用宏观数据代替了个股数据。

### 6.3 风控 revise 的真正矛盾未解决（严重）

**现象**：trader 止损 5.50 < 风控硬约束 5.70，重试一次没解决，止损线在最终计划里还是 5.50。

**数据**：
- `04_trading_plan.json`: `stop_loss: 5.5`
- `05_risk/risk_manager.json`: `hard_constraints: ["止损价≥5.70元"]`
- `risk_assessment_detail.retries_exhausted: true`

**根因**：
1. 风控说 revise，要求止损 ≥5.70
2. 交易员重试后仍然给出 5.50
3. 系统选择了「放弃修订」而非「拒绝交易」
4. 最终报告中的止损价是 5.50，与风控硬约束矛盾

**影响**：这是一个逻辑矛盾 — 风控说「必须 ≥5.70」但最终执行计划是 5.50。如果按 5.50 执行，可能面临 T+1 跌停流动性风险。

### 6.4 保守风控 parser 未提取内容（Parser Bug）

**现象**：风控辩论中，保守方的 `position` 和 `evidence` 为空，但 LLM 实际生成了 2492 字的详细分析。

**根因**：
- Prompt（`risk_debater.md`）期望输出 `### 1. 立场声明`（三级标题）
- LLM 实际输出 `## 1. 立场声明：**建议修订（REVISE）**`（二级标题，且后面有内容）
- Parser（`risk.ts:74-79`）用 `/### 1\. 立场声明\s*\n/` 匹配三级标题，无法匹配二级标题
- 结果：`position` 为空字符串，`evidence` 为空数组

**LLM 实际写了什么**：
- 立场：建议修订（REVISE）
- 证据一：止损价 5.50 元低于跌停价 5.54 元 — 涨跌停板陷阱使止损形同虚设
- 证据二：技术面全面看空，计划在无底部确认信号时做多
- 证据三：深圳航空"黑洞"构成持续现金消耗风险
- 证据四：北向资金大幅流出 + 航空板块处于资金"边缘区"

**影响**：保守风控写了最有价值的风控观点（涨跌停板陷阱），但没被读到最终报告里。三方辩论实际上只有两方在发言。

**修复方向**：改 parser（`risk.ts` 的 `parseRiskArgument` 函数），适配 `##` 和 `###` 两种标题级别，而非改 prompt。

---

## 七、质量保证体系缺口分析

### 7.1 高优先级缺口

| # | 缺口 | 影响 | 建议产物 |
|---|------|------|---------|
| 1 | **决策理由缺失** | 无法追溯「为何接受/拒绝某阶段结论」 | `FinalDecision.decision_rationale` |
| 2 | **辩论无收敛判定** | 辩论可能只是浪费 LLM tokens，且可能发散 | `DebateResult.convergence_score` + `resolved_points` |
| 3 | **风控 revise 未真正执行** | 止损 5.50 < 硬约束 5.70，逻辑矛盾 | 强制 trader 遵守风控硬约束 |
| 4 | **入场信号实时状态** | 人类可能误判「现在该不该买」 | `TradingPlan.should_act_now` + `signal_status` |

### 7.2 中优先级缺口

| # | 缺口 | 影响 | 建议产物 |
|---|------|------|---------|
| 5 | **分析师 VERDICT 值不统一** | 解析兼容性问题 | 统一为 `看多/看空/中性` |
| 6 | **保守风控 parser 未提取内容** | 三方辩论不完整，LLM 写了 2492 字但未被读取 | 修复 risk debate parser，适配 `##` 和 `###` 标题 |
| 7 | **reason 内容语义检查缺失** | hot_money 说「数据缺失」但给了 A | 增加 reason 关键词检查 |
| 8 | **历史报告对比** | 无法判断分析师是否「改口」 | `AnalysisReport.diff_with_previous` |
| 9 | **数据源健康度** | 无法预判数据采集风险 | `DataHealthStatus` 记录历史成功率 |

### 7.3 低优先级缺口

| # | 缺口 | 影响 | 建议产物 |
|---|------|------|---------|
| 10 | **置信度校准** | 无法判断 50% 意味着什么 | 历史准确率统计 |
| 11 | **成本效益分析** | 无法评估 LLM 调用是否值得 | `CostBenefitAnalysis` |

---

## 八、已有能力与缺口对比

| 维度 | 已有能力 | 缺口 | 覆盖度 |
|------|---------|------|--------|
| 数据采集审计 | CP1 数据源成功率、K线条数、新鲜度 | sector 缺失（已合并，非问题） | 95% |
| 分析师质量 | Layer-1 + Layer-2、VERDICT 解析、字段引用 | reason 内容语义检查 | 85% |
| 辩论质量 | 有论点结构、confidence | 无收敛判定、可能发散 | 60% |
| 风控质量 | 风控意见、retries_exhausted | 评分明细、hard_constraints 未强制执行 | 65% |
| 决策追溯 | provenance、cross_stage_issues | decision_rationale | 75% |
| 人类可读性 | MD/HTML 报告、辩论摘要 | 「现在该不该买」明确建议 | 80% |

**整体覆盖度：约 85%**

---

## 九、改进路线图

### Phase 1: 修复逻辑矛盾（1-2 周）

| 任务 | 优先级 | 预期产出 |
|------|--------|---------|
| 强制 trader 遵守风控 hard_constraints | P0 | 止损价 ≥5.70 |
| 在 `FinalDecision` 中增加 `decision_rationale` 字段 | P0 | 决策理由可追溯 |
| 在 `DebateResult` 中增加 `convergence_score` 和 `resolved_points` | P0 | 辩论质量可量化 |
| 增加辩论发散检测（unresolved 增加时报警） | P0 | 辩论发散早发现 |

### Phase 2: 增强审计能力（2-4 周）

| 任务 | 优先级 | 预期产出 |
|------|--------|---------|
| 在 `RiskAssessment` 中增加 `score_breakdown` | P1 | 风控评分可复现 |
| 在 `TradingPlan` 中增加 `should_act_now` 和 `signal_status` | P1 | 入场时机可判断 |
| 统一所有 VERDICT 值为 `看多/看空/中性` | P1 | 解析兼容性提升 |
| 修复 risk debate parser，适配 `##` 和 `###` 标题 | P1 | 保守风控观点可提取 |
| 增加 reason 内容语义检查 | P1 | hot_money 数据缺失可检测 |

### Phase 3: 建立质量闭环（4-8 周）

| 任务 | 优先级 | 预期产出 |
|------|--------|---------|
| 增加历史报告 diff 机制 | P2 | 分析师「改口」检测 |
| 增加数据源健康度历史记录 | P2 | 数据采集风险预判 |
| 建立置信度校准机制 | P2 | 置信度可信度提升 |
| 建立成本效益分析框架 | P2 | LLM 调用 ROI 优化 |

---

## 十、结论

**现有产物覆盖度：约 85%**（v2.0 修正）

### 已实现的核心能力

1. **数据采集审计**：CP1 abort 级检查，成功率 ≥6/7
2. **分析师质量门控**：Layer-1 确定性 + Layer-2 LLM 可信度复核
3. **跨阶段一致性**：6 条确定性检查（目标价/止损/consensus/retries 等）
4. **决策链追溯**：provenance 记录 5 阶段横向流水线
5. **流水线健康监控**：PipelineHealth 贯穿全流程

### 核心缺口

1. **辩论发散**：unresolved 从 3 涨到 5，辩论越吵越散
2. **风控 revise 未执行**：止损 5.50 < 硬约束 5.70，逻辑矛盾
3. **决策理由缺失**：无法追溯「为何技术面看空但仍买入」
4. **reason 语义检查缺失**：hot_money 说「数据缺失」但质量门给了 A
5. **保守风控 parser bug**：LLM 写了 2492 字但 parser 未提取（`##` vs `###` 标题不匹配）

### 一句话总结

**当前系统可以发现问题（如风控 revise），但无法完全解释「为什么做出这个决策」，且发现的问题可能没有被真正解决（如止损矛盾），甚至 LLM 生成的高质量风控观点可能因为 parser bug 而丢失（如保守方的涨跌停板陷阱分析）** — 这是质量保证体系的核心缺口。

---

## 附录 A：示例报告产物清单

以 601111（中国国航）2026-06-11 Full 模式为例：

```
trading-reports/601111/2026-06-11_full/
├── 00_quality.json                    # 质量门控结果
├── 01_analysts/                       # 7个分析师报告
│   ├── fundamentals.json
│   ├── hot_money.json
│   ├── lockup.json
│   ├── market.json
│   ├── news.json
│   ├── policy.json
│   └── sentiment.json
├── 02_debate/                         # 多空辩论
│   ├── round_1.json
│   └── round_2.json
├── 03_research.json                   # 研究经理裁决
├── 04_trading_plan.json               # 交易执行计划
├── 05_risk/                           # 风控
│   ├── risk_debate.json
│   └── risk_manager.json
├── 06_traces/                         # LLM调用追踪
│   ├── run-mq93thej-t185i/
│   │   ├── run_summary.json
│   │   └── *.json (23个trace文件)
│   ├── run-mq938k69-obvu8/
│   └── run-mq938xql-o4t8r/
├── 07_data/                           # 原始数据
│   ├── fundamentals_raw.json
│   ├── hot_money_raw.json             # 包含行业排名
│   ├── lockup_raw.json
│   ├── market_raw.json
│   ├── news_raw.json
│   ├── policy_raw.json
│   └── sentiment_raw.json
├── 2026-06-11_full.json               # 汇总JSON
├── report.html                        # HTML报告
└── report.md                          # Markdown报告
```

## 附录 B：VERDICT 协议规范

所有 LLM 输出通过 HTML 注释嵌入结构化结论：

```html
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->
```

### 标准 direction 值

| 阶段 | 合法值 | 说明 |
|------|--------|------|
| 分析师 | `看多` / `看空` / `中性` | 7个分析师统一使用 |
| 辩论 | `看多` / `看空` | Bull/Bear 各自立场 |
| 研究经理 | `Buy` / `Overweight` / `Hold` / `Underweight` / `Sell` | 5级方向决策 |
| 交易员 | `Buy` / `Hold` / `Sell` | 执行层面决策 |
| 风控 | `pass` / `revise` / `reject` | 风控门控决策 |

### 已知问题

- `policy` 分析师使用 `利好` 而非标准值 — 需要统一
- 部分阶段的 VERDICT 值未被下游正确解析 — 需要增加校验

---

*文档版本: 2.1（修正版）*
*最后更新: 2026-06-11*
*基于报告: 601111 中国国航 2026-06-11 Full 模式*
*修正内容: 移除 sector 缺失标记、标注已实现能力、增加辩论发散和风控矛盾分析、覆盖度修正为 85%、6.4 根因从"prompt 问题"改为"parser bug"*
