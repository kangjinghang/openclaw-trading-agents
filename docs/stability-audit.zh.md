# 稳定性实测分析报告

> 基于 8 份实际产出报告的稳定性审查（控制流 + 数据源 + 观测层）
> 审查日期：2026-06-15
> 数据样本：000661 / 300681 / 600029 / 600315 / 600519 / 600600，覆盖 quick + full 模式
> 证据来源：报告 JSON、LLM trace（19 条）、2 份 verify 日志、7 个数据源 raw 产物

---

## 结论先行

控制流框架已经相当稳健（降级 / 重试 / 健康检查都到位），但有两个系统性短板在持续拖累稳定性 —— 一个在数据源层，一个在观测层。**是否还要继续提升稳定性：要，但重点不是重写控制流，而是补 3 个具体缺口。**

| 维度 | 成熟度 | 实测证据 |
|------|--------|----------|
| 控制流降级 | 🟢 强 | 数据失败注入 `[数据缺失]`、占位符泄漏跳过、analyst 失败兜底中性、hasAbort 终止 |
| LLM 重试 / 限流 | 🟢 强 | 429 指数退避 + 跨 worker 协调器 + 空内容重试 |
| 数据源容错 | 🟡 中 | kline 双源 fallback 好；但 news 的 CLS 源**系统性失效**且静默吞错 |
| 超时治理 | 🔴 弱 | 单次 LLM 卡死 = 5 分钟阻塞，已实测导致 36 分钟运行 |
| 观测一致性 | 🔴 弱 | summary 与 run_summary 双写曾漂移（token=0），已修但架构隐患仍在 |

---

## 一、控制流稳定性

### ✅ 做得好的部分

**1. 优雅降级链路完整。** 多处实测验证：

- `src/orchestrator.ts:680-682`：数据源失败时注入 `[数据缺失: <error>]` 而非崩溃，下游 analyst 照常运行
- `src/orchestrator.ts:786-798`：单个 analyst LLM 抛错 → 兜底 `{direction: "中性"}`，不阻塞其他 6 个
- `src/orchestrator.ts:843-844`：`haltIfAborted(health)` 在 ≥6 数据源失败时终止，避免空分析师喂给 PM

**2. LLM 重试设计专业。** `src/llm-client.ts`：

- 空内容重试（`LLM_MAX_RETRIES=2`）
- 429 专属指数退避（5s → 15s → 45s，尊重 `Retry-After` 头）
- `RateLimitCoordinator` 跨并发 worker 共享冷却期，**防止重试风暴**（这点很多同类项目都漏了）

**3. risk revise 循环有界。** `src/orchestrator.ts:1152`：

```typescript
while (riskAssessment.status === "revise" && retries < config.max_risk_retries)
```

无限循环风险已规避。verify 日志实测：修订耗尽后保留 `revise` verdict 并如实标注（不伪造 pass）。

**4. 占位符泄漏检测（P0 修复已验证）。**

verify 日志显示 600315 首跑时 news 分析师收到了字面 `{{stock_news}}`（模板变量绑定 bug），LLM 只能诚实报告"数据接口未能成功解析"。但**当前代码 `src/orchestrator.ts:725-742` 已加检测**，未替换占位符 → 跳过该 analyst 并记 `skip` 级 health issue。fix-verify 日志确认修复：news grade 从 C → A，整体可信度从"低" → "中"。

### 🔴 核心短板：LLM 单次调用超时 = 5 分钟

这是**当前控制流最大的稳定性风险**，已实测复现。

**实测证据（300681_full，trace 时间线）：**

```
fundamentals 调用 #1: dur=300007ms  tokens=0  content=""   ← 卡满 5 分钟超时
fundamentals 调用 #2: dur=64938ms   tokens=8715 content=正常  ← 重试成功
```

- `src/constants.ts`：`LLM_TIMEOUT_MS = 5 * 60 * 1000`（5 分钟）
- `src/llm-client.ts:172`：`setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)`
- 一次卡死 = **阻塞该 analyst worker 5 分钟**，重试再吃 1-2 分钟
- 300681 总耗时 **2164 秒（36 分钟）**，远超正常的 700-1170 秒

各报告耗时实测对比：

