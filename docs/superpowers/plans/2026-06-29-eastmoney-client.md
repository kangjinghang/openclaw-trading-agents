# EastmoneyClient 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `skills/_shared/eastmoney_client.py`，封装东财官方 mx-skills 全量 15 个 skill，作为纯新增可选增强层（未配 `EM_API_KEY` 自动降级，零行为变化），对齐 `iwencai_client.py` 模式。

**Architecture:** 一个 `EastmoneyClient` 类 + `get_client()` 单例，按东财 3 类后端（MCP 工具网关 / 投顾助手 / 报告生成）分 3 个分层请求内核 `_post_mcp`/`_post_advisor`/`_post_report`，共享 auth/重试/401 短路/`record_call` 骨架。15 个 skill → 14 个公开方法（`generate_report` 合并 4 个同构报告）。纯数据层，方法默认不落盘；报告类支持可选 `output_dir` 落盘附件。

**Tech Stack:** Python 3.11+, requests（同步，对齐 iwencai，不引入 httpx）, http_helpers.record_call（带 try/except 兜底）。pytest（mock 网络）。

**Spec:** `docs/superpowers/specs/2026-06-29-eastmoney-client-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `skills/_shared/eastmoney_client.py` | `EastmoneyClient` 类 + `get_client()` 单例；3 族请求内核 + 14 方法 | 新建 |
| `tests/scripts/test_eastmoney_client.py` | 单元测试，全 mock 网络 | 新建 |

**不碰**：`http_helpers.py`、`iwencai_client.py`、7 个 data script、任何 TypeScript 文件、现有测试。

---

## Task 1: 骨架 + 配置 + 单例 + 未配 key 降级

**Files:**
- Create: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试 — 未配 key 时 available=False 且方法返回空**

```python
# tests/scripts/test_eastmoney_client.py
"""EastmoneyClient 单元测试 — 全 mock 网络，无真实流量。

import 路径照搬 test_iwencai_client.py 的模式：sys.path.insert _shared 目录。
"""
import sys
from pathlib import Path
from unittest import mock

import pytest

shared_dir = Path(__file__).parent.parent.parent / "skills" / "_shared"
sys.path.insert(0, str(shared_dir))


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.delenv("EM_API_KEY", raising=False)
    monkeypatch.delenv("EM_BASE_URL", raising=False)


def test_unconfigured_key_marks_unavailable(no_key):
    import eastmoney_client
    eastmoney_client._client = None  # 重置单例，避免上一个测试的 available 状态泄漏
    from eastmoney_client import EastmoneyClient
    c = EastmoneyClient()
    assert c.available is False


def test_unconfigured_get_client_singleton(no_key):
    import eastmoney_client
    eastmoney_client._client = None
    c = eastmoney_client.get_client()
    assert c.available is False
    # 单例：再次获取是同一对象
    assert eastmoney_client.get_client() is c
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eastmoney_client'`

- [ ] **Step 3: 写最小实现 — 骨架 + 配置 + 单例**

```python
# skills/_shared/eastmoney_client.py
"""东方财富官方 mx-skills 客户端 — 15 个官方 Skill 统一封装。

三类后端：
  族 A: /proxy/b/mcp/tool/*                       — 结构化表格（4 skill）
  族 B: /proxy/app-robo-advisor-api/assistant/*   — Markdown 文本（6 skill）
  族 C: /proxy/app-robo-advisor-api/assistant/write/* — 报告 + base64 附件（5 skill）

设计原则（对齐 iwencai_client.py）：
  1. 可选增强——EM_API_KEY 未配置时 available=False，所有方法返回空/None，
     调用方优雅降级，零行为变化。
  2. 可观测性——每个请求走 http_helpers.record_call。
  3. 不复刻官方硬编码默认 key。
"""

import os
import time

import requests

try:
    from http_helpers import record_call
except Exception:
    def record_call(stage, success, error=None, duration_ms=None,
                    url=None, status_code=None, response_size=None,
                    response_snippet=None):
        pass


# ── 常量 ───────────────────────────────────────────────────────────────────
_DEFAULT_BASE_URL = "https://ai-saas.eastmoney.com"
_DEFAULT_TIMEOUT = 30
_DEFAULT_REPORT_TIMEOUT = 1200

# 实体识别 typeCodes（来自 mx-finance-data get_data.py）
_ENTITY_TYPE_CODES = (
    "002,006005,006006,006007,006001,006002,006009,006010,006011,006012,"
    "005101,005201,005202,005203,005204,016,001001,001002,003007,003005,"
    "003002,003003,003008,003006,003004,003001,003200,003100,007,008,004,"
    "010,003300,003400,003500,003600,003700"
)

# 业绩点评支持的 classCode（沪深京港美）
_EARNINGS_SUPPORTED_CLASS_CODES = {"002001", "002003", "002004"}

# 4 个同构报告的 kind 映射
_REPORT_KINDS = {
    "industry":         {"path": "write/industry/research", "slug": "industry_research_report"},
    "tracking":         {"path": "write/tracking/report",   "slug": "industry_stock_tracker"},
    "initial_coverage": {"path": "write/initial-coverage",  "slug": "initiation_of_coverage_or_deep_dive"},
    "thematic":         {"path": "write/thematic/research", "slug": "topic_research_report"},
}


class EastmoneyClient:
    """东方财富官方 mx-skills 客户端。

    构造时从环境变量读取配置：
        EM_API_KEY  — 必填，未设置则 available=False
        EM_BASE_URL — 可选，默认 https://ai-saas.eastmoney.com
    """

    def __init__(self, api_key=None, base_url=None, timeout=_DEFAULT_TIMEOUT):
        self.api_key = (api_key or os.environ.get("EM_API_KEY", "")).strip()
        self.base_url = (base_url or os.environ.get("EM_BASE_URL")
                         or _DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.available = bool(self.api_key)


# ── 进程级单例 ────────────────────────────────────────────────────────────
_client = None


def get_client():
    """返回进程级 EastmoneyClient 单例。"""
    global _client
    if _client is None:
        _client = EastmoneyClient()
    return _client
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): EastmoneyClient 骨架 + 配置 + 单例 + 未配 key 降级"
```

