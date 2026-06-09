# OpenClaw Trading Agents 流程深度解读

> 面向**初次接触本项目**的读者。哪怕你不懂量化交易、没写过 LLM pipeline，也能读懂这套系统是怎么运转的，以及为什么这样设计。
>
> 如果你只想要组件清单，看 [`architecture.zh.md`](architecture.zh.md) 就够了；本文回答的是"**为什么是这些组件、它们怎么协作、设计上有哪些坑是怎么填的**"。

---

## 引言：用"投资团队开会"理解整个系统

想象你是一家私募的投资总监，要决定"明天买不买贵州茅台"。你不会自己一个人盯盘拍脑袋，你会召集一次投研会议：

1. **先派 7 个研究员分头干活** —— 技术面的看 K 线、基本面的看财报、新闻岗盯公告、情绪岗看论坛、政策岗读文件、资金岗追北向、解禁岗查限售股。每个人各自出一份报告。
2. **但这 7 份报告可能各说各话**，甚至互相矛盾。技术面说"金叉看多"，基本面说"PE 太高"，你怎么综合？
3. **简单做法（Quick 模式）**：你把这 7 份报告交给**投资组合经理**，让他一个人拍板。
4. **严肃做法（Full 模式）**：你不信任单点判断，于是搞一场**多空辩论赛** —— 让"多头研究员"和"空头研究员"互相反驳 N 轮，逼出对方最弱的论点；然后请**研究经理**当裁判打分定方向；方向定好后，**交易员**把"看多"翻译成"什么价位买、买多少、何时卖"；最后**风控团队**三方独立审查这个执行计划，**风控经理**决定通过 / 修订 / 否决。

这就是 OpenClaw Trading Agents 在做的事 —— **用多个 LLM 角色模拟一次完整的机构投研会议**。每个角色是一次 LLM 调用，角色之间的信息流就是 pipeline。

理解了这个比喻，后面所有的技术细节都是在回答一个问题：**怎么让一群"会偷懒、会跑题、会自相矛盾"的 LLM，稳定地协作产出一份可执行的投资决策？**

---

## 两种运行模式：8 次调用 vs 15+ 次调用

系统提供两个工具入口，差别就是"开会开得多严肃"：

| 模式 | 工具名 | LLM 调用次数 | 流程 | 适用场景 |
|------|--------|------------|------|---------|
| **Quick** | `trading_quick` | 8 | 7 分析师 → 投资组合经理 | 快速扫一眼，成本低 |
| **Full** | `trading_full` | 15+ | 7 分析师 → 多空辩论 → 研究经理 → 交易员 → 风控辩论 → 风控经理 | 严肃决策，有对抗和风控 |

### Quick 模式数据流

```
用户输入股票代码
  ↓
[Phase 1] 7 个数据脚本并行抓数据（K线/财报/新闻/...）
  ↓
[Phase 2] 7 个分析师并行读数据写报告
  ↓
       ┌─ 质量门检查（这 7 份报告靠不靠谱）─┐
  ↓                                          ↓
[Phase 3] 投资组合经理综合 7 份报告 → 方向决策
  ↓
[Phase 4] 保存报告 + 调用溯源
```

### Full 模式数据流

```
[Phase 1-2] 同 Quick（数据 + 7 分析师 + 质量门）
  ↓
[Phase 3] 多头 ↔ 空头辩论（N 轮，默认 2 轮）—— 互相反驳，逼出弱点
  ↓
[Phase 4] 研究经理当裁判 —— 给多空双方打分，定 5 档方向
  ↓
[Phase 5] 交易员 —— 把方向翻译成具体执行计划（价位/仓位/信号）
  ↓
[Phase 6] 三方风控辩论（激进/保守/中性并行）—— 独立评估执行计划
  ↓
[Phase 7] 风控经理 —— 通过/修订/否决
  ↓
       ┌── 修订? ──→ 把风控约束注入交易员重写计划 → 再过一轮风控
       │                （最多重试 max_risk_retries 次）
       └── 通过/否决 → 保存报告
```

**为什么要有两种模式？** Quick 模式适合"我想快速看一眼这只股票大概什么情况"，8 次 LLM 调用几毛钱、十几秒就出结果。Full 模式适合"我准备真金白银下单了"，15+ 次调用虽然贵几倍，但有辩论逼出盲点、有风控兜底，决策质量更高。这就是工程上的"成本-质量"权衡。

---

## 第一章：公共底座 —— 所有阶段都依赖的基础设施

在讲具体阶段之前，先看三个被反复使用的基础组件。理解了它们，后面每个阶段都是"调用基础组件 + 加点阶段特有逻辑"。

### 1.1 并发池 `pool()`：控制"一起干"的节奏

7 个数据脚本、7 个分析师、3 个风控辩手都需要"并行执行"。但并行不是无脑同时跑 —— 如果 7 个 LLM 请求同一瞬间打到 API，容易触发限流。所以项目写了一个通用的 `pool()` 函数（`src/orchestrator.ts:231-250`）：

```
N 个 worker 抢同一个任务队列，每抢到一个任务前 sleep 一小段随机时间
```

两个参数控制节奏：
- **并发上限**（`config.llm_concurrency`）：最多同时跑几个
- **stagger 抖动**（`DATA_FETCH_STAGGER_MS` / `LLM_CALL_STAGGER_MS`）：每个任务启动前随机延迟，错开请求

**为什么需要 stagger？** 想象 7 个人同时挤进电梯 —— 一定会堵。如果每个人进电梯前随机等 0~200 毫秒，就分散开了。对 LLM API 也是一样，错开请求能避开 burst 限流。

### 1.2 LLM 调用封装 `callLLM()`：所有 LLM 调用的统一入口

不管哪个阶段，调 LLM 都走这个函数（`src/llm-client.ts:66-217`）。它干四件事：

| 能力 | 解决什么问题 |
|------|------------|
| **超时控制**（`AbortController`） | 防止 LLM 卡死拖垮整个 pipeline |
| **空响应重试**（最多 `LLM_MAX_RETRIES` 次） | LLM 偶尔返回空内容，自动重试 |
| **trace 记录** | 每次调用写一条审计日志（model/tokens/cost/原始输出） |
| **成本核算** | 按 model 算钱，未知 model 回退 gpt-4o 价 |

返回值统一是 `{content, usage, costUsd, traceId}`。所有阶段都拿这个返回值，不直接碰 OpenAI client —— 这样换 LLM 供应商（智谱/DeepSeek/Moonshot 等 OpenAI 兼容 API）只改一个地方。

### 1.3 VERDICT 协议：让 LLM 的"结论"可被程序读取

这是整个系统最重要的设计模式之一。LLM 输出的是一坨 markdown 散文，但程序需要知道"这个角色最终给的方向是什么"。解决方案是让 LLM 在输出末尾嵌一个 HTML 注释块：

```html
<!-- VERDICT: {"direction": "Buy", "reason": "多指标共振看多"} -->
```

`parseVerdict()`（`src/llm-client.ts:229-268`）用**三层降级**提取：

1. **首选**：正则抓 VERDICT JSON 块 → JSON.parse
2. **回退 1**：找"最终裁决："、"方向："这种标签
3. **回退 2**：前 20 行关键词扫描（看到"买入/看多"就判 Buy）

