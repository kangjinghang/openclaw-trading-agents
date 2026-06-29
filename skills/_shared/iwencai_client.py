"""问财官方 OpenAPI 客户端 — 25 个官方 Skill 统一封装。

两种 API 网关：
  Pattern A: /v1/comprehensive/search  — news / report / announcement（channels 区分）
  Pattern B: /v1/query2data            — 所有 hithink-* 选股/查询类 skill

设计原则：
  1. 可选增强——IWENCAI_API_KEY 未配置时 available=False，所有方法返回空/None，
     调用方优雅降级，零行为变化。
  2. 可观测性——每个请求走 http_helpers.record_call，进 _source-health.json。
  3. 一致性——所有 hithink-* skill 共享同一个 _query2data() 内核，方法名对齐 skill slug。
"""

import os
import secrets
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
_DEFAULT_BASE_URL = "https://openapi.iwencai.com"
_SEARCH_PATH = "/v1/comprehensive/search"
_QUERY2DATA_PATH = "/v1/query2data"
_APP_ID = "AIME_SKILL"
_DEFAULT_TIMEOUT = 15
_CLAW_HEADERS = {
    "X-Claw-Call-Type": "normal",
    "X-Claw-Skill-Id": "iwencai-client",
    "X-Claw-Skill-Version": "1.0.0",
    "X-Claw-Plugin-Id": "none",
    "X-Claw-Plugin-Version": "none",
}

# Pattern A: channels 映射
_CHANNELS_MAP = {
    "search_news": "news",
    "search_report": "report",
    "search_announcement": "announcement",
}

# Pattern B: 所有 hithink-* skill 的 slug → 中文名
_HITHINK_SKILLS = {
    "hithink-zhishu-query": "指数数据查询",
    "hithink-sector-selector": "问财选板块",
    "hithink-management-query": "公司股东股本查询",
    "hithink-macro-query": "宏观数据查询",
    "hithink-usstock-selector": "问财选美股",
    "hithink-market-query": "行情数据查询",
    "hithink-insresearch-query": "机构研究与评级查询",
    "hithink-industry-query": "行业数据查询",
    "hithink-hkstock-selector": "问财选港股",
    "hithink-futures-selector": "问财选期货期权",
    "hithink-futures-query": "期货期权数据查询",
    "hithink-fund-selector": "问财选基金",
    "hithink-fundmanager-selector": "问财选基金经理",
    "hithink-fundcompany-selector": "问财选基金公司",
    "hithink-fund-query": "基金理财查询",
    "hithink-finance-query": "财务数据查询",
    "hithink-event-query": "事件数据查询",
    "hithink-business-query": "公司经营数据查询",
    "hithink-etf-selector": "问财选ETF",
    "hithink-cb-selector": "问财选可转债",
    "hithink-astock-selector": "问财选A股",
    "hithink-basicinfo-query": "基本资料查询",
}


