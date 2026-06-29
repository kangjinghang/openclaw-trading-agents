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


# ── 进程级单例 ────────────────────────────────────────────────────────────
_client = None


def get_client():
    """返回进程级 EastmoneyClient 单例。"""
    global _client
    if _client is None:
        _client = EastmoneyClient()
    return _client