**为什么要三层？** LLM 不是 100% 可靠的 —— 有时候它忘了写 VERDICT 块，有时候 JSON 写歪了。三层降级保证"无论如何都能拿到一个方向"，避免 pipeline 因为单个角色输出格式问题而崩。

> **这个模式会反复出现**：项目里有 5 个这样的"机器可读块"协议（VERDICT / DEBATE_STATE / RISK_JUDGE / TRADER_PLAN / QUALITY_REVIEW），都是同一个套路：**LLM 输出结构化 JSON 块作为权威，散文作为人类可读的解释和回退**。记住这个套路，后面看到任何协议都不陌生。

---

## 第二章：数据采集层 —— 7 个 Python 脚本并行抓数据

### 2.1 7 个数据源各管一摊

每个分析师有自己的数据脚本（`src/orchestrator.ts:278-336`）：

| 角色 | 脚本 | 抓什么 |
|------|------|--------|
| `market` | `kline.py` | K 线 + 技术指标（MACD/RSI/布林带）+ VPA 量价分析 |
| `fundamentals` | `fundamentals.py` | 财报数据（PE/PB/ROE/营收/商誉/现金流） |
| `news` | `news.py` | 近 7 天新闻 + 公告 |
| `sentiment` | `sentiment.py` | 市场情绪（涨停/连板/热度排名） |
| `policy` | 复用 `news.py` | 近 14 天新闻（政策视角） |
| `hot_money` | `hot_money.py` | 资金流向（北向 + 主力 + 龙虎榜） |
| `lockup` | `lockup.py` | 解禁 + 减持 + 结构化公告事件 |

### 2.2 子进程调用：`execPython()` 怎么工作

TypeScript 不直接抓数据，而是启动 Python 子进程（`src/exec-python.ts:85-111`）：

```
TypeScript → spawn('python3', ['kline.py', '--ticker', '600519', ...])
           → 30 秒超时保护
           → 收 stdout → JSON.parse → 拆出 {data, vpa, technical_indicators}
           → 失败返回 {success: false, error}，不抛异常
```

**三个关键设计**：

**缓存**：同样的脚本 + 同样的参数，结果用 sha256 做 key 缓存（默认 TTL）。调试时反复跑同一个股票不用每次都重新抓数据，省钱省时间。

**优雅降级**：任何一个脚本失败，**不阻塞其他 6 个**。比如 `hot_money.py` 因为东财限流挂了，其他 6 个分析师照常工作，只是 hot_money 分析师会收到一条"数据缺失"的提示。

**为什么用子进程而不是 node 直接抓？** Python 生态有 `mootdx`（通达信协议）、`akshare`（聚合数据源）这些 A 股专用库，Node 生态没有等价物。子进程是最务实的桥接方式。

### 2.3 数据完整性检查：防"假数据"

最危险的失败不是"脚本报错"，而是"脚本返回了**看起来正常但实际有问题**的数据"。比如：

- K 线只返回了 20 根（应该有 120 根），技术指标算不出来，但分析师不知道
- K 线最新日期是半个月前（数据源悄悄返回了过期数据）

`generateDataQuality()`（`src/orchestrator.ts:71-128`）专门查这两类问题：

- **market 角色专属**：K 线行数 < 50 → 提示"MACD/RSI 等技术指标可能缺失"
- **新鲜度检查**（仅当分析日期在最近 7 天内）：最新 bar 距分析日 > 7 天 → 提示"数据可能过期"

**为什么只对 market 角色查行数？** 技术指标（MACD 需要 26 根、RSI 需要 14 根、布林带需要 20 根）对 K 线行数有硬性要求，行数不够算出来的指标是错的。其他角色的数据没有这种"行数下限"约束，所以不查。

这条质量描述会注入到对应分析师的 prompt 里（`{{data_quality}}`），让分析师知道"我手上的数据是不是完整的"。这是后续质量门的基础。

---

## 第三章：分析师层 —— 7 个角色并行写报告

### 3.1 共同的工作模式

7 个分析师的结构高度一致（`src/orchestrator.ts:426-483`）：

```
对每个分析师角色：
  1. loadAndRender() 渲染 prompt 模板，注入数据
  2. callLLM() 调用 LLM（analyst 模型，temperature 0.4）
  3. parseVerdict() 提取结论（看多/看空/中性）
  4. 存入 analystReports[]
```

每个分析师的 prompt 都注入了几个关键变量：

| 变量 | 内容 |
|------|------|
| `{{ticker}}` `{{date}}` | 股票代码、分析日期 |
| `{{kline}}` / `{{fundamentals}}` / ... | 该角色对应的数据 JSON |
| `{{vpa}}` | 量价分析文本（仅 market 角色有） |
| `{{technical_indicators}}` | 技术指标文本（仅 market 角色有） |
| `{{data_quality}}` | 数据完整性描述（见上节） |

### 3.2 优雅降级：失败的分析师不拖垮全局

如果某个分析师的 LLM 调用失败（超时/异常），不是抛错终止，而是塞一条占位报告（`src/orchestrator.ts:465-473`）：

```typescript
analystReports[idx] = {
  role: cfg.role,
  content: `[分析失败: ${err.message}]`,
  verdict: { direction: "中性", reason: "分析失败" },
  data_sources_used: [],
};
```

这条占位报告会被质量门识别为 F 级（"以错误标记开头"），下游 PM/辩论/research 看到质量摘要就知道"这个分析师的报告不可用，结论应被忽略"。**一个分析师挂了，其他 6 个照常工作**。

### 3.3 输出 VERDICT：每个分析师都给方向

每个分析师的报告末尾都有一个 VERDICT 块，direction 是 `看多` / `看空` / `中性`（中文）。这个方向会被后续阶段使用：

- **Quick 模式**：投资组合经理看到 7 个方向，做综合
- **Full 模式**：辩论双方看到 7 个方向，构建论点

`parseVerdict` 的三层降级在这里也生效 —— 即使某个分析师忘了写 VERDICT 块，也能从散文里扫出方向。

---

## 第四章：质量门 —— 防"水文"的两道防线

7 个分析师报告质量参差不齐。如果某个分析师"无视数据写了一通废话"，下游不应该当真。质量门就是干这个的，分两层：

### 4.1 Layer-1：零成本结构检查（`src/quality-gate.ts`）

这一层不调 LLM，纯规则检查，7 个硬检查（`quality-gate.ts:70-130`）：

| 检查 | 触发条件 | 说明 |
|------|---------|------|
| 空报告 | content 为空 | 直接 F |
| 错误标记开头 | `[分析失败` / `[数据缺失` | 直接 F |
| 报告过短 | < 200 字符 | 扣分 |
| Check 4：多个失败标记 | ≥3 个**不同**的"无法获取"/"分析失败"等短语 | 扣分 |
| Check 4b：数据缺失哨兵 | ≥3 个 `[数据缺失: …]` 哨兵**出现次数** | 扣分 |
| VERDICT 解析失败 | direction 是默认值 | 扣分 |
| **未引用数据字段** | 该角色关键词一个没命中 **且** 数值引用 < 3 | 标"无视数据写水文" |

**Check 4 和 Check 4b 为什么都要？** 两者抓的是不同信号：

