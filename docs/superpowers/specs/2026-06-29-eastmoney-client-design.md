# EastmoneyClient 设计：封装东财官方 mx-skills 全量 15 个 Skill

> 日期：2026-06-29
> 对齐样板：`skills/_shared/iwencai_client.py`（问财官方 25 skill 封装）
> 源码来源：`C:\Users\kangjinghang\Downloads\mx-skills\mx-skills`（东财官方 skill 包，15 个 skill）

## 背景与动机

项目已有的 `iwencai_client.py` 是从问财官方 skill 包扒源码复刻成的 client 类，作为"官方授权通道"为 news 等数据源提供权威增强源（未配 key / 失败自动回退东财/akshare 爬虫，零行为变化）。

本次对东财做**完全对等**的处理：从下载的东财官方 skill 包（`mx-skills`）扒源码，复刻成 `EastmoneyClient` 类。该包通过统一授权网关 `https://ai-saas.eastmoney.com/proxy/...` + `em_api_key` header 认证调用东财后端，可靠性远超项目现有爬虫路径（`search-api-web` 靠 `cffi_get` 的 TLS 指纹绕 JA3 反爬，易拿股吧噪声 + 限流）。

## 关键决策（用户已确认）

1. **Client 定位：纯新增可选增强**。完全对齐 iwencai 的 `available` 开关 + 自动降级模式。**不碰** `http_helpers.py` 里的 `em_get/cffi_get/eastmoney_datacenter` 和 7 个 data script 的爬虫调用。这是并行的"官方授权通道"，和爬虫"公开网页通道"互不影响。
2. **封装范围：全封装 15 个 skill**。"能封装都封装，用不用以后再说"——把 client 的能力建完整，用不用是上层的事。报告生成类/问答类也封装，留作以后用。
3. **不复刻硬编码默认 key**。mx-skills 的 15 个文件都硬编码了测试 key `em_1zye6VUnIKUMPZttCKfyBtGsehCkN9f8`。本项目对齐 iwencai 原则：未配 `EM_API_KEY` 环境变量就是 `available=False`，不把官方包的测试 key 带进项目。
4. **Client 方法默认不落盘**。iwencai 的方法不落盘（news.py 拿到结果自己处理）。EastmoneyClient 保持纯数据层职责，返回结构化结果 + 原始附件 base64（或解码后的 bytes）。报告类如要落盘，方法签名加 `output_dir=None` 可选参数。

## 精读结论：15 个 skill 实际对接东财 3 类后端

| 后端族 | 路径前缀 | 请求体 | 返回形态 | 包含的 skill |
|---|---|---|---|---|
| **A. MCP 工具网关** | `/proxy/b/mcp/tool/*` | `query` + `toolContext{callId,userInfo}` | **结构化表格**（dataTableDTOList / dataList） | mx-finance-data、mx-finance-search、mx-macro-data、mx-stocks-screener |
| **B. 投顾助手 API** | `/proxy/app-robo-advisor-api/assistant/*`（非 write） | 极简 `question` 或 `query` | Markdown 文本（displayData） | stock-diagnosis、fund-diagnosis、hotspot-discovery、comparable-company、mx-financial-assistant(ask)、mx-personal-kb-search |
| **C. 报告生成 API** | `/proxy/app-robo-advisor-api/assistant/write/*` | `query`（或 query+reportDate） | 标题+正文+**base64 附件**（PDF/Word），1200s | industry-research、industry-stock-tracker、initiation-of-coverage、topic-research、stock-earnings-review（3 步） |

三族**共用一个 `em_api_key` 认证 + 同一个 base 域名** `https://ai-saas.eastmoney.com`，但请求体、返回形态、timeout 差异巨大。

## 架构

### 文件定位

**新文件**：`skills/_shared/eastmoney_client.py`，与 `iwencai_client.py` 并列。

**完全复用 iwencai 的 6 个关键设计**：
- `__init__` 从环境变量 `EM_API_KEY` 读配置，`self.available = bool(self.api_key)`
- 统一请求内核：认证 + 重试 + 401 短路 + `record_call` 可观测性
- 模块级 `get_client()` 单例
- 未配 key / 401 → `available=False` → 方法返回空，调用方零行为变化
- import `http_helpers.record_call`（带 try/except 兜底，保证独立可运行）
- 方法名对齐业务语义（`search_data`/`diagnose_stock` 等），而非裸 HTTP

### 核心扩展：3 族分层请求内核