---

## Task 2: 3 族统一请求内核（含 401 短路 / 重试 / record_call）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`（EastmoneyClient 类内）
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试 — 401 短路 + 5xx 重试 + 正常返回**

在 `test_eastmoney_client.py` 追加（注意所有测试都先重置单例）：

```python
@pytest.fixture
def with_key(monkeypatch):
    monkeypatch.setenv("EM_API_KEY", "test_key_123")
    import eastmoney_client
    eastmoney_client._client = None


def _ok_payload(data):
    """构造 200 成功响应 mock。"""
    r = mock.Mock()
    r.status_code = 200
    r.content = b'{"data": "x"}'
    r.json.return_value = data
    return r


def _status_payload(code):
    r = mock.Mock()
    r.status_code = code
    r.content = b'{"err": 1}'
    return r


def test_post_mcp_success(with_key):
    from eastmoney_client import get_client
    c = get_client()
    expected = {"code": 0, "data": {"searchDataResultDTO": {"dataTableDTOList": []}}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(expected)) as mp:
        out = c._post_mcp({"query": "茅台"}, "searchData", "em/search_data")
    assert out == expected
    assert mp.call_count == 1
    # 验证 url 与 header
    args, kwargs = mp.call_args
    assert "/proxy/b/mcp/tool/searchData" in args[0]
    assert kwargs["headers"]["em_api_key"] == "test_key_123"


def test_post_mcp_401_short_circuits(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_status_payload(401)) as mp:
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}
        # 第二次：available 已 False，不应再请求
        assert c._post_mcp({"query": "x"}, "searchData", "em/test2") == {}
    assert mp.call_count == 1


def test_post_mcp_5xx_retried_once(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_status_payload(500)) as mp, \
         mock.patch("eastmoney_client.time.sleep"):
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}
    assert mp.call_count == 2  # 重试 1 次
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -v`
Expected: FAIL — `_post_mcp` 不存在（AttributeError）

- [ ] **Step 3: 实现 3 族请求内核**

在 `EastmoneyClient` 类内 `__init__` 之后追加（所有 _post_* 共享一个私有 `_request`，对齐 iwencai `_post` 骨架）：

```python
    def _trace_id(self):
        import secrets
        return secrets.token_hex(32)

    def _headers(self, base_info=False):
        """组装请求头。base_info=True 时加 em_base_info（业绩点评需要）。"""
        h = {
            "Content-Type": "application/json",
            "em_api_key": self.api_key,
            "X-Claw-Trace-Id": self._trace_id(),
        }
        if base_info:
            import json as _json
            h["em_base_info"] = _json.dumps({"productType": "mx"}, ensure_ascii=False, separators=(",", ":"))
        return h

    def _request(self, body, path, stage, timeout=None, base_info=False, method="POST"):
        """统一 HTTP 请求内核：认证 + 重试 + 401 短路 + record_call。

        返回原始 payload dict（失败/未配 key 返回 {}）。
        """
        if not self.available:
            return {}

        url = self.base_url + path
        headers = self._headers(base_info=base_info)
        to = timeout if timeout is not None else self.timeout
        start = time.monotonic()
        last_error = last_status = last_size = None

        for attempt in range(2):
            try:
                resp = requests.post(url, json=body, headers=headers, timeout=to)
                last_status = resp.status_code
                last_size = len(resp.content)
                if resp.status_code in (401, 403):
                    last_error = f"auth failed: HTTP {resp.status_code}"
                    self.available = False
                    break
                if resp.status_code != 200:
                    last_error = f"http {resp.status_code}"
                    if attempt == 0:
                        time.sleep(0.5)
                        continue
                    break
                payload = resp.json()
                record_call(stage, success=True,
                            duration_ms=(time.monotonic() - start) * 1000,
                            url=url, status_code=resp.status_code,
                            response_size=len(resp.content))
                return payload if isinstance(payload, dict) else {}
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                last_error = f"{type(e).__name__}: {e}"
                last_status = None
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                break
            except Exception as e:
                last_error = f"{type(e).__name__}: {e}"
                break

        record_call(stage, success=False, error=last_error,
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=url, status_code=last_status, response_size=last_size)
        return {}

    # ── 族 A：MCP 工具网关 ──────────────────────────────────────────────
    def _post_mcp(self, body, endpoint, stage):
        """族 A：/proxy/b/mcp/tool/<endpoint>，结构化表格类。"""
        return self._request(body, f"/proxy/b/mcp/tool/{endpoint}", stage)

    # ── 族 B：投顾助手 API ──────────────────────────────────────────────
    def _post_advisor(self, body, endpoint, stage, timeout=None):
        """族 B：/proxy/app-robo-advisor-api/assistant/<endpoint>，Markdown 类。"""
        return self._request(body, f"/proxy/app-robo-advisor-api/assistant/{endpoint}",
                             stage, timeout=timeout)

    # ── 族 C：报告生成 API ──────────────────────────────────────────────
    def _post_report(self, body, endpoint, stage, timeout=_DEFAULT_REPORT_TIMEOUT,
                     base_info=False):
        """族 C：/proxy/app-robo-advisor-api/assistant/write/<endpoint>，1200s + 附件。"""
        return self._request(body, f"/proxy/app-robo-advisor-api/assistant/write/{endpoint}",
                             stage, timeout=timeout, base_info=base_info)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): 3 族统一请求内核（401 短路/重试/record_call）"
```

---

## Task 3: 族 A — search_news（mx-finance-search，最简）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

追加：

```python
def test_search_news_extracts_text(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": {"llmSearchResponse": "茅台三季度营收同比增长..."}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.search_news("茅台")
    assert out == "茅台三季度营收同比增长..."
    _, kwargs = mp.call_args
    body = kwargs["json"]
    assert body["query"] == "茅台"
    assert "callId" in body["toolContext"]
    assert "userId" in body["toolContext"]["userInfo"]  # 补上官方缺的 userId
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_search_news_extracts_text -v`
Expected: FAIL — `search_news` 不存在