| 报告 | 方向 | 耗时 | tokens | 备注 |
|------|------|------|--------|------|
| 600519_quick (6-8) | Buy | 282s | 41599 | 基线（正常） |
| 600029_quick (6-15) | Hold | 710s | 88558 | 正常 |
| 600029_full (6-9) | Hold | 739s | 0* | 正常（token 漂移，见第三节） |
| 600600_full (6-9) | Sell | 1036s | 0* | 正常 |
| 600315_full (6-10) | Buy | 1169s | 293005 | 正常上限 |
| **300681_full (6-15)** | **Sell** | **2164s** | 222979 | **⚠ 异常，含一次 5 分钟卡死** |

**根因分析**：GLM 等推理模型偶发首 token 延迟极高（网络抖动 / 排队），5 分钟阈值对"慢但能出结果"的调用过于宽容，对"卡死"的调用又不够快放弃。

**修复建议（按优先级）：**

1. **拆分超时**：connect timeout（10s）+ 首 token timeout（60s）+ 总 timeout（180s）。OpenAI SDK 支持流式，首 token 到了就基本不会卡死。
2. **超时算 retry budget**：当前超时后重试，3 次 × 5 分钟 = 15 分钟最坏情况。改为总 deadline（如 8 分钟内必须出结果）。

---

## 二、数据源稳定性

### 🔴 系统性问题 1：macro_news 恒为 0（所有 8 份报告无一例外）

**实测：**

| 报告 | K线条数 | 个股新闻 | 宏观新闻 |
|------|---------|----------|----------|
| 000661_full (6-8) | 120 | 50 | **0** |
| 300681_full (6-15) | 120 | 50 | **0** |
| 600029_full (6-9) | 120 | 50 | **0** |
| 600029_quick (6-15) | 120 | 50 | **0** |
| 600315_full (6-10) | 120 | 50 | **0** |
| 600519_quick (6-8) | ❌超时 | 50 | **0** |
| 600519_quick (6-12) | 120 | 50 | **0** |
| 600600_full (6-9) | 120 | 50 | **0** |

**根因（`skills/trading-news/scripts/news.py:64-92`）：**

```python
def _fetch_global_news_cls(limit=10):
    try:
        url = "https://www.cls.cn/nodeapi/telegraphList"
        ...
    except Exception:      # ← 静默吞掉所有错误
        pass
    return articles        # ← 返回空列表，调用方无从知晓
```

实测该 CLS 接口当前返回**非 JSON（JSONDecodeError）**——接口已失效或加了反爬。但代码 `except Exception: pass` 把它吞了，所以：

- `data["macro_news"] = []` 静默写入
- analyst 拿到空宏观新闻，LLM 只能说"无宏观信息"
- **policy / news 分析师实际上一直在"缺一条腿"做分析，持续了至少 7 天**

**这是最该立刻修的数据源问题**，因为它是**静默失效**——既不报错也不降级提示。

**修复建议：**

1. CLS 失效 → 接入 macro 备选源（新浪财经宏观 / 东方财富要闻 / 同花顺财经）。`skills/_shared/http_helpers.py` 已有 `http_get` 重试基础，加一个 macro 专用 fallback 链。
2. **关键**：失败时在 `data["macro_news_error"]` 里写明原因（代码已有 `macro_news_error` 字段但被 `except: pass` 跳过了，见 `news.py:177`），让下游能看到"宏观数据源失效"而非"无宏观新闻"。
3. 把 `skills/_shared/http_helpers.py` 的 `_with_retry` 默认 `retry_on` 扩展到包含 `JSONDecodeError` 和 HTTP 5xx（当前只重试 `ConnectionError`）。

### 🔴 系统性问题 2：K线数据源偶发超时（30s 硬上限）

**实测（600519 首跑）：**

```json
// 600519/2026-06-08_quick/03_data/market_raw.json
{"success": false, "error": "Python script timed out after 30000ms: .../kline.py"}
```

- `src/constants.ts`：`PYTHON_SCRIPT_TIMEOUT_MS = 30_000`
- mootdx（通达信行情协议）偶发连接慢，30s 不够 → 整个 K线采集失败
- **但 `kline.py` 自身容错是好的**（`fetch()` 函数 mootdx → akshare 双源 fallback，`kline.py:669-708`）

**矛盾点**：`kline.py` 内部有双源重试，但 Node 层 30s 超时会在双源都还没试完时就 kill 进程。实测 600519 第二天（6-12）就成功了，说明是**偶发性慢**而非永久故障。

**修复建议：**