iwencai 是单族（一个 `_post`），东财因为 3 族后端请求体/返回/timeout 差异大，需要 **3 个分层请求方法**，共享 auth/重试/401 短路/record_call 骨架：

| 方法 | 族 | path | body 骨架 | 默认 timeout |
|---|---|---|---|---|
| `_post_mcp` | A | `/proxy/b/mcp/tool/<endpoint>` | `query + toolContext{callId,userInfo}` | 30s（finance-data 特例 120s） |
| `_post_advisor` | B | `/proxy/app-robo-advisor-api/assistant/<endpoint>` | `question` 或 `query` | 60s |
| `_post_report` | C | `/proxy/app-robo-advisor-api/assistant/write/<endpoint>` | `query` 或 `query+reportDate` | **1200s**（可参数化） |

3 个方法都走 iwencai `_post` 的同款骨架：2 次重试、401 短路、record_call（成功 + 失败两条路径都记 url/status/size）。

## 方法清单（15 个 skill → 14 个客户端方法）

generate_report 合并 4 个同构报告，故 15 skill → 14 方法。

### 族 A：MCP 数据查询（结构化返回）

| 方法 | 对应 skill | path | 特化逻辑 |
|---|---|---|---|
| `search_data(query, indicators=None)` | mx-finance-data | `searchData` | 实体识别前置（>5 实体走 `toolPreTaskResultList`）+ query 改写 + `dataTableDTOList` 多级路径解析 |
| `search_news(query)` | mx-finance-search | `searchNews` | 扁平文本提取（`llmSearchResponse`/`searchResponse`/`content` 兜底链） |
| `search_macro_data(query)` | mx-macro-data | `searchMacroData` | `dataTables` 路径 + 频率分组解析（年/季/月/周/日） |
| `select_security(query, select_type)` | mx-stocks-screener | `selectSecurity` | `selectType` 传参（A股/港股/美股/基金/ETF/可转债/板块），`allResults.result.dataList+columns` 解析 |
| `recognize_entities(query)` | mx-finance-data 实体识别前置 | `/proxy/entity/saas` | `content+typeCodes` 请求，`entityMetricList`/`entityList` 解析 |

### 族 B：投顾诊断/问答（Markdown 返回）

| 方法 | 对应 skill | path 末段 | 特化逻辑 |
|---|---|---|---|
| `diagnose_stock(question)` | stock-diagnosis | `stock-analysis` | `{"question":…}`，`data.displayData` 提取 |
| `diagnose_fund(question)` | fund-diagnosis | `fund-analysis` | 同上 |
| `discover_hotspot(question)` | hotspot-discovery | `hotspot-discovery` | 同上 |
| `comparable_company_analysis(question)` | comparable-company | `comparable-company-analysis`（无 write/） | `question` 键，返回 list 三元结构（header/section_finance/section_valuation），60s timeout |
| `ask(question, deep_think=False)` | mx-financial-assistant | `ask` | `deepThink` 仅开时写入（对齐官方"省略即关闭"），返回 `displayData` + `refIndexList` 溯源 |
| `search_kb(query)` | mx-personal-kb-search | `private-domain-search` | 多形态 chunk 解析 + 保留 `_has_valid_content` 过滤（不把"您暂无权限"写成文件） |

### 族 C：报告生成（1200s + 附件落盘）

| 方法 | 对应 skill | path 末段 | 特化逻辑 |
|---|---|---|---|
| `generate_report(kind, query, output_dir=None)` | 4 个同构报告统一参数化 | `write/industry/research` 等 | kind: industry/tracking/initial_coverage/thematic；返回 title/content/shareUrl + 附件 base64；可选落盘 PDF/Word |
| `earnings_review(query, report_date=None, output_dir=None)` | stock-earnings-review | 3 步协议 | 特殊：①`/proxy/entity/dialogTagsV2` 实体识别 → ②`write/choice/reportList` 报告期 → ③`write/performance/comment` 点评；带 `em_base_info:{productType:mx}` 头；附件 .doc + .xlsx；任一步失败整体返回空 |

**kind 映射**（generate_report 内部）：
```python
_REPORT_KINDS = {
    "industry":          {"path": "write/industry/research",      "slug": "industry_research_report"},
    "tracking":          {"path": "write/tracking/report",         "slug": "industry_stock_tracker"},
    "initial_coverage":  {"path": "write/initial-coverage",        "slug": "initiation_of_coverage_or_deep_dive"},
    "thematic":          {"path": "write/thematic/research",       "slug": "topic_research_report"},
}
```

### 通用辅助