- [ ] **Step 3: 实现 search_news + 文本提取辅助**

在类内追加：

```python
    @staticmethod
    def _extract_text_content(payload):
        """从 searchNews 响应递归剥 data/result 包裹，取首个文本字段。

        优先级：llmSearchResponse > searchResponse > content > answer > summary。
        list/dict 转 json.dumps，都没有则整体 json.dumps 兜底。
        """
        import json as _json
        if not isinstance(payload, dict):
            return ""
        node = payload
        # 剥一层 data/result
        for wrap in ("data", "result"):
            inner = node.get(wrap) if isinstance(node, dict) else None
            if isinstance(inner, dict):
                node = inner
        for key in ("llmSearchResponse", "searchResponse", "content", "answer", "summary"):
            v = node.get(key) if isinstance(node, dict) else None
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, (list, dict)) and v:
                return _json.dumps(v, ensure_ascii=False, indent=2)
        return _json.dumps(payload, ensure_ascii=False, indent=2)

    def search_news(self, query):
        """金融资讯搜索（mx-finance-search）。返回文本字符串。"""
        import uuid as _uuid
        body = {
            "query": query,
            "toolContext": {
                "callId": f"call_{_uuid.uuid4().hex[:8]}",
                "userInfo": {"userId": f"user_{_uuid.uuid4().hex[:8]}"},
            },
        }
        payload = self._post_mcp(body, "searchNews", "em/search_news")
        return self._extract_text_content(payload) if payload else ""
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_search_news_extracts_text -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): search_news（mx-finance-search，补官方缺失的 userId）"
```

---

## Task 4: 族 A — search_macro_data（mx-macro-data，频率分组）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_search_macro_data_parses_frequency(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {
        "data": {
            "dataTables": [
                {
                    "table": {"headName": ["指标", "2023年"], "EMM0001": ["GDP", "5.2%"]},
                    "nameMap": {"EMM0001": "国内生产总值"},
                    "entityName": "GDP（年）",
                }
            ]
        }
    }
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)):
        out = c.search_macro_data("中国 GDP 增速")
    assert out["tables"][0]["frequency"] == "yearly"
    assert out["tables"][0]["indicator_name"] == "国内生产总值"
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_search_macro_data_parses_frequency -v`
Expected: FAIL

- [ ] **Step 3: 实现 search_macro_data**

```python
    @staticmethod
    def _extract_frequency(entity_name):
        """从 entityName 括号内容映射频率：年→yearly, 季→quarterly, 月→monthly, 周→weekly, 日→daily。"""
        import re
        m = re.search(r"[（(]([^)）]*)[)）]", entity_name or "")
        if not m:
            return "unknown"
        token = m.group(1)
        for kw, freq in (("年", "yearly"), ("季", "quarterly"),
                         ("月", "monthly"), ("周", "weekly"), ("日", "daily")):
            if kw in token:
                return freq
        return "unknown"

    def search_macro_data(self, query):
        """宏观经济数据查询（mx-macro-data）。返回 {tables, query}。

        tables 每项含 frequency/indicator_name/indicator_code/head_name/rows。
        """
        import uuid as _uuid
        body = {
            "query": query,
            "toolContext": {
                "callId": f"call_{_uuid.uuid4().hex[:8]}",
                "userInfo": {"userId": f"user_{_uuid.uuid4().hex[:8]}"},
            },
        }
        payload = self._post_mcp(body, "searchMacroData", "em/search_macro_data")
        if not payload:
            return {"tables": [], "query": query}
        data = payload.get("data") if isinstance(payload, dict) else None
        raw_tables = data.get("dataTables") if isinstance(data, dict) else None
        if not isinstance(raw_tables, list):
            return {"tables": [], "query": query}
        tables = []
        for item in raw_tables:
            if not isinstance(item, dict):
                continue
            tbl = item.get("table") or {}
            name_map = item.get("nameMap") or {}
            entity_name = item.get("entityName") or ""
            head_name = tbl.get("headName") or []
            rows = []
            for code, vals in tbl.items():
                if code == "headName" or not isinstance(vals, list):
                    continue
                row = dict(zip([str(h) for h in head_name], vals))
                row["indicator_code"] = code
                row["indicator_name"] = name_map.get(code, code)
                rows.append(row)
            tables.append({
                "frequency": self._extract_frequency(entity_name),
                "indicator_name": entity_name,
                "head_name": head_name,
                "rows": rows,
            })
        return {"tables": tables, "query": query}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_search_macro_data_parses_frequency -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): search_macro_data（mx-macro-data，频率分组解析）"
```

---

## Task 5: 族 A — select_security（mx-stocks-screener）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_select_security_passes_select_type(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": {"allResults": {"result": {"dataList": [["600519", "贵州茅台"]], "columns": [{"field": "code"}, {"field": "name"}]}}, "securityCount": 1}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.select_security("股价大于500元的股票", "A股")
    assert out["count"] == 1
    assert out["rows"][0]["name"] == "贵州茅台"
    _, kwargs = mp.call_args
    assert kwargs["json"]["selectType"] == "A股"
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_select_security_passes_select_type -v`
Expected: FAIL

- [ ] **Step 3: 实现 select_security**

```python
    def select_security(self, query, select_type):
        """选股/选板块/选基金（mx-stocks-screener）。

        select_type: A股/港股/美股/基金/ETF/可转债/板块。
        返回 {rows, columns, count, query}。
        """
        import uuid as _uuid
        body = {
            "query": query,
            "selectType": select_type,
            "toolContext": {
                "callId": f"call_{_uuid.uuid4().hex[:8]}",
                "userInfo": {"userId": f"user_{_uuid.uuid4().hex[:8]}"},
            },
        }
        payload = self._post_mcp(body, "selectSecurity", "em/select_security")
        if not payload:
            return {"rows": [], "columns": [], "count": 0, "query": query}
        data = payload.get("data") if isinstance(payload, dict) else {}
        result = (data.get("allResults") or {}).get("result") or {} if isinstance(data, dict) else {}
        data_list = result.get("dataList") or []
        columns = result.get("columns") or []
        col_names = [c.get("name") or c.get("field") for c in columns if isinstance(c, dict)]
        rows = [dict(zip(col_names, row)) for row in data_list]
        count = data.get("securityCount", len(rows)) if isinstance(data, dict) else len(rows)
        return {"rows": rows, "columns": col_names, "count": count, "query": query}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_select_security_passes_select_type -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): select_security（mx-stocks-screener）"
```