- **Check 4** 数的是**不同**失败短语的数量 —— 一篇报告同时冒出"无法获取"+"分析失败"+"暂无数据"三种短语才触发。但它有个盲区：如果报告里写了 13 个 `[数据缺失: 新闻]`（同一个短语重复），Check 4 只算"1 种"，漏网。
- **Check 4b** 数的是哨兵**出现次数** —— 13 个 `[数据缺失: …]` 哨兵就触发。它抓的是"分析师大部分必采项都拿不到数据"这种情况。

两者缺一不可。这个设计来自一次实跑踩坑（600600 的 news 报告塞了 13 个哨兵，在只有 Check 4 时拿了 A 级，明显不合理）。

最后一项 `checkFieldCitations`（`quality-gate.ts:56-64`）最巧妙 —— 每个角色有一张"应该引用的关键词表"（比如 fundamentals 角色应该提到 PE/PB/ROE/营收），如果一篇基本面报告**既没提到任何关键词，又没有 ≥3 个数值引用**，那基本就是"无视数据写的水文"。

**关键细节：先 strip 哨兵再查关键词**（`quality-gate.ts:59`）。`[数据缺失: 新闻]` 这个哨兵里包含"新闻"这个关键词，如果不先清掉，一篇**明确声明"我没有新闻数据"**的报告会被当成"引用了新闻数据"通过检查。所以用 `content.replace(/\[数据缺失:\s*[^\]]*\]/g, "")` 先把哨兵清掉，再做关键词/数值扫描。

按问题数给 A-F 评级，输出一张 markdown 表格 `summary_text`。

### 4.2 Layer-2：LLM 语义审查（`src/quality-review.ts`）

Layer-1 只能查结构，查不了"**报告里说的数据是真的吗？是不是 LLM 编的？**"。这一层调一次 LLM（analyst 模型），输出 `<!-- QUALITY_REVIEW -->` JSON 块：

```json
{
  "credibility": "高",           // 高/中/低
  "stale_reports": ["hot_money"], // 哪些角色用了过期数据
  "fabrication_suspects": ["news"] // 哪些角色疑似编造数据
}
```

**失败优雅降级**：如果 ≥4 个分析师 hard-fail（不值得花一次 LLM 调用审查）、LLM 异常、JSON 块解析失败，Layer-2 都返回 null，回退到只用 Layer-1。**永远不阻塞 pipeline**。

### 4.3 质量摘要怎么用

两层的结果拼成一个 `quality.summary_text`，注入到**后续所有阶段的 prompt**（PM/辩论/research/trader 都能看到）：

```markdown
## 数据质量门控报告

| 分析师 | 等级 | 问题 |
|--------|------|------|
| market | A | — |
| fundamentals | B | 报告过短 (180 字符) |
| hot_money | F | 报告以错误标记开头 |

**严重警告**：以下分析师报告不可用，其结论应被忽略：hot_money
```

这样下游角色就知道"hot_money 的报告别信，其他可以参考"。这是把"数据可信度"信号**显式传递**给后续 LLM，而不是让它们盲信所有输入。

> **设计哲学**：质量门不是"通过/不通过"的闸门，而是**信号注入器**。即使所有报告都是 F 级，pipeline 也不会停 —— 它只是把"这些报告都不可信"这个信号传给下游，让下游降低置信度。这比硬性阻断更实用。

---

## 第五章：Quick 模式终点 —— 投资组合经理

Quick 模式在质量门之后就进入终点：一次投资组合经理（Portfolio Manager，PM）调用，综合 7 份报告给出方向。

### 5.1 输入：三件套

PM 的 prompt（`portfolio_manager.md`）注入三个核心变量：

| 变量 | 内容 | 作用 |
|------|------|------|
| `{{analyst_reports}}` | 7 份报告全文 + 各自 VERDICT | 原始素材 |
| `{{quality_summary}}` | 质量门摘要 | 告诉 PM 哪些报告可信 |
| `{{analyst_consensus}}` | 预计算的一致性指标 | 告诉 PM 7 个方向有多一致 |

`analyst_consensus` 是 TS 端预计算的（`src/orchestrator.ts:131-185`），避免让 PM 自己数：

```
### 分析师一致性指标（共 7 位分析师）

- **看多**: 4/7 (57%) — market, fundamentals, news, sentiment
- **看空**: 2/7 (29%) — hot_money, lockup
- **中性**: 1/7 (14%) — policy

**共识方向**: 看多 | **一致比例**: 57% | **分歧度**: 中（多数一致）

**决策指引**:
- 多数分析师一致（57% 看多），建议适当降低仓位
```

**为什么预计算而不是让 LLM 自己数？** LLM 数数容易错（特别是 7 个方向统计），TS 端算更可靠。而且这个指标格式固定，PM 一眼就能读懂。

### 5.2 决策框架：5 档评级

PM prompt（`portfolio_manager.md:5-22`）定义了 5 档评级体系：

| 评级 | 含义 | 建议操作 |
|------|------|---------|
| **Buy** | 强烈推荐买入 | 建立新仓位或显著加仓 |
| **Overweight** | 跑赢大盘 | 增持，权重高于基准 |
| **Hold** | 持有观望 | 维持现有仓位 |
| **Underweight** | 跑输大盘 | 减持 |
| **Sell** | 建议卖出 | 清仓 |

**为什么 5 档不是 3 档？** 3 档（Buy/Hold/Sell）粒度不够 —— "看多但有点担心"和"看多且很确定"应该对应不同仓位。5 档把"看多"拆成 Buy（强）+ Overweight（弱），看空对称拆成 Underweight + Sell。

### 5.3 A 股交易约束：写进 PM 的脑子

PM prompt 用了一大段（`portfolio_manager.md:24-72`）讲 A 股交易规则：T+1、涨跌停板（主板 ±10%、科创/创业 ±20%、ST ±5%）、最小交易单位（主板 100 股、科创/创业 200 股）、交易时间、交易成本（印花税/佣金/过户费）。

**为什么 PM 也要懂这些？** 因为 PM 要给目标价、止损价、仓位建议，这些数字必须符合 A 股实际约束。比如止损价不能设在跌停板上（卖不出去），目标价要考虑涨停限制。让 PM"知道规则"比事后校验更有效。

### 5.4 10 节输出结构

PM prompt 要求按 10 节结构输出（`portfolio_manager.md:118-208`）：投资评级 → 置信度 → 价格目标 → 仓位建议 → 入场策略 → 核心逻辑 → 关键风险 → 失效条件 → 分析师观点汇总 → 下一步行动。

**但 Quick 模式实际只解析方向**。这 10 节的详细内容（目标价、止损价、仓位等）**不会被下游程序使用** —— 它们是给**人类读者**看的报告内容。

```typescript
// src/orchestrator.ts:568-584
const finalDecision: FinalDecision = {
  // ...
  target_price: 0,        // ← Quick 模式不解析，硬编码 0
  stop_loss: 0,           // ← 同上
  position_pct: 0,        // ← 同上
  confidence: 0.7,        // ← 固定值，不是 PM 输出的
  // ...
};
```

**为什么 Quick 模式不做价格解析？** Quick 模式定位是"快速扫一眼"，重点是**方向**（Buy/Hold/Sell），不要求精确的执行参数。如果你需要目标价/止损价/仓位，应该用 Full 模式（那里有专门的 trader 角色）。

### 5.5 VERDICT 解析失败的兜底

如果 PM 的 VERDICT 块解析失败（罕见但可能），不是报错，而是**回退到 7 分析师多数投票**（`src/orchestrator.ts:552-561`）：