- `supported_skills` property ← slug→中文名映射（对齐 iwencai）

## 统一配置

```python
EM_API_KEY = os.environ.get("EM_API_KEY", "").strip()  # 不复刻硬编码默认 key
EM_BASE_URL = (os.environ.get("EM_BASE_URL") or "https://ai-saas.eastmoney.com").rstrip("/")
```

## 错误处理与降级

完全复用 iwencai 模式：
- `available=False`（未配 key / 401/403）→ 所有方法返回 `[]` 或 `{}`
- 3 个 `_post_*` 全程 try/except，异常不向上传播，统一返回空
- 调用方（data script）据此判断空结果并 fallback 到现有爬虫

**特例处理**：
- 族 C `_post_report` 允许调用方传 `timeout` 覆盖，默认 1200
- `earnings_review` 3 步协议任一步失败即整体返回 `{}`，不让中间状态泄漏

## 封装时一并修正的 mx-skills bug（复刻不是照搬）

1. **finance-search 缺 userId**：实际请求的 toolContext 只有 callId（dead code `get_metadata` 才有 userId）→ 统一补上
2. **macro-data `api_base` 入参被覆盖**：L265 `api_base = DEFAULT_URL.rstrip("/")` 覆盖了函数入参 → client 内自然消除
3. **macro-data `DEFAULT_PAHT` 拼写错误**：应为 PATH → client 内自然消除
4. **统一 HTTP 客户端到 requests（同步）**：mx-skills 混用 httpx 异步 + urllib 同步 + run_in_executor 包装；client 对齐 iwencai 统一用 requests（同步），简化 + 与 record_call 协作更直接

## 测试

新增 `tests/scripts/test_eastmoney_client.py`，对齐 `test_iwencai_client.py`（13 个用例）的风格。

### 通用层（和 iwencai 同款）
- 未配 key 降级（available=False，方法返回空，0 次网络调用）
- 401/403 短路（available 标 False，第二次不再请求）
- 5xx 重试一次后返回空
- timeout 重试一次后返回空
- JSON 解析异常返回空
- record_call 落表（成功 + 失败两条路径）
- 单例

### 各方法特化（挑代表性）
- `search_data` 实体识别前置 + 多实体分支（>5 实体走 toolPreTaskResultList）
- `search_news` 扁平文本提取
- `search_macro_data` 频率分组解析
- `select_security` selectType 传参
- `diagnose_stock/fund` displayData 提取
- `comparable_company_analysis` list 结构 + 60s timeout
- `ask` deepThink 仅开时写入（断言关闭时不带该 key）
- `search_kb` `_has_valid_content` 过滤逻辑
- `generate_report` 4 种 kind 路径映射 + base64 附件解码
- `earnings_review` 3 步协议串行 + 任一步失败整体返回空

全部 mock 网络，无真实流量（和 iwencai 测试一致）。

## 不做的事（明确排除）

- **不改任何现有 data script**（news.py/fundamentals.py/hot_money.py/lockup.py/sector.py/sentiment.py/policy.py）。EastmoneyClient 是新增的独立 client，本次不接入任何调用方。
- **不改 `http_helpers.py`** 的 em_get/cffi_get/eastmoney_datacenter。
- **不碰现有测试**（test_http_helpers/test_margin_trading/test_news_filter/test_macro_only 的 patch 点不变）。
- **不改 TypeScript 侧**（src/、dist/）—— 本次纯 Python 层新增。
- **不复刻硬编码默认 key**。

接入 data script（让 EastmoneyClient 成为某个 analyst 的权威源 + 失败回退爬虫）是后续独立任务，不在本次范围。

## 依赖

- `requests`（已在 requirements.txt，iwencai 也用它）
- `http_helpers.record_call`（已存在，import 带 try/except 兜底）
- 无新依赖（不引入 httpx——对齐 iwencai 统一用 requests 同步）

## 验收标准

1. `skills/_shared/eastmoney_client.py` 存在，含 `EastmoneyClient` 类 + `get_client()` 单例
2. 14 个公开方法全部实现，覆盖 15 个 skill
3. `tests/scripts/test_eastmoney_client.py` 全过，无真实网络流量
4. 现有 `pytest tests/scripts/` 无回归（特别是 test_iwencai_client/test_http_helpers/test_margin_trading）
5. `python -c "from eastmoney_client import get_client; c=get_client(); print(c.available, c.supported_skills)"` 未配 key 时输出 `False {...}`，无异常
6. 不复刻硬编码默认 key（grep `em_1zye6VUn` 在项目内无新增命中）