---

## Task 6: 族 A — recognize_entities + search_data（mx-finance-data，最复杂）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试 — 实体识别 + 直接查数（≤5 实体）**

```python
def test_search_data_direct_query(with_key):
    from eastmoney_client import get_client
    c = get_client()
    # 实体识别返回 1 个实体（≤5，走直接查数）
    entity_resp = {"data": {"entityList": [{"entityId": "E1", "secuCode": "600519", "marketChar": "SH", "fullName": "贵州茅台"}]}}
    data_resp = {"code": 0, "data": {"searchDataResultDTO": {"dataTableDTOList": [{"title": "茅台财报", "table": {"headName": ["指标"], "PE": ["30"]}}]}}}
    responses = [_ok_payload(entity_resp), _ok_payload(data_resp)]
    with mock.patch("eastmoney_client.requests.post", side_effect=responses) as mp:
        out = c.search_data("贵州茅台 财务数据")
    assert out["tables"][0]["title"] == "茅台财报"
    assert out["use_entity_tags"] is False
    assert mp.call_count == 2  # 实体识别 + 查数


def test_search_data_multi_entity_uses_tool_pre_task(with_key):
    from eastmoney_client import get_client
    c = get_client()
    # 6 个实体（>5，走多实体）
    entities = [{"entityId": f"E{i}", "secuCode": f"60000{i}", "marketChar": "SH"} for i in range(6)]
    entity_resp = {"data": {"entityList": entities}}
    data_resp = {"code": 0, "data": {"searchDataResultDTO": {"dataTableDTOList": []}}}
    responses = [_ok_payload(entity_resp), _ok_payload(data_resp)]
    with mock.patch("eastmoney_client.requests.post", side_effect=responses) as mp:
        out = c.search_data("白酒板块 营收 净利", indicators="营收 净利")
    assert out["use_entity_tags"] is True
    assert out["search_query"] == "选定实体的营收 净利"
    # 第二次请求（查数）带 toolPreTaskResultList
    _, kwargs = mp.call_args_list[1]
    tctx = kwargs["json"]["toolContext"]
    assert "toolPreTaskResultList" in tctx
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k search_data -v`
Expected: FAIL

- [ ] **Step 3: 实现 recognize_entities + search_data**

```python
    _ENTITY_TAG_FIELDS = ("entityId", "secuCode", "marketChar", "fullName", "market", "classCode")
    _DIRECT_QUERY_ENTITY_LIMIT = 5

    @staticmethod
    def _flatten_value(v):
        import json as _json
        if v is None:
            return ""
        if isinstance(v, (dict, list)):
            return _json.dumps(v, ensure_ascii=False)
        return str(v)

    @classmethod
    def _normalize_entity_tag(cls, raw):
        """从实体识别结果提取完整字段（仅传 entityId 只返回首个实体数据）。"""
        entity_id = cls._flatten_value(raw.get("entityId")).strip() if isinstance(raw, dict) else ""
        if not entity_id:
            raise ValueError("missing entityId")
        tag = {"entityId": entity_id}
        for field in cls._ENTITY_TAG_FIELDS:
            if field == "entityId":
                continue
            val = raw.get(field) if isinstance(raw, dict) else None
            if val not in (None, ""):
                tag[field] = cls._flatten_value(val)
        return tag

    @classmethod
    def _extract_entity_tags(cls, api_result):
        """从实体识别响应提取 tag 列表。entityMetricList 取每组首项，否则用 entityList。"""
        if not isinstance(api_result, dict):
            return []
        data = api_result.get("data")
        if not isinstance(data, dict):
            return []
        raw_items = []
        metric = data.get("entityMetricList")
        if isinstance(metric, list):
            for group in metric:
                if isinstance(group, list) and group and isinstance(group[0], dict):
                    raw_items.append(group[0])
        else:
            ent_list = data.get("entityList")
            if isinstance(ent_list, list):
                raw_items = [it for it in ent_list if isinstance(it, dict)]
        tags = []
        for item in raw_items:
            try:
                tags.append(cls._normalize_entity_tag(item))
            except ValueError:
                continue
        return tags

    def recognize_entities(self, query):
        """实体识别（mx-finance-data 前置，/proxy/entity/saas）。返回 tag 列表。"""
        body = {"content": query, "typeCodes": _ENTITY_TYPE_CODES}
        payload = self._request(body, "/proxy/entity/saas", "em/recognize_entities")
        return self._extract_entity_tags(payload) if payload else []

    @staticmethod
    def _extract_data_table_list(api_result):
        """兼容 dataTableDTOList 的 3 级路径。返回 (list, error)。"""
        if not isinstance(api_result, dict):
            return [], "not dict"
        dto = api_result.get("dataTableDTOList")
        if isinstance(dto, list):
            return dto, None
        data = api_result.get("data")
        if isinstance(data, dict):
            sr = data.get("searchDataResultDTO")
            if isinstance(sr, dict):
                dto = sr.get("dataTableDTOList")
                if isinstance(dto, list):
                    return dto, None
            dto = data.get("dataTableDTOList")
            if isinstance(dto, list):
                return dto, None
        return [], "no dataTableDTOList"

    def search_data(self, query, indicators=None):
        """金融数据查询（mx-finance-data）。含实体识别前置 + 多实体分支。

        返回 {tables, use_entity_tags, recognized_entity_count, search_query, query}。
        """
        import uuid as _uuid
        tags = self.recognize_entities(query)
        result = {"tables": [], "use_entity_tags": False, "recognized_entity_count": len(tags),
                  "search_query": query, "query": query}
        if not self.available:
            return result
        entity_tags = None
        search_query = query
        if len(tags) > self._DIRECT_QUERY_ENTITY_LIMIT:
            if not (indicators or "").strip():
                result["error"] = "多实体查数（>5）缺少 indicators"
                return result
            entity_tags = tags
            result["use_entity_tags"] = True
            search_query = f"选定实体的{indicators.strip()}"
            result["search_query"] = search_query
            result["indicators"] = indicators.strip()

        tool_context = {
            "callId": f"call_{_uuid.uuid4().hex[:8]}",
            "userInfo": {"userId": f"user_{_uuid.uuid4().hex[:8]}"},
        }
        if entity_tags:
            tool_context["toolPreTaskResultList"] = [{
                "taskName": "股票基金筛选",
                "entityTagListMap": {"1": entity_tags},
            }]
        body = {"query": search_query, "toolContext": tool_context}
        payload = self._post_mcp(body, "searchData", "em/search_data")
        if not payload:
            return result
        dto_list, _ = self._extract_data_table_list(payload)
        tables = []
        for block in dto_list:
            if not isinstance(block, dict):
                continue
            tables.append({
                "title": block.get("title") or block.get("inputTitle") or block.get("entityName") or "",
                "condition": block.get("condition"),
                "raw": block,
            })
        result["tables"] = tables
        return result
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k search_data -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): search_data + recognize_entities（mx-finance-data，实体识别 + 多实体分支）"
```