1. 数据脚本超时分层：K线给 45-60s（有双源重试预算），轻量脚本（lockup / sentiment）保持 30s。
2. 或者：`src/exec-python.ts` 对失败的数据脚本做**一次 Node 层重试**（当前 Node 层完全不重试，只靠脚本内部）。

### 🟡 次要问题：`except Exception: pass` 普遍存在

```
fundamentals.py: 14 个 except 块
kline.py:         12 个
news.py:           8 个
（每个脚本都有）
```

多数是合理的（单条记录解析失败不影响整批），但像 CLS 那种**整源失败被吞**的情况混在里面，难以区分。建议：脚本顶层加一个 `errors[]` 收集器，把吞掉的异常汇总输出到 stderr（不改变 success 语义，但可观测）。

### ✅ 数据源做得好的部分

- **K线双源 fallback**（mootdx → akshare）+ 120 根完整性检查 + 最后 bar 新鲜度检查（>7 天告警）
- **东方财富限流**：`em_get` 全局节流（`EM_MIN_INTERVAL=1.0s`）+ IPv4 强制（解决 push2 的 IPv6 reset）
- **缓存**：4h TTL，避免同日重跑反复打数据源

---

## 三、观测层的一致性隐患

### 🔴 summary 与 run_summary 双写漂移（已修但架构隐患在）

**实测：**

| 报告 | report.json tokens | run_summary.json tokens |
|------|-------------------|------------------------|
| 600600_full | **0** | 292330 |
| 600029_full | **0** | 198496 |
| 000661_full | **0** | 155218 |
| 300681_full | 222979 | 222979 ✓ |

根因：`saveFull` 早期传了 0（commit `e17f2a8` "fix: saveFull 摘要的 total_tokens/cost 改传真实累计值（review 缺口 #7）" 修复，改传 `traceLogger.totalTokens`）。**新报告已正确。**

**但隐患**：顶层 summary（`src/report-store.ts:160`）和 `run_summary.json`（`src/orchestrator.ts:1279`）是**两条独立写入路径**，各取各的值。任何一方改了字段名 / 来源，又会静默漂移。

**建议**：`run_summary` 作为唯一真相源，`report.json` 的 token / cost / trace_count 直接从同一个对象引用，而非重新计算。

---

## 四、修复优先级

| 优先级 | 问题 | 影响 | 工作量 | 关联代码 |
|--------|------|------|--------|----------|
| **P0** | macro_news CLS 源失效 + 静默吞错 | 7 天来所有报告缺宏观腿，且无告警 | 小 | `skills/trading-news/scripts/news.py:64-92` |
| **P0** | LLM 5 分钟超时阈值过大 | 偶发 36 分钟运行，用户体验崩溃 | 中 | `src/constants.ts` + `src/llm-client.ts:172` |
| **P1** | 数据脚本 Node 层无重试 | K线偶发 30s 超时直接失败 | 小 | `src/exec-python.ts` |
| **P1** | summary / run_summary 双写 | 排障时数据不一致 | 小 | `src/report-store.ts:160` + `src/orchestrator.ts:1279` |
| **P2** | `except: pass` 不可观测 | 静默失效难定位 | 中 | `skills/*/scripts/*.py`（全部） |

---

## 五、整体判断

**控制流的骨架是稳的**——不需要重构 pipeline，降级 / 重试 / 健康检查这三件套已经超过大多数同类项目（包括 `RateLimitCoordinator` 这种细节）。最近几个 commit（P0-P3 audit、quality gate Layer-1/2、cross-stage checks）说明加固方向正确。

**真正还在拖后腿的是数据源层**——具体说是一个失效的 CLS 接口被静默吞了 7 天。这不是"控制流不稳"，是"数据源监控缺失"。修掉 macro_news 这一项，full 模式分析质量会立刻上一个台阶（policy / news 分析师终于能拿到宏观上下文）。

---

## 附：实测样本来源

| 路径 | 用途 |
|------|------|
| `~/.openclaw/trading-reports/*/` | 8 份报告 JSON + 各阶段 detail |
| `~/.openclaw/trading-reports/300681/.../06_traces/run-*/` | 19 条 LLM trace（含耗时 / token / content） |
| `~/.openclaw/trading-reports/*/(07_data|03_data)/*_raw.json` | 7 个数据源原始产物（success / error / 数据完整性） |
| `logs/run-600315-verify.log` | full 模式运行时 stderr（含占位符泄漏复现） |
| `logs/run-600315-fix-verify.log` | 修复后验证运行（占位符泄漏已修复） |