```typescript
if (portfolioVerdict) {
  direction = parseDirection(portfolioVerdict.direction);
} else {
  // 回退：7 分析师多数投票
  const verdictCounts = {};
  for (const report of analystReports) {
    verdictCounts[report.verdict.direction] = (verdictCounts[report.verdict.direction] || 0) + 1;
  }
  const majority = Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])[0][0];
  direction = parseDirection(majority);
}
```

**这是"无论如何都有输出"的工程哲学** —— PM 解析失败不是终止，而是降级到更简单的决策方式。用户拿到的永远是一个完整结果，而不是报错。

### 5.6 Quick vs Full 的本质差异

| 维度 | Quick 模式 PM | Full 模式后续阶段 |
|------|--------------|------------------|
| **决策依据** | 7 分析师报告直接综合 | 经过辩论检验的论点 |
| **对抗检验** | 无 | 多空辩论逼出弱点 |
| **执行参数** | 不解析（报告给人看） | trader 专门产出可执行参数 |
| **风控** | 无 | 三方风控 + revise 循环 |
| **模型档位** | `decision`（快档） | research/risk 用 `decision_deep`（深度档） |
| **成本** | 1 次 LLM | 7+ 次 LLM |

**一句话**：Quick 是"PM 一个人拍脑袋"，Full 是"开会 + 辩论 + 风控"的完整流程。Quick 适合初筛，Full 适合决策。

## 第六章：多空辩论状态机 —— Full 模式的核心创新

这是整个系统**最精巧**的部分。如果你只读一节，读这节。

### 6.1 解决什么问题：传统多空辩论的"各说各话"

想象一场辩手没受过训练的辩论赛：

```
Round 1 多头: "政策利好 + 北向流入 + PE 低"（3 个论点）
Round 1 空头: "T+1 风险 + 估值泡沫 + 减持压力"（3 个论点）
Round 2 多头: "板块联动 + 业绩催化 + 资金改善"（再抛 3 个新论点）
Round 2 空头: "解禁压力 + 资金恶化 + 政策收紧"（再抛 3 个新论点）
```

**两方各说各话、互不回应**。N 轮下来双方只是换角度重述自己立场，辩论没收敛。研究经理拿到的是一锅 12 个未经过对抗检验的论点，根本不知道哪些站得住脚。

LLM 天生有这个倾向 —— 它会持续生成新内容，但不会主动"回应对方的某个具体论点"。你需要**强制**它这么做。

### 6.2 解法：把辩论做成显式状态机

项目的解法是给每个论点（claim）分配一个**唯一 ID**，并跟踪它的状态：

```
claim 状态转移：

  new claim (刚抛出)
      │
      ▼
    open
      │  对方下一轮回应
      ▼
  addressed (被提过但没判定)
      │  对方判定 resolved 或 unresolved
      ├──→ resolved (被击穿，结案)
      └──→ unresolved (仍无法解决，下轮焦点)
```

**"unresolved"是辩论的"剩余战场"**。如果它空了，辩论就该结束；如果它一直增长，说明双方在堆砌对方无法击穿的硬论点。

### 6.3 全局注册表：状态机的"记忆"

TS 端维护一个全局注册表（`src/debate.ts:123-129`），跨轮不重置：

```typescript
interface DebateRegistry {
  claims: DebateClaim[];              // 所有 claim 累积
  byId: Map<string, DebateClaim>;     // id → claim
  resolvedIds: Set<string>;           // 已解决（结案）
  unresolvedIds: Set<string>();       // 仍未解决（战场）
  counter: { bull: number; bear: number };  // 全局 ID 计数器
}
```

**关键点：状态存在 TS 端，不依赖 LLM 记忆**。LLM 不可靠，状态机权威必须在确定性代码里。每轮 LLM 输出一个 `DEBATE_STATE` JSON 块告诉 TS"我这轮回应了什么、抛了什么新论点、判定什么 resolved/unresolved"，TS 据此更新注册表。

### 6.4 每轮的输入注入：5 个状态变量

每轮 Bull（多头）和 Bear（空头）的 prompt 模板几乎一样（只是看多/看空颠倒），注入 5 个状态变量（`src/debate.ts:253-267`）：

| 变量 | 内容 | 作用 |
|------|------|------|
| `{{opponent_claims}}` | 上轮对方新抛的 claim（带 ID + 证据） | 让 LLM 看到对方说了什么 |
| `{{focus_claims}}` | **本轮必须回应的 claim ID 列表** | 强制对抗 |
| `{{unresolved_claims}}` | 当前所有未解决 claim | 让 LLM 知道战场在哪 |
| `{{round_summary}}` | 上一轮核心进展（≤50 字） | 跨轮上下文压缩 |
| `{{round_goal}}` | 本轮应达成的目标（≤30 字） | 引导本轮方向 |

最关键的是 `{{focus_claims}}`。prompt 里这段（`bull_researcher.md:46-49`）是状态机的"强制力"来源：

```markdown
**对抗要求**：
- 若"本轮焦点"非空，**必须逐条回应**每个焦点 claim，引用其 ID（如 `[BEAR-1]`）。
- 对每个焦点 claim 给出明确判定：已被你击穿（resolved）还是仍未解决（unresolved）。
- 不要回避对方最强论点——优先打靶，再展开新论点。
```

三句话的强制力：
1. **必须逐条回应 + 引用 ID** → 强制结构化对抗，不能模糊带过
2. **必须给判定（resolved/unresolved）** → 强制表态，不能和稀泥
3. **优先打靶，再展开新论点** → 显式排序：先回应后创造，防止 LLM 偷懒只抛新论点

### 6.5 输出契约：DEBATE_STATE 块

每轮 LLM 必须在末尾输出**两个连续的 HTML 注释块**（`bull_researcher.md:68-93`）：

```html
<!-- VERDICT: {"direction": "看多", "reason": "..."} -->
<!-- DEBATE_STATE: {
  "responded_claim_ids": ["BEAR-2"],
  "new_claims": [
    {"claim": "政策12月落地", "evidence": ["国发23号"], "confidence": 0.8}
  ],
  "resolved_claim_ids": ["BEAR-4"],
  "unresolved_claim_ids": ["BEAR-2"],
  "next_focus_claim_ids": ["BULL-3"],
  "round_summary": "击穿估值泡沫论点，仍有解禁压力待解",
  "round_goal": "空头需澄清解禁节奏"
} -->
```

7 个字段，每个都有 ≤30/≤50 字硬约束。其中 `responded_claim_ids` / `new_claims` / `resolved_claim_ids` / `unresolved_claim_ids` / `next_focus_claim_ids` 是状态机更新的依据。

### 6.6 TS 端如何处理：5 步严格顺序

`processDebateState()`（`src/debate.ts:136-198`）按严格顺序处理：

```
1. responded_claim_ids → 把对方 claim 标 "addressed"（被回应了）
2. resolved_claim_ids → 标 "resolved"，从 unresolvedIds 删除
3. unresolved_claim_ids → 标 "unresolved"（仅当未在 resolved）
4. new_claims → 用全局 counter 重新分配 ID，覆盖 LLM 写的 ID
5. 计算下轮 focus：优先 LLM 建议的 next_focus_claim_ids，否则取未解决中信心最高的 2 个
```

### 6.7 三个反作弊/稳健性细节