---

## Task 7: 族 B — diagnose_stock / diagnose_fund / discover_hotspot（3 个同构诊断）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_diagnose_stock_extracts_display_data(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": {"displayData": "## 贵州茅台诊断报告\n基本面稳健..."}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.diagnose_stock("贵州茅台怎么样？")
    assert "贵州茅台诊断报告" in out
    args, kwargs = mp.call_args
    assert kwargs["json"] == {"question": "贵州茅台怎么样？"}
    # url 是 requests.post 的第一个位置参数
    assert "/stock-analysis" in args[0]


def test_diagnose_fund_and_hotspot_with_key(with_key):
    from eastmoney_client import get_client
    c = get_client()
    # 验证 fund/hotspot 走对应 path（用空 payload 验证不抛异常）
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload({"data": {"displayData": "x"}})):
        assert c.diagnose_fund("华夏成长怎么样") == "x"
        assert c.discover_hotspot("今日热点") == "x"
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k diagnose -v`
Expected: FAIL

- [ ] **Step 3: 实现 3 个诊断方法 + displayData 提取**

```python
    @staticmethod
    def _extract_display_data(payload):
        """提取投顾类返回的 displayData（Markdown）。兜底 content/answer/summary。"""
        if not isinstance(payload, dict):
            return ""
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        for node in (data, payload):
            for key in ("displayData", "content", "answer", "summary"):
                v = node.get(key) if isinstance(node, dict) else None
                if isinstance(v, str) and v.strip():
                    return v.strip()
                if isinstance(v, list) and v:
                    import json as _json
                    return _json.dumps(v, ensure_ascii=False, indent=2)
        return ""

    def _diagnose(self, question, endpoint, stage):
        body = {"question": question}
        payload = self._post_advisor(body, endpoint, stage, timeout=60)
        return self._extract_display_data(payload) if payload else ""

    def diagnose_stock(self, question):
        """个股综合诊断（stock-diagnosis，沪深京 A 股）。返回 Markdown。"""
        return self._diagnose(question, "stock-analysis", "em/diagnose_stock")

    def diagnose_fund(self, question):
        """基金综合诊断（fund-diagnosis）。返回 Markdown。"""
        return self._diagnose(question, "fund-analysis", "em/diagnose_fund")

    def discover_hotspot(self, question):
        """股市热点发现（stock-market-hotspot-discovery）。返回 Markdown。"""
        return self._diagnose(question, "hotspot-discovery", "em/discover_hotspot")
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k diagnose -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): diagnose_stock/fund + discover_hotspot（3 个投顾诊断）"
```

---

## Task 8: 族 B — comparable_company_analysis（特例：60s + question 键 + list 返回）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_comparable_company_returns_list_structure(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": [
        {"type": "header", "company": "贵州茅台"},
        {"type": "section_finance", "rows": [["营收", "100亿"]]},
    ]}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.comparable_company_analysis("贵州茅台 同业对比")
    assert out["success"] is True
    assert len(out["data"]) == 2
    # path 不带 write/，60s timeout
    assert "/comparable-company-analysis" in str(mp.call_args)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_comparable_company_returns_list_structure -v`
Expected: FAIL

- [ ] **Step 3: 实现 comparable_company_analysis**

```python
    def comparable_company_analysis(self, question):
        """可比公司分析（comparable-company-analysis）。特例：question 键、60s、返回 list。

        注意 path 不在 write/ 下。
        返回 {success, data(list), query}。
        """
        body = {"question": question}
        payload = self._post_advisor(body, "comparable-company-analysis",
                                     "em/comparable_company", timeout=60)
        if not payload:
            return {"success": False, "data": [], "query": question}
        code = payload.get("code")
        status = payload.get("status")
        ok = code in (None, 0, 200, "0", "200") and status in (None, 0, 200, "0", "200")
        data = payload.get("data")
        return {"success": ok and isinstance(data, list), "data": data if isinstance(data, list) else [], "query": question}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py::test_comparable_company_returns_list_structure -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): comparable_company_analysis（特例：60s/question键/list返回）"
```

---

## Task 9: 族 B — ask（mx-financial-assistant，deepThink 语义）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_ask_omits_deepthink_when_false(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": {"displayData": "茅台当前估值...", "refIndexList": [{"refId": 1, "type": "资讯"}]}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.ask("茅台当前估值")
    # deep_think=False 时不应带 deepThink key（对齐官方"省略即关闭"）
    assert "deepThink" not in mp.call_args.kwargs["json"]
    assert "估值" in out["answer"]
    assert out["references"][0]["refId"] == 1


