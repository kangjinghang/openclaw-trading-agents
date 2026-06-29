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

import json
import os
import re
import secrets
import time
import uuid

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

    def _trace_id(self):
        return secrets.token_hex(32)

    def _headers(self, base_info=False):
        """组装请求头。base_info=True 时加 em_base_info（业绩点评需要）。"""
        h = {
            "Content-Type": "application/json",
            "em_api_key": self.api_key,
            "X-Claw-Trace-Id": self._trace_id(),
        }
        if base_info:
            h["em_base_info"] = json.dumps({"productType": "mx"}, ensure_ascii=False, separators=(",", ":"))
        return h

    def _request(self, body, path, stage, timeout=None, base_info=False):
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

    @staticmethod
    def _extract_text_content(payload):
        """从 searchNews 响应递归剥 data/result 包裹，取首个文本字段。

        优先级：llmSearchResponse > searchResponse > content > answer > summary。
        list/dict 转 json.dumps，都没有则整体 json.dumps 兜底。
        """
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
                return json.dumps(v, ensure_ascii=False, indent=2)
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def search_news(self, query):
        """金融资讯搜索（mx-finance-search）。返回文本字符串。"""
        body = {
            "query": query,
            "toolContext": {
                "callId": f"call_{uuid.uuid4().hex[:8]}",
                "userInfo": {"userId": f"user_{uuid.uuid4().hex[:8]}"},
            },
        }
        payload = self._post_mcp(body, "searchNews", "em/search_news")
        return self._extract_text_content(payload) if payload else ""

    @staticmethod
    def _extract_frequency(entity_name):
        """从 entityName 括号内容映射频率：年→yearly, 季→quarterly, 月→monthly, 周→weekly, 日→daily。"""
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
        body = {
            "query": query,
            "toolContext": {
                "callId": f"call_{uuid.uuid4().hex[:8]}",
                "userInfo": {"userId": f"user_{uuid.uuid4().hex[:8]}"},
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
                # 表级标签：取 nameMap 首个值（best-effort，单指标场景准确；多指标时各行已有自己的 indicator_name）
                "indicator_name": next(iter(name_map.values()), entity_name),
                "head_name": head_name,
                "rows": rows,
            })
        return {"tables": tables, "query": query}

    def select_security(self, query, select_type):
        """选股/选板块/选基金（mx-stocks-screener）。

        select_type: A股/港股/美股/基金/ETF/可转债/板块。
        返回 {rows, columns, count, query}。
        """
        body = {
            "query": query,
            "selectType": select_type,
            "toolContext": {
                "callId": f"call_{uuid.uuid4().hex[:8]}",
                "userInfo": {"userId": f"user_{uuid.uuid4().hex[:8]}"},
            },
        }
        payload = self._post_mcp(body, "selectSecurity", "em/select_security")
        if not payload:
            return {"rows": [], "columns": [], "count": 0, "query": query}
        if not isinstance(payload, dict):
            return {"rows": [], "columns": [], "count": 0, "query": query}
        data = payload.get("data")
        if not isinstance(data, dict):
            return {"rows": [], "columns": [], "count": 0, "query": query}
        result = (data.get("allResults") or {}).get("result") or {}
        data_list = result.get("dataList") or []
        columns = result.get("columns") or []
        col_names = [c.get("name") or c.get("field") for c in columns if isinstance(c, dict)]
        rows = [dict(zip(col_names, row)) for row in data_list]
        count = data.get("securityCount", len(rows))
        return {"rows": rows, "columns": col_names, "count": count, "query": query}

    # ── 实体识别 + 金融数据查询（mx-finance-data） ──────────────────────
    _ENTITY_TAG_FIELDS = ("entityId", "secuCode", "marketChar", "fullName", "market", "classCode")
    _DIRECT_QUERY_ENTITY_LIMIT = 5

    @staticmethod
    def _flatten_value(v):
        if v is None:
            return ""
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
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
            "callId": f"call_{uuid.uuid4().hex[:8]}",
            "userInfo": {"userId": f"user_{uuid.uuid4().hex[:8]}"},
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

    # ── 族 B：投顾助手 API ──────────────────────────────────────────────
    def _post_advisor(self, body, endpoint, stage, timeout=None):
        """族 B：/proxy/app-robo-advisor-api/assistant/<endpoint>，Markdown 类。"""
        return self._request(body, f"/proxy/app-robo-advisor-api/assistant/{endpoint}",
                             stage, timeout=timeout)

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
                    return json.dumps(v, ensure_ascii=False, indent=2)
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

    def comparable_company_analysis(self, question):
        """可比公司分析（comparable-company-analysis）。特例：question 键、60s、返回 list。

        注意 path 不在 write/ 下（直接 /assistant/comparable-company-analysis）。
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
        content = self._extract_text_content(payload)
        return {"content": content, "valid": valid, "query": query}

    # ── 族 C：报告生成 API ──────────────────────────────────────────────
    def _post_report(self, body, endpoint, stage, timeout=_DEFAULT_REPORT_TIMEOUT,
                     base_info=False):
        """族 C：报告生成。endpoint 是 assistant/ 下的完整子路径（含 write/）。"""
        return self._request(body, f"/proxy/app-robo-advisor-api/assistant/{endpoint}",
                             stage, timeout=timeout, base_info=base_info)

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
        attachments: {pdf: base64, word: base64}（原始）。
        output_dir 给定时落盘 PDF/Word，saved 记录路径。
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


# ── 进程级单例 ────────────────────────────────────────────────────────────
_client = None


def get_client():
    """返回进程级 EastmoneyClient 单例。"""
    global _client
    if _client is None:
        _client = EastmoneyClient()
    return _client