**(a) ID 由全局 counter 分配，LLM 写的 ID 被丢弃**

LLM 经常写 `BULL-1, BULL-2`，但全局 counter 可能已经是 `BULL-5` 了。如果用 LLM 的 ID，会**ID 冲突**或**和上轮的 BULL-1 混淆**。`debate.ts:170-171` 强制重新分配：

```typescript
reg.counter[side]++;
const id = `${side.toUpperCase()}-${reg.counter[side]}`;  // 永远是全局唯一
```

LLM markdown 里引用的 `[BULL-1]` 主要给人类读，状态机不依赖它。

**(b) `resolved` 一票否决 `unresolved`**

`debate.ts:159-165`：先处理 resolved，再处理 unresolved，且 unresolved 检查 `if (reg.resolvedIds.has(id)) continue`。这处理 LLM 把同一 claim 同时放两个列表的矛盾情况 —— 以更乐观的判定为准。

**(c) `next_focus` 双路径计算**

LLM 建议优先，但必须通过 `reg.byId.has(id)` 校验（防 LLM 编不存在的 ID）。LLM 没建议或建议全错 → 自动取未解决 claim 中信心最高的 2 个。**保证下轮永远有焦点**。

### 6.8 第一轮的特殊处理

第一轮没有对方 claim 可回应（`lastBearClaims = []`），`focusIds = []`。prompt 里这段（`debate.ts:104`）给 LLM 退路：

```
（无强制回应项，可自由展开最强论点）
```

从第二轮开始状态机才真正起作用。

### 6.9 一个具体例子：2 轮辩论收敛过程

假设分析某 AI 概念股：

**Round 1 Bull**（focus 为空，自由展开）
```
DEBATE_STATE: {
  "new_claims": [
    {"claim": "国务院AI行动计划落地", "confidence": 0.85},
    {"claim": "北向连续5日净流入8亿", "confidence": 0.7}
  ],
  "resolved_claim_ids": [],
  "unresolved_claim_ids": [],
  "next_focus_claim_ids": []   ← LLM 没建议
}
```
TS 处理后：`BULL-1`（政策，0.85）、`BULL-2`（北向，0.7）入注册表。

**Round 1 Bear**（LLM 没填 next_focus，TS 回退路径取信心最高的）
TS 算出 `focusIds = ["BULL-1", "BULL-2"]`。Bear 必须逐条回应：
```
DEBATE_STATE: {
  "responded_claim_ids": ["BULL-1", "BULL-2"],
  "new_claims": [
    {"claim": "政策落地通常滞后12-18月", "confidence": 0.75},
    {"claim": "北向5日是噪音非趋势", "confidence": 0.8}
  ],
  "resolved_claim_ids": [],              ← Bear 没击穿任何 Bull 论点
  "unresolved_claim_ids": ["BULL-1", "BULL-2"],  ← 诚实承认
  "next_focus_claim_ids": ["BEAR-1"]    ← 建议下轮 Bull 焦点
}
```
TS 处理后：`BULL-1`、`BULL-2` 标 unresolved，`BEAR-1`、`BEAR-2` 入注册表。`focusIds = ["BEAR-1"]`（采纳 LLM 建议）。

**Round 2 Bull**（focus 是 `["BEAR-1"]`）
LLM 必须先回应 BEAR-1（政策滞后），给出判定，再决定要不要抛新论点。如果 Bull 拿不出反驳证据，应该诚实标 unresolved，并把 next_focus 指向自己的新论点。

**收敛效果**：辩论聚焦在"政策到底什么时候落地"这个核心分歧上，而不是各说各话。

### 6.10 "诚实标注"反 prompt

辩论 prompt 末尾有一句关键的反 prompt（`bull_researcher.md:93`）：

> **诚实标注 resolved/unresolved**：辩论的价值在于收敛。无脑标 resolved 会让辩论失真；诚实标 unresolved 才能引导下轮打靶。

这是直接对抗 LLM 的"和稀泥"倾向 —— LLM 默认会标 resolved（显得自己赢了），但这会让辩论失真。明确告诉它"标 unresolved 才能引导下轮打靶"，比单纯加约束更有效。

### 6.11 降级回退：DEBATE_STATE 失败时怎么办

如果 LLM 没输出 DEBATE_STATE 块（JSON 损坏/字段缺失），`parseDebateState` 返回 null，回退到老式 `parseClaims()` 正则解析（`debate.ts:293`）—— 仍然能拿到 claim，只是没有状态更新。**辩论不会崩，只是失去状态机能力**。

---

## 第七章：研究经理 —— 辩论的裁判

辩论结束后，研究经理（Research Manager）当裁判，给双方打分定方向。

### 7.1 角色定位：裁判而非和事佬

`research_manager.md:3` 开篇定调：

> 你必须**独立评估双方论点的质量，而非简单地取中间立场**。

这句话反 LLM 的默认倾向 —— LLM 看到两边都有理，默认会说"取中间值 Hold"。研究经理被要求做**有立场的判定**。

### 7.2 输入：辩论的客观产出，不是状态机内部数据

研究经理看到的辩论数据（`research-manager.ts:67-87`）：

```
### Round 1
多头论点：[BULL-1] 国务院AI行动计划落地（信心 0.85）; [BULL-2] 北向连续5日净流入8亿（信心 0.7）
空头论点：[BEAR-1] 政策落地通常滞后12-18月（信心 0.75）; [BEAR-2] 北向5日是噪音非趋势（信心 0.8）

### Round 2
...
```

加上 `bull_summary` / `bear_summary`（双方各写的 ≤200 字总结）。

**关键：状态机内部数据（resolved_ids/unresolved_ids/next_focus_ids）不喂给研究经理**。这是有意的 —— 辩论双方对自己的论点有"自利"倾向（标 resolved 装赢、标对方 unresolved 贬低）。研究经理只看**客观产出**（claim 内容 + 信心 + 双方总结），独立做评分，不被辩论双方的自评带偏。

### 7.3 评分：非零和设计

`research_manager.md:55-59`：

```markdown
- **多头得分**（0-100）：___
- **空头得分**（0-100）：___
（注：两边评分独立，非零和。可以都高或都低。）
```

**非零和**是关键设计。传统辩论是零和（一方赢另一方必输），但这里的评分有 4 个象限，每个象限对应不同决策含义：

| 多头得分 | 空头得分 | 含义 |
|---------|---------|------|
| 80+ | <40 | 强看多信号 → Buy，高信心 |
| 80+ | 80+ | 分歧大但都有理 → 不确定性高 → Hold 或小仓位 |
| <40 | <40 | 辩论质量差（数据有问题）→ 降低信心 |
| <40 | 80+ | 强看空信号 → Sell |

### 7.4 HOLD 反偷懒门

这是借鉴自 TA-astock 的核心反 prompt（`research_manager.md:20-28`）：

```markdown
## HOLD 判定约束（防偷懒）

HOLD **不得作为"看不清就保守"的逃避选项**。只有**同时**满足以下三项，才允许给出 Hold：

1. **技术面无明确趋势** — 均线纠缠、无突破/破位、无成型形态。
2. **资金面无明确方向** — 主力资金无显著净流入或净流出、北向资金无趋势。
3. **基本面与新闻面无近期催化剂** — 无业绩/政策/订单/事件驱动。

若以上任一条件不满足（即市场已出现方向信号），必须在 Buy/Overweight 与 Sell/Underweight 之间明确表态，**不允许退回 Hold**。给出 Hold 时，必须在"决策理由"中逐条说明上述三项为何同时成立。
```