class IwencaiClient:
    """问财官方 OpenAPI 客户端。

    构造时从环境变量读取配置：
        IWENCAI_API_KEY  — 必填，未设置则 available=False
        IWENCAI_BASE_URL — 可选，默认 https://openapi.iwencai.com
    """

    def __init__(self, api_key=None, base_url=None, timeout=_DEFAULT_TIMEOUT):
        self.api_key = api_key or os.environ.get("IWENCAI_API_KEY")
        self.base_url = (base_url or os.environ.get("IWENCAI_BASE_URL")
                         or _DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.available = bool(self.api_key)

    def _trace_id(self):
        return secrets.token_hex(32)

    def _headers(self, skill_id="iwencai-client"):
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Claw-Trace-Id": self._trace_id(),
            **_CLAW_HEADERS,
            "X-Claw-Skill-Id": skill_id,
        }

    def _post(self, body, path=_SEARCH_PATH, stage="iwencai", skill_id="iwencai-client"):
        """统一 POST：认证 + 重试 + record_call。返回原始 payload dict。"""
        if not self.available:
            return {}

        url = self.base_url + path
        headers = self._headers(skill_id)
        start = time.monotonic()
        last_error = last_status = last_size = None

        for attempt in range(2):
            try:
                resp = requests.post(url, json=body, headers=headers, timeout=self.timeout)
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

    # ═══════════════════════════════════════════════════════════════════════
    # Pattern A: /v1/comprehensive/search — news / report / announcement
    # ═══════════════════════════════════════════════════════════════════════

    def _comprehensive_search(self, query, channels, size=10, stage="iwencai"):
        body = {"query": query, "channels": channels, "app_id": _APP_ID, "size": size}
        payload = self._post(body, path=_SEARCH_PATH, stage=stage)
        data = payload.get("data") if isinstance(payload, dict) else None
        return data if isinstance(data, list) else []

    def search_news(self, query, size=10):
        """搜索财经资讯。返回 list[dict]，每篇 {title, content, time, source}。"""
        items = self._comprehensive_search(query, ["news"], size, stage="iwencai/news")
        return [r for r in (self._normalize_article(it) for it in items) if r]

    def search_report(self, query, size=10):
        """搜索研报。返回原始 data 列表。"""
        return self._comprehensive_search(query, ["report"], size, stage="iwencai/report")

    def search_announcement(self, query, size=10):
        """搜索公告。返回原始 data 列表。"""
        return self._comprehensive_search(query, ["announcement"], size, stage="iwencai/announcement")

    @staticmethod
    def _normalize_article(raw):
        if not isinstance(raw, dict):
            return None
        title = (raw.get("title") or "").strip()
        if not title:
            return None
        extra = raw.get("extra") or {}
        return {
            "title": title,
            "content": (raw.get("summary") or "").strip(),
            "time": (raw.get("publish_date") or "").strip(),
            "source": (extra.get("real_publish_source")
                       or extra.get("publish_source") or "问财").strip(),
        }

    # ═══════════════════════════════════════════════════════════════════════
    # Pattern B: /v1/query2data — 所有 hithink-* skill
    # ═══════════════════════════════════════════════════════════════════════

    def _query2data(self, query, skill_slug, page="1", limit="10", timeout=None):
        """通用 query2data 调用。返回原始 payload dict（含 datas/code_count 等）。"""
        body = {
            "query": query,
            "page": str(page),
            "limit": str(limit),
            "is_cache": "1",
            "expand_index": "true",
        }
        old_timeout = self.timeout
        if timeout is not None:
            self.timeout = timeout
        try:
            return self._post(body, path=_QUERY2DATA_PATH,
                              stage=f"iwencai/{skill_slug}", skill_id=skill_slug)
        finally:
            self.timeout = old_timeout

    def _query2data_list(self, query, skill_slug, page="1", limit="10"):
        """query2data 的便捷包装：返回 (datas_list, code_count, has_more)。"""
        payload = self._query2data(query, skill_slug, page, limit)
        if not payload:
            return [], 0, False
        datas = payload.get("datas", [])
        code_count = int(payload.get("code_count", 0))
        has_more = int(page) * int(limit) < code_count
        return datas, code_count, has_more

    # ── 指数/行情/财务/事件等查询类（返回数据列表）──────────────────────

    def query_index(self, query, page="1", limit="10"):
        """指数数据查询（hithink-zhishu-query）。"""
        return self._query2data_list(query, "hithink-zhishu-query", page, limit)

    def query_market(self, query, page="1", limit="10"):
        """行情数据查询（hithink-market-query）。"""
        return self._query2data_list(query, "hithink-market-query", page, limit)

    def query_finance(self, query, page="1", limit="10"):
        """财务数据查询（hithink-finance-query）。"""
        return self._query2data_list(query, "hithink-finance-query", page, limit)

    def query_event(self, query, page="1", limit="10"):
        """事件数据查询（hithink-event-query）。"""
        return self._query2data_list(query, "hithink-event-query", page, limit)

    def query_macro(self, query, page="1", limit="10"):
        """宏观数据查询（hithink-macro-query）。"""
        return self._query2data_list(query, "hithink-macro-query", page, limit)

    def query_industry(self, query, page="1", limit="10"):
        """行业数据查询（hithink-industry-query）。"""
        return self._query2data_list(query, "hithink-industry-query", page, limit)

    def query_management(self, query, page="1", limit="10"):
        """公司股东股本查询（hithink-management-query）。"""
        return self._query2data_list(query, "hithink-management-query", page, limit)

    def query_business(self, query, page="1", limit="10"):
        """公司经营数据查询（hithink-business-query）。"""
        return self._query2data_list(query, "hithink-business-query", page, limit)

    def query_basicinfo(self, query, page="1", limit="10"):
        """基本资料查询（hithink-basicinfo-query）。"""
        return self._query2data_list(query, "hithink-basicinfo-query", page, limit)

    def query_insresearch(self, query, page="1", limit="10"):
        """机构研究与评级查询（hithink-insresearch-query）。"""
        return self._query2data_list(query, "hithink-insresearch-query", page, limit)

    def query_fund(self, query, page="1", limit="10"):
        """基金理财查询（hithink-fund-query）。"""
        return self._query2data_list(query, "hithink-fund-query", page, limit)

    def query_futures(self, query, page="1", limit="10"):
        """期货期权数据查询（hithink-futures-query）。"""
        return self._query2data_list(query, "hithink-futures-query", page, limit)

    # ── 选股类（返回筛选结果列表）──────────────────────────────────────

    def select_astock(self, query, page="1", limit="10"):
        """问财选A股（hithink-astock-selector）。"""
        return self._query2data_list(query, "hithink-astock-selector", page, limit)

    def select_usstock(self, query, page="1", limit="10"):
        """问财选美股（hithink-usstock-selector）。"""
        return self._query2data_list(query, "hithink-usstock-selector", page, limit)

    def select_hkstock(self, query, page="1", limit="10"):
        """问财选港股（hithink-hkstock-selector）。"""
        return self._query2data_list(query, "hithink-hkstock-selector", page, limit)

    def select_sector(self, query, page="1", limit="10"):
        """问财选板块（hithink-sector-selector）。"""
        return self._query2data_list(query, "hithink-sector-selector", page, limit)

    def select_etf(self, query, page="1", limit="10"):
        """问财选ETF（hithink-etf-selector）。"""
        return self._query2data_list(query, "hithink-etf-selector", page, limit)

    def select_cb(self, query, page="1", limit="10"):
        """问财选可转债（hithink-cb-selector）。"""
        return self._query2data_list(query, "hithink-cb-selector", page, limit)

    def select_fund(self, query, page="1", limit="10"):
        """问财选基金（hithink-fund-selector）。"""
        return self._query2data_list(query, "hithink-fund-selector", page, limit)

    def select_fundmanager(self, query, page="1", limit="10"):
        """问财选基金经理（hithink-fundmanager-selector）。"""
        return self._query2data_list(query, "hithink-fundmanager-selector", page, limit)

    def select_fundcompany(self, query, page="1", limit="10"):
        """问财选基金公司（hithink-fundcompany-selector）。"""
        return self._query2data_list(query, "hithink-fundcompany-selector", page, limit)

    def select_futures(self, query, page="1", limit="10"):
        """问财选期货期权（hithink-futures-selector）。"""
        return self._query2data_list(query, "hithink-futures-selector", page, limit)

    # ── 通用查询入口（按 slug 路由）────────────────────────────────────

    def query(self, query, slug, page="1", limit="10"):
        """通用入口：按 skill slug 路由到对应 API。

        支持所有 25 个官方 skill slug，自动选择正确的网关和参数格式。
        """
        # Pattern A: comprehensive/search 类
        channels_map = {
            "news-search": "news",
            "report-search": "report",
            "announcement-search": "announcement",
        }
        if slug in channels_map:
            return self._comprehensive_search(query, [channels_map[slug]], int(limit))

        # Pattern B: query2data 类
        if slug in _HITHINK_SKILLS:
            return self._query2data_list(query, slug, page, limit)

        raise ValueError(f"Unknown skill slug: {slug}. "
                         f"Supported: {list(channels_map.keys()) + list(_HITHINK_SKILLS.keys())}")

    @property
    def supported_skills(self):
        """返回所有支持的 skill slug → 中文名映射。"""
        return {
            "news-search": "新闻搜索",
            "report-search": "研报搜索",
            "announcement-search": "公告搜索",
            **_HITHINK_SKILLS,
        }


# ── 进程级单例 ────────────────────────────────────────────────────────────
_client = None


def get_client():
    """返回进程级 IwencaiClient 单例。"""
    global _client
    if _client is None:
        _client = IwencaiClient()
    return _client