def test_ask_includes_deepthink_when_true(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload({"code": 200, "data": {"displayData": "x"}})) as mp:
        c.ask("茅台", deep_think=True)
    assert mp.call_args.kwargs["json"]["deepThink"] is True
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k ask -v`
Expected: FAIL

- [ ] **Step 3: 实现 ask**

```python
    def ask(self, question, deep_think=False):
        """金融问答助手（mx-financial-assistant）。

        deep_think=True 时写 deepThink:True（对齐官方"省略即关闭"，False 时不下发该 key）。
        返回 {answer, references, question}。
        """
        body = {"question": question}
        if deep_think:
            body["deepThink"] = True
        # 问答类 timeout 较长（深度思考），用 600s
        payload = self._post_advisor(body, "ask", "em/ask", timeout=600)
        if not payload:
            return {"answer": "", "references": [], "question": question}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        answer = data.get("displayData") or ""
        refs = data.get("refIndexList") or []
        return {"answer": answer, "references": refs if isinstance(refs, list) else [], "question": question}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k ask -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): ask（mx-financial-assistant，deepThink 省略即关闭）"
```

---

## Task 10: 族 B — search_kb（mx-personal-kb-search，含有效性过滤）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_search_kb_returns_chunks(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": {"chunks": [{"title": "宁德时代研报", "text": "营收增长...", "fileName": "研报.md"}]}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)):
        out = c.search_kb("宁德时代")
    assert out["content"]  # 有内容
    assert out["valid"] is True


def test_search_kb_filters_status_message(with_key):
    """'您暂无知识库权限'这类纯状态文案应标 valid=False。"""
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": "您暂无知识库权限"}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)):
        out = c.search_kb("x")
    assert out["valid"] is False
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k search_kb -v`
Expected: FAIL

- [ ] **Step 3: 实现 search_kb**

```python
    @staticmethod
    def _has_valid_kb_content(raw):
        """判断是否真正检索到内容（非权限/空库/无命中状态文案）。

        只有 chunks/items/results/list 或 displayData 才算有效。
        """
        if not isinstance(raw, dict):
            return False
        data = raw.get("data")
        if isinstance(data, str):
            return False  # 纯状态字符串
        if isinstance(data, dict):
            for key in ("chunks", "items", "results", "list"):
                if isinstance(data.get(key), list) and data[key]:
                    return True
            if isinstance(data.get("displayData"), str) and data["displayData"].strip():
                return True
        return False

    def search_kb(self, query):
        """私域知识库检索（mx-personal-kb-search）。返回 {content, valid, query}。"""
        body = {"query": query}
        payload = self._post_advisor(body, "private-domain-search", "em/search_kb", timeout=60)
        if not payload:
            return {"content": "", "valid": False, "query": query}
        valid = self._has_valid_kb_content(payload)
        # 复用文本提取逻辑取内容
        content = self._extract_text_content(payload) if payload else ""
        return {"content": content, "valid": valid, "query": query}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k search_kb -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): search_kb（mx-personal-kb-search，有效性过滤）"
```

---

## Task 11: 族 C — generate_report（4 个同构报告统一参数化）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_generate_report_returns_title_content_and_attachments(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": {"title": "半导体行业研究报告", "content": "## 行业概述\n...", "shareUrl": "http://x", "pdfBase64": "JVBERi0=", "wordBase64": "UEsDBA=="}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.generate_report("industry", "半导体行业")
    assert out["title"] == "半导体行业研究报告"
    assert out["shareUrl"] == "http://x"
    assert out["attachments"]["pdf"] == "JVBERi0="
    assert out["attachments"]["word"] == "UEsDBA=="
    # 验证 path 是 write/industry/research（url 是 requests.post 第一个位置参数）
    assert "write/industry/research" in mp.call_args.args[0]


def test_generate_report_unknown_kind_raises(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with pytest.raises(ValueError):
        c.generate_report("nonexistent", "x")
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k generate_report -v`
Expected: FAIL

- [ ] **Step 3: 实现 generate_report + 附件落盘辅助**

```python
    @staticmethod
    def _decode_and_save(base64_str, output_dir, filename):
        """base64 解码并落盘。返回路径或 None。"""
        import base64 as _b64
        from pathlib import Path
        if not (isinstance(base64_str, str) and base64_str.strip()):
            return None
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        path = out / filename
        path.write_bytes(_b64.b64decode(base64_str))
        return str(path)

    def generate_report(self, kind, query, output_dir=None):
        """4 个同构报告统一入口（industry/tracking/initial_coverage/thematic）。

        返回 {title, content, shareUrl, attachments, saved, query}。
        attachments: {pdf: base64, word: base64}（原始，不落盘则 saved 为空 dict）。
        """
        if kind not in _REPORT_KINDS:
            raise ValueError(f"Unknown report kind: {kind}. Supported: {list(_REPORT_KINDS.keys())}")
        info = _REPORT_KINDS[kind]
        body = {"query": query}
        payload = self._post_report(body, info["path"], f"em/report_{kind}")
        if not payload:
            return {"title": "", "content": "", "shareUrl": None,
                    "attachments": {}, "saved": {}, "query": query}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        pdf_b64 = data.get("pdfBase64")
        word_b64 = data.get("wordBase64")
        attachments = {"pdf": pdf_b64, "word": word_b64}
        saved = {}
        if output_dir:
            import re
            safe_title = re.sub(r'[\\/:*?"<>|]', "_", data.get("title") or info["slug"])
            if pdf_b64:
                saved["pdf"] = self._decode_and_save(pdf_b64, output_dir, f"{safe_title}.pdf")
            if word_b64:
                saved["word"] = self._decode_and_save(word_b64, output_dir, f"{safe_title}.docx")
        return {
            "title": data.get("title") or "",
            "content": data.get("content") or "",
            "shareUrl": data.get("shareUrl"),
            "attachments": attachments,
            "saved": saved,
            "query": query,
        }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k generate_report -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): generate_report（4 个同构报告统一参数化 + 可选落盘）"