**解决什么问题**：LLM 在金融场景特别保守 —— 给一堆矛盾报告，默认说"多空均衡，建议 Hold"。但 Hold 在交易里最危险：

- **真正的 Hold** = "市场真的没方向"（横盘震荡）→ 可以维持仓位
- **LLM 的 Hold** = "我看不清楚"（信息不足或推理失败）→ 应该**降低仓位**（看不清就少做）

这两者对仓位管理完全不同。三条件覆盖 A 股三大方向信号源（技术面 + 资金面 + 基本面/消息面），**同时**没信号才允许 Hold。而且**强制举证**：给 Hold 时必须在决策理由里逐条说明三项为何同时成立 —— 把举证责任压给 LLM，不能含糊。

### 7.5 关键辩论焦点：信息压缩

研究经理还要输出"关键辩论焦点 3-5 条"（`research_manager.md:61-63`）。这是对辩论的**信息压缩** —— 辩论可能产生 10+ 个 claim，trader 不需要看全部。研究经理提炼出"最具争议的 3-5 条"，注入 trader prompt（`trader.ts:163`）：

```typescript
const decisionText = `方向：${researchDecision.direction}
信心：${researchDecision.confidence}
理由：${researchDecision.reasoning}
辩论焦点：${researchDecision.key_debate_points.join("、")}`;
```

**压缩链**：辩论 10+ claim → 研究经理提炼 3-5 条关键焦点 → trader prompt。每层都有损压缩，但每层都是更高级别的语义提炼。

### 7.6 模型档位：深度档

研究经理用 `decision_deep` 模型（`research-manager.ts:90`），如果没有配置就回退到 `decision`：

```typescript
model: config.models.decision_deep || config.models.decision,
```

这是"双层模型分级"设计 —— 研究经理和风控经理这两个**最耗推理**的角色（要做综合判断）用更强的模型，分析师/辩手/交易员/风控辩手用快档。可选配置，不配就全用 `decision`。

### 7.7 解析失败的安全默认

5 档方向解析（`research-manager.ts:41-51`）失败时默认 Hold：

```typescript
function parse5TierDirection(raw: string): ResearchDecision["direction"] {
  // ...各种映射
  return "Hold";  // 未识别 → Hold（安全默认）
}
```

金融场景的保守设计 —— 模糊时不下注比乱下注安全。

---

## 第八章：交易员 —— 把方向翻译成可执行计划

研究经理定了方向（如"Overweight，信心 0.7"），交易员（Trader）把它翻译成具体参数：**什么价位买、买多少、分几批、什么信号出场、什么条件放弃**。

### 8.1 角色定位：执行而非判断

`trader.md:32-36` 的"方向锚定规则"是反懒散设计：

```markdown
## 方向锚定规则（严格遵守）

- 你的交易方向（买入/卖出/持有）**必须与研究经理的决策一致**，不得自行翻转方向。
- 仅当上方"风控反馈"章节要求修订（revise）且明确涉及方向时，才可调整方向。
- 你的职责是把研究经理的方向转化为**具体的执行计划**，而非重新判断多空。
```

防止 trader 看到"看空但风险高"时偷偷改成 Hold（LLM 的保守倾向）。

**代码层兜底比 prompt 层更可靠**：`trader.ts:189` 直接用 `researchDecision.direction`，不读 trader 输出的方向（除了 Overweight/Underweight 折叠）。即使 trader LLM 输出 Sell，只要 research 说 Buy，最终方向还是 Buy。

### 8.2 方向映射：5 档折叠成 3 档执行动作

研究经理给 5 档（Buy/Overweight/Hold/Underweight/Sell），trader 折叠成 3 档执行（`trader.ts:194-199`）：

```typescript
direction:
  direction === "Overweight" ? "Buy" :      // 弱看多也是买，仓位少点
  direction === "Underweight" ? "Sell" :    // 弱看空也是卖
  direction,                                  // Buy/Hold/Sell 原样
```

这分离了"**判断强度**"（5 档，研究经理用）和"**执行动作**"（3 档，trader 用）。

### 8.3 Buy/Sell 价格镜像：修复一个死循环 bug

这是 trader 设计里最微妙的部分，来自 commit `95ca94e` 的修复。

**问题背景**：之前 trader.md 只描述了 Buy 方向的价格语义：

> 目标价格 = 上行目标价
> 止损价格 = 跌破即止损的下限价

当研究经理给 Sell 方向时，trader LLM 不知道怎么填这两个字段，**默认填 0**。然后风控看到 `stop_loss = 0` 判定"止损价不合理"，触发 revise 循环。trader 重写时还是不知道怎么填，再次填 0 → **死循环**。

**修复设计**（`trader.md:49-57`）：

```markdown
> 目标价格/止损价格按方向取镜像语义，**三个方向都必须填具体数值，禁止填 0 或留空**：
> - **买入方向**（Buy/Overweight）：目标价格 = 上行目标价；止损价格 = 跌破即止损的下限价
> - **卖出方向**（Sell/Underweight）：目标价格 = 优先卖出价；止损价格 = 止损回补价（反弹突破后需回补）
> - **持有方向**（Hold）：目标价格/止损价格 = 维持现仓位的上下阈值
```

| 方向 | 目标价格 | 止损价格 |
|------|---------|---------|
| **Buy** | 上行目标价（涨到这卖） | 跌破即止损的下限价 |
| **Sell** | 优先卖出价（尽快卖） | 止损回补价（卖错了反弹突破要回补） |
| **Hold** | 维持现仓位的上阈值 | 维持现仓位的下阈值 |

**镜像语义让 Sell 方向也有完整的进出场逻辑**，不会因为字段语义不明而填 0。

### 8.4 三概念区分：入场信号 vs 退出信号 vs 失效条件

`trader.md:59-68` 区分了三个容易混淆的概念：

| 概念 | 时序 | 语义 | 动作 |
|------|------|------|------|
| **入场信号** | 建仓前 | 等什么信号才动手 | 满足 → 建仓/加仓 |
| **退出信号** | 持仓中 | 正常止盈/止损动作 | 价格触目标价/止损价 → 平仓 |
| **失效条件** | 任何时候 | 原判断逻辑被证伪 | 放弃该标的（不再参与） |

**失效条件 vs 退出信号的区分**最关键：
- **退出信号** = 计划内的正常操作（涨到目标价就卖，跌到止损价就止损）
- **失效条件** = 计划外逻辑证伪（看多理由被财报打脸，整个判断作废）

这给交易计划**两层防护**：正常情况靠退出信号管理（止盈止损），异常情况靠失效条件止损（逻辑证伪时彻底放弃）。

### 8.5 TRADER_PLAN 协议：一次 bug 教训的产物

trader 输出 4 个数组字段（entry_signals / exit_signals / invalidations / key_risks），用 `<!-- TRADER_PLAN: {...} -->` JSON 块作为权威（`trader.md:76-90`）。

**为什么必须用 JSON 块？** 来自记忆中的 bug `35e2149`：

之前 trader 只依赖 markdown 散文解析（`parseListSection`），靠匹配 `### 入场信号` 等标题。但**真实 LLM 输出会给标题编号**：

```
### 3. 入场信号（triggers — 等什么信号才动手）
```

而测试 fixture 用的是裸标题：

```
### 入场信号
```

结果正则匹配失败，**静默返回空数组**。测试用裸标题 fixture 给了虚假信心，真实 pipeline 里这 4 个字段全是空的，但没人发现。

**修复后的双路径**（`trader.ts:204-207`）：
- **主路径**：`parseTraderPlan` 读 JSON 块
- **回退路径**：`parseListSection` 读 markdown 段落（正则也修复了，允许数字前缀和括号后缀）

优先 JSON 块，块为空或字段空才回退。这是"结构化块 + 散文回退"标准范式的应用。

> **血泪教训**：当 LLM 解析依赖特定 markdown 格式，而测试 fixture 用的是简化格式，测试会给出**虚假信心**。真实 LLM 输出会编号、加括号、加修饰，破坏正则。**永远用结构化 JSON 块作为主路径，散文作为回退**。

### 8.6 数值解析的智能过滤

价格解析（`parseNumericField`，`trader.ts:50-83`）有个巧妙的过滤逻辑：

```typescript
// 跳过日期数字（后跟 日/年/月/周/天）
if (/^[日年月周天]/.test(after)) continue;        // "200日均线" 的 200 不是价格
// 价格字段跳过百分数
if (!isPercent && /^%/.test(after)) continue;     // "涨幅 8%" 的 8 不是价格
```

LLM 在同一行可能混用价格、百分数、日期数字（如"目标价：120 元（涨幅 8%，200 日均线上方）"），这两个过滤解决了"哪个数字才是价格"的难题。

---

## 第九章：风控辩论 + Revise 循环 —— 兜底防线

交易员出了执行计划，最后过风控。这是 Full 模式的最后一道防线。

### 9.1 风控辩论 vs 多空辩论：本质区别

| 维度 | 多空辩论 | 风控辩论 |
|------|---------|---------|
| **评估对象** | 分析师报告（决定方向） | 已成型的 trading plan（评估可执行性） |
| **角色数** | 2（Bull/Bear 对抗） | 3（激进/保守/中性） |
| **交互模式** | N 轮串行对抗 + 状态机 | 单轮并行，互不见面 |
| **核心问题** | "该不该做？哪个方向？" | "这个计划能执行吗？要加什么约束？" |

**关键区别**：风控辩论**不重新讨论方向**，只讨论"假设方向已定，这个执行计划有什么问题"。这是 `risk_manager.md:5-7` 显式声明的：

```markdown
## 核心原则

**尊重上游方向判断**。你的职责是补充风控约束，而非推翻方向决策。
只有在上游遗漏重大风险时才调整方向。
```

防止风控经理变成"第二个研究经理" —— 否则两个 LLM 都在判断方向，pipeline 就乱了。

### 9.2 3 方角色的 A 股特化立场

3 个角色的立场直接硬编码在 TS 里（`risk.ts:43-62`），不读 prompt 文件 —— 因为这些 A 股市场知识需要精确措辞：

**aggressive（激进风控）**：穷尽做多理由 —— 政策底、北向确认、涨停动量、PE 扩张（A股牛市成长股 PE 常 50-100x，过早套用美股 15-25x 会错过主升浪）、游资放大器。

**conservative（保守风控）**：吹哨人 —— T+1 锁定风险（A 股最重大结构性风险）、跌停焊死（卖不出去）、解禁压力（>20% 流通市值为重大压力）、政策反转、估值纪律（PE>50x 且 PEG>2 属投机）。

**neutral（中性风控）**：条件性平衡 —— T+1 是双刃剑（既锁定损失也抑制恐慌）、政策信号分层（国务院 > 部委 > 地方 > 传闻）、仓位管理优先于方向判断（"买多少"比"买不买"更重要）。

**不是简单的"乐观-悲观-中立"光谱**，而是三种**不同的风险分析视角**。neutral 不是"和稀泥"，而是"把两方论点拆解为可验证条件，指出各自何时成立"。风控经理看到的是 3 种互补视角而非 3 个投票。

### 9.3 单轮并行：3 方互不见面

3 个角色并行执行（`risk.ts:130-187`），**互相看不到对方的输出**。每方独立评估 trading plan，给出 verdict（pass/revise/reject）+ 证据。风控经理综合 3 方观点。

**为什么不让 3 方互相反驳（像多空辩论）？** 因为风控辩论的本质是**多元评估**而非对抗收敛。3 方是互补视角（激进看机会、保守看风险、中立看条件），不需要互相反驳。如果搞多轮对抗，会变成"激进和保守互相反驳 N 轮" —— 但这其实是多空辩论的重复，浪费 LLM 调用。所以风控辩论选择**单轮并行 + 经理综合**，更高效。

### 9.4 RISK_JUDGE：4 类约束的层次设计

风控经理输出 `<!-- RISK_JUDGE: {...} -->` JSON 块（`risk_manager.md:65-66`），4 类约束按**强制性 × 时序**分类：

| 类别 | 强制性 | 时序 | 语义 |
|------|--------|------|------|
| **hard_constraints** | 强制 | 全程 | 仓位上限/止损下限/单笔比例 |
| **soft_constraints** | 建议 | 全程 | 分批建仓/避开集合竞价 |
| **execution_preconditions** | 强制 | 建仓前 | 开盘不追高/北向确认 |
| **de_risk_triggers** | 强制 | 持仓中 | 跌破支撑/政策反转 |

**梯度强制性**：`buildRiskJudgeText`（`trader.ts:22-42`）渲染时，只有 `hard_constraints` 标"必须满足，违反即视为不合规"，其他 3 类不标。让 trader 知道哪些是红线，哪些建可以灵活处理。

### 9.5 Revise 循环：风控约束如何改变 trader 行为

这是风控设计真正发挥作用的地方（`orchestrator.ts:668-690`）：

```
风控经理给 revise + RISK_JUDGE
  ↓
orchestrator 把 RISK_JUDGE 透传给 trader 第 9 个参数
  ↓
buildRiskJudgeText 渲染成 prompt 段 → {{risk_judge}} 注入
  ↓
trader 看到约束，重写计划时遵守
  ↓
新计划再过一轮风控辩论 + 风控经理
  ↓
还是 revise? → 重复（最多 max_risk_retries 次）
  ↓
超过上限仍 revise → 保留 revise + 标记 retries_exhausted（不伪造 pass）
```

**关键设计**：

1. **risk_judge 透传**（P1-2 修复）：之前 revise 是盲重试（trader 不知道风控为啥驳回），现在 trader 看到具体约束，重写的计划**真的回应**了上轮问题。

2. **数值兜底**：`max_position_override` 作为数值硬上限，即使 LLM 无视 hard_constraints 文本，仓位也会被强制压制。这是"不信任 LLM"的工程实践。

3. **死循环防护 + 诚实标注**（commit `6b6dc86`）：超过 `max_risk_retries` 仍 revise，**保留 `status: "revise"` 并设置 `retries_exhausted: true`**，而不是强制翻转为 pass。为什么不能翻 pass？旧逻辑翻成 pass 后，外层 status=pass 但内层 `judge.verdict` 仍是 revise、reasoning 仍是"禁止当日建仓"，报告**自相矛盾**。保留 revise 让下游（dashboard 徽章、report-formatter、`FinalDecision.risk_assessment`）看到真实的风控态度 —— 这些消费者本来就处理 revise 状态，不需要额外适配。