```

---

## Task 12: 族 C — earnings_review（3 步协议，最复杂）

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试 — 3 步全成功**

```python
def test_earnings_review_three_steps_success(with_key):
    from eastmoney_client import get_client
    c = get_client()
    # step1 实体识别（dialogTagsV2）
    s1 = {"data": {"entityMetricList": [[{"classCode": "002001", "secuCode": "600519", "marketChar": "SH", "shortName": "贵州茅台"}]]}}
    # step2 报告期列表
    s2 = {"code": 0, "data": {"reportDateList": ["2023-12-31", "2023-09-30"]}}
    # step3 点评
    s3 = {"code": 0, "data": {"title": "茅台2023年报点评", "content": "业绩超预期...", "shareUrl": "http://x", "pdfBase64": "JVBERi0="}}
    responses = [_ok_payload(s1), _ok_payload(s2), _ok_payload(s3)]
    with mock.patch("eastmoney_client.requests.post", side_effect=responses) as mp:
        out = c.earnings_review("贵州茅台", report_date="2023-12-31")
    assert out["title"] == "茅台2023年报点评"
    assert out["em_code"] == "600519.SH"
    assert mp.call_count == 3
    # step3 带 em_base_info
    _, kwargs3 = mp.call_args_list[2]
    assert "em_base_info" in kwargs3["headers"]


def test_earnings_review_step1_fail_returns_empty(with_key):
    """实体识别失败（classCode 不支持）整体返回空。"""
    from eastmoney_client import get_client
    c = get_client()
    s1 = {"data": {"entityMetricList": [[{"classCode": "999", "secuCode": "xxx"}]]}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(s1)) as mp:
        out = c.earnings_review("未知实体")
    assert out.get("title", "") == ""
    assert mp.call_count == 1  # step1 失败即停
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k earnings_review -v`
Expected: FAIL

- [ ] **Step 3: 实现 earnings_review（3 步协议）**

```python
    def earnings_review(self, query, report_date=None, output_dir=None):
        """业绩点评（stock-earnings-review）。3 步协议 + em_base_info。

        step1: /proxy/entity/dialogTagsV2 实体识别 → em_code
        step2: write/choice/reportList 报告期列表 → 选定 reportDate
        step3: write/performance/comment 生成点评（带 em_base_info，1200s）

        任一步失败整体返回 {}。
        """
        if not self.available:
            return {}
        # step1 实体识别
        s1 = self._request({"content": query}, "/proxy/entity/dialogTagsV2", "em/earnings_entity")
        ent = self._pick_review_entity(s1)
        if not ent:
            return {"error": "实体识别失败或不支持（需沪深京港美）"}
        em_code = ent["em_code"]
        # step2 报告期列表
        s2 = self._post_report({"emCode": em_code}, "choice/reportList", "em/earnings_period")
        period = self._choose_report_period(s2, report_date)
        if not period:
            return {"error": "未找到报告期", "em_code": em_code}
        # step3 点评（带 em_base_info）
        s3 = self._post_report({"query": em_code, "reportDate": period},
                               "performance/comment", "em/earnings_review",
                               base_info=True)
        if not s3:
            return {"error": "点评生成失败", "em_code": em_code, "reportDate": period}
        data = s3.get("data") if isinstance(s3.get("data"), dict) else {}
        pdf_b64 = data.get("pdfBase64")
        word_b64 = data.get("wordBase64")
        saved = {}
        if output_dir:
            if pdf_b64:
                saved["pdf"] = self._decode_and_save(pdf_b64, output_dir, "review.pdf")
            if word_b64:
                saved["word"] = self._decode_and_save(word_b64, output_dir, "review.doc")
        return {
            "title": data.get("title") or "",
            "content": data.get("content") or "",
            "shareUrl": data.get("shareUrl"),
            "em_code": em_code,
            "reportDate": period,
            "attachments": {"pdf": pdf_b64, "word": word_b64},
            "saved": saved,
            "query": query,
        }

    @staticmethod
    def _pick_review_entity(api_result):
        """从 dialogTagsV2 响应提取首个支持的实体（classCode ∈ 沪深京港美）。"""
        if not isinstance(api_result, dict):
            return None
        data = api_result.get("data")
        if not isinstance(data, dict):
            return None
        cand = None
        metric = data.get("entityMetricList")
        if isinstance(metric, list) and metric and isinstance(metric[0], list) and metric[0]:
            cand = metric[0][0] if isinstance(metric[0][0], dict) else None
        if not cand:
            ent_list = data.get("entityList")
            cand = ent_list[0] if isinstance(ent_list, list) and ent_list and isinstance(ent_list[0], dict) else None
        if not isinstance(cand, dict):
            return None
        class_code = str(cand.get("classCode") or "")
        if class_code not in _EARNINGS_SUPPORTED_CLASS_CODES:
            return None
        secu_code = str(cand.get("secuCode") or "").strip()
        market_char = str(cand.get("marketChar") or "").strip()
        # 拼 em_code（含 . 则原样，否则补 marketChar 后缀）
        if "." in secu_code:
            em_code = secu_code
        elif market_char:
            em_code = f"{secu_code}.{market_char}" if not market_char.startswith(".") else f"{secu_code}{market_char}"
        else:
            return None
        return {"em_code": em_code, "secu_code": secu_code, "class_code": class_code,
                "secu_name": cand.get("shortName") or ""}

    @staticmethod
    def _choose_report_period(api_result, selected=None):
        """从 reportList 响应选报告期。selected 非空则精确匹配，否则取首个。"""
        if not isinstance(api_result, dict):
            return None
        data = api_result.get("data")
        if not isinstance(data, dict):
            return None
        periods = data.get("reportDateList")
        if not isinstance(periods, list) or not periods:
            return None
        # 元素可能是 str 或 dict
        norm = []
        for p in periods:
            if isinstance(p, str):
                norm.append(p)
            elif isinstance(p, dict):
                norm.append(p.get("reportDate") or p.get("period") or p.get("date") or "")
        norm = [p for p in norm if p]
        if selected:
            for p in norm:
                if p == selected:
                    return p
            return None
        return norm[0] if norm else None
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k earnings_review -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): earnings_review（stock-earnings-review 3 步协议 + em_base_info）"
```

---

## Task 13: supported_skills property + 烟囱测试

**Files:**
- Modify: `skills/_shared/eastmoney_client.py`
- Test: `tests/scripts/test_eastmoney_client.py`

- [ ] **Step 1: 写失败测试**

```python
def test_supported_skills_covers_all_15():
    from eastmoney_client import get_client
    import eastmoney_client
    eastmoney_client._client = None
    c = get_client()
    skills = c.supported_skills
    # 15 个 skill slug（generate_report 合并 4 个，故 list 长度 ≥ 15 个 skill 名）
    expected_slugs = [
        "mx-finance-data", "mx-finance-search", "mx-macro-data", "mx-stocks-screener",
        "stock-diagnosis", "fund-diagnosis", "stock-market-hotspot-discovery",
        "comparable-company-analysis", "mx-financial-assistant", "mx-personal-kb-search",
        "industry-research-report", "industry-stock-tracker",
        "initiation-of-coverage-or-deep-dive", "topic-research-report", "stock-earnings-review",
    ]
    for slug in expected_slugs:
        assert slug in skills, f"missing {slug}"
    assert len(skills) >= 15