### 9.6 VERDICT + RISK_JUDGE 双块协议

风控经理输出**两个连续的 HTML 注释块**（`risk_manager.md:62-66`）：

```html
<!-- VERDICT: {"direction": "revise", "reason": "..."} -->
<!-- RISK_JUDGE: {"verdict": "revise", "reason": "...", "hard_constraints": [...], ...} -->
```

**为什么要两个块？** 三级降级（`risk.ts:221-223`）：

```typescript
const judge = parseRiskJudge(result.content);   // 主：含 4 类约束
const verdict = parseVerdict(result.content);   // 兜底：只有 verdict
const status = (judge?.verdict || verdict?.direction || "pass");
```

- **RISK_JUDGE 是主路径**：包含 verdict + reason + 4 类约束
- **VERDICT 是兜底**：RISK_JUDGE 解析失败时至少能拿到 verdict
- **"pass" 是终极兜底**：两个都失败也给个默认值

这是 TRADER_PLAN bug 教训的标准化应用 —— **不能只依赖 markdown 散文解析**，必须有结构化 JSON 块作为权威，同时保留 VERDICT 作为终极兜底，确保 pipeline 不崩。

---

## 第十章：贯穿全程的设计哲学

回顾整个 pipeline，有几个反复出现的设计模式。

### 10.1 五个机器可读协议

| 协议 | 文件 | 用途 |
|------|------|------|
| `<!-- VERDICT -->` | `llm-client.ts` | direction + reason（每个阶段都有） |
| `<!-- DEBATE_STATE -->` | `debate.ts` | 辩论状态机（resolved/unresolved/focus） |
| `<!-- RISK_JUDGE -->` | `risk.ts` | 风控约束（4 类） |
| `<!-- TRADER_PLAN -->` | `trader.ts` | 交易信号（entry/exit/invalidations/risks） |
| `<!-- QUALITY_REVIEW -->` | `quality-review.ts` | 数据可信度（高/中/低 + 陈旧/虚构嫌疑） |

**同一个套路**：`regex → JSON.parse → object 校验 → coerceStrArray → null 容错`，加 markdown 散文回退。LLM 输出结构化 JSON 块作为权威，散文作为人类可读解释和回退。记住这个套路，看到任何协议都不陌生。

### 10.2 优雅降级链

每个环节都有降级路径，确保 pipeline 永不崩：

| 环节 | 失败情况 | 降级方式 |
|------|---------|---------|
| 数据脚本 | Python 异常 | 占位文本 `{success: false}`，不阻塞其他脚本 |
| 分析师 | LLM 失败 | 占位报告 `[分析失败: ...]` |
| VERDICT 解析 | JSON 损坏 | 回退到关键词扫描 |
| Layer-2 质量审查 | LLM 异常 | 返回 null，回退到 Layer-1 |
| PM 方向解析 | VERDICT 失败 | 回退到 7 分析师多数投票 |
| 辩论状态机 | DEBATE_STATE 缺失 | 回退到老式 parseClaims 正则 |
| 风控 RISK_JUDGE | JSON 损坏 | 回退到 VERDICT |
| Revise 重试耗尽 | 超过 max_retries 仍 revise | 保留 revise + 标记 `retries_exhausted`（不伪造 pass，避免自相矛盾） |

**"无论如何都有输出"** —— 这是工程哲学。用户拿到的永远是一个完整结果（哪怕质量打折），而不是报错。

### 10.3 双层模型分级

`models.decision_deep` 可选配置 —— 让两个最耗推理的角色（研究经理 + 风控经理）用更强的模型，其他角色用快档：

| 档位 | 角色 | 原因 |
|------|------|------|
| **深度档**（`decision_deep`） | 研究经理、风控经理 | 综合判断 + 约束提炼，最耗推理 |
| **快档**（`decision`/`analyst`/`debater`/`risk`） | 分析师、辩手、交易员、风控辩手 | 单一任务，快就行 |

可选 —— 不配就全用 `decision`（legacy 行为）。借鉴自上游 TradingAgents 的 quick/deep 分级。

### 10.4 A 股特化点

不是简单复刻美股版 TradingAgents，做了 A 股本地化：

- **T+1 + 涨跌停板**写进 trader 和风控角色的 prompt
- **北向资金**作为独立信号
- **Buy/Sell 价格镜像**（commit `95ca94e`）：Sell 方向也要填目标价/止损，否则 LLM 填 0 → 风控误判 revise 循环
- **HOLD 反懒散门**（P1-b）：HOLD 只能在研究经理定，trader 不能擅自降级
- **PE 扩张认知**：A 股牛市成长股 PE 常 50-100x，不套用美股 15-25x

### 10.5 可观测性

每次 LLM 调用都写 trace（含 raw_content + tokens + cost + duration），`run_summary.json` 汇总。所有外部数据脚本输出都落盘到 `03_data` / `07_data`。**完整溯源** —— 任何决策都能回溯到"哪个角色在什么时候说了什么"。

---

## 术语表（小白向）

| 术语 | 通俗解释 |
|------|---------|
| **LLM** | 大语言模型，比如 ChatGPT、Claude、GLM。这里每个"角色"都是一次 LLM 调用 |
| **pipeline** | 流水线。数据从一端进，经过多个处理阶段，从另一端出结果 |
| **prompt** | 给 LLM 的指令文本。本项目用 markdown 模板 + `{{变量}}` 占位符 |
| **VERDICT** | LLM 输出末尾的"结论块"，告诉程序"我最终给的方向是什么" |
| **claim** | 辩论里的一个论点（带 ID、内容、证据、信心） |
| **resolved/unresolved** | claim 的状态：被击穿（结案）/ 仍未解决（战场） |
| **T+1** | A 股规则：今天买的股票明天才能卖 |
| **涨跌停板** | A 股规则：单日涨跌幅有限制（主板 ±10%、科创/创业 ±20%） |
| **北向资金** | 通过沪深股通从香港流入 A 股的外资，被视为"聪明钱" |
| **解禁** | 限售股到期可以卖了，通常带来抛压 |
| **revise 循环** | 风控驳回 → 交易员重写 → 再过风控的循环 |
| **decision_deep** | 可选的"深度模型"配置，给最耗推理的角色用更强模型 |
| **优雅降级** | 某个环节失败时不崩溃，而是降级到更简单的处理方式 |
| **状态机** | 用状态（open/resolved/unresolved）跟踪事物演变的机制 |
| **stagger** | 并发时每个任务启动前随机延迟，避免 burst 触发限流 |

---

## 延伸阅读

- [`architecture.zh.md`](architecture.zh.md) —— 组件清单式架构概览
- [`prompts.zh.md`](prompts.zh.md) —— 角色 prompt 变量对照表
- [`data-sources.zh.md`](data-sources.zh.md) —— 7 个数据源的详细说明
- [`competitor-analysis.zh.md`](competitor-analysis.zh.md) —— 与上游 TradingAgents / TA-astock 的对比
- [`design/deferred-memory-and-reflection.zh.md`](design/deferred-memory-and-reflection.zh.md) —— 未来路线（跨 run 记忆 + 自反思）
- 源码：`src/orchestrator.ts`（主流程）、`src/debate.ts`（辩论状态机）、`src/risk.ts`（风控）、`src/trader.ts`（交易员）