def test_smoke_unconfigured_no_exception(no_key):
    """未配 key 时所有方法调用不抛异常，返回空。"""
    import eastmoney_client
    eastmoney_client._client = None
    c = eastmoney_client.get_client()
    assert c.search_news("x") == ""
    assert c.search_data("x")["tables"] == []
    assert c.search_macro_data("x")["tables"] == []
    assert c.select_security("x", "A股")["count"] == 0
    assert c.recognize_entities("x") == []
    assert c.diagnose_stock("x") == ""
    assert c.diagnose_fund("x") == ""
    assert c.discover_hotspot("x") == ""
    assert c.comparable_company_analysis("x")["success"] is False
    assert c.ask("x")["answer"] == ""
    assert c.search_kb("x")["valid"] is False
    assert c.generate_report("industry", "x")["title"] == ""
    assert c.earnings_review("x") == {}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k "supported_skills or smoke" -v`
Expected: FAIL — `supported_skills` 不存在

- [ ] **Step 3: 实现 supported_skills property**

在类内追加：

```python
    @property
    def supported_skills(self):
        """返回所有支持的 skill slug → 中文名映射（15 个 mx-skills）。"""
        return {
            # 族 A：MCP 数据查询
            "mx-finance-data": "全市场金融数据查询",
            "mx-finance-search": "金融资讯搜索",
            "mx-macro-data": "宏观经济数据查询",
            "mx-stocks-screener": "智能选股选板块",
            # 族 B：投顾诊断/问答
            "stock-diagnosis": "沪深京A股综合诊断",
            "fund-diagnosis": "公募基金综合诊断",
            "stock-market-hotspot-discovery": "股市热点发现",
            "comparable-company-analysis": "可比公司分析",
            "mx-financial-assistant": "金融问答助手",
            "mx-personal-kb-search": "妙想私域知识库检索",
            # 族 C：报告生成（generate_report 合并 4 个同构 + earnings_review 1 个）
            "industry-research-report": "行业研究报告",
            "industry-stock-tracker": "行业个股跟踪报告",
            "initiation-of-coverage-or-deep-dive": "首次覆盖/深度研究报告",
            "topic-research-report": "专题研究报告",
            "stock-earnings-review": "上市公司业绩点评",
        }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -k "supported_skills or smoke" -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py
git commit -m "feat(eastmoney): supported_skills property + 未配 key 烟囱测试"
```

---

## Task 14: 全量回归 + 验收检查

**Files:**
- Run only（不改文件）

- [ ] **Step 1: 全量跑 eastmoney 测试**

Run: `cd tests/scripts && python -m pytest test_eastmoney_client.py -v`
Expected: 全部 passed（约 18-20 个用例）

- [ ] **Step 2: 跑现有 Python 测试确认无回归**

Run: `cd tests/scripts && python -m pytest test_iwencai_client.py test_http_helpers.py -v`
Expected: passed（本次未改 http_helpers/iwencai，应全绿）

- [ ] **Step 3: 验证未配 key 烟囱（命令行）**

Run:
```bash
cd skills/_shared && EM_API_KEY="" python -c "from eastmoney_client import get_client; c=get_client(); print('available:', c.available); print('skills:', len(c.supported_skills))"
```
Expected: `available: False` 和 `skills: 15`

- [ ] **Step 4: 验证未引入硬编码默认 key**

Run: `grep -rn "em_1zye6VUn" skills/_shared/eastmoney_client.py tests/scripts/test_eastmoney_client.py`
Expected: 无任何输出（不复刻官方测试 key）

- [ ] **Step 5: 最终提交（若有未提交的收尾改动）**

```bash
git status  # 确认工作区干净或只有预期改动
git add -A && git commit -m "test(eastmoney): 全量回归通过 + 验收检查" --allow-empty || echo "nothing to commit"
```

---

## 验收标准对照（来自 spec）

1. ✅ `skills/_shared/eastmoney_client.py` 存在，含 `EastmoneyClient` 类 + `get_client()` 单例 — Task 1
2. ✅ 14 个公开方法全部实现 — Task 3-12（search_news/search_macro_data/select_security/search_data/recognize_entities/diagnose_stock/diagnose_fund/discover_hotspot/comparable_company_analysis/ask/search_kb/generate_report/earnings_review）+ supported_skills（Task 13）
3. ✅ `tests/scripts/test_eastmoney_client.py` 全过，无真实网络流量 — Task 14 Step 1
4. ✅ 现有 Python 测试无回归 — Task 14 Step 2
5. ✅ 未配 key 烟囱 — Task 14 Step 3
6. ✅ 不复刻硬编码默认 key — Task 14 Step 4

---

## 执行顺序建议

Task 1-2 是骨架和内核（地基），必须先做。Task 3-12 各方法相互独立，可按任意顺序（建议先易后难：search_news → search_macro_data → select_security → search_data → 诊断三连 → comparable → ask → search_kb → generate_report → earnings_review）。Task 13-14 收尾。

每个 Task 都是 TDD 闭环（写测试 → 验证失败 → 实现 → 验证通过 → 提交），适合 subagent 逐个派发。
