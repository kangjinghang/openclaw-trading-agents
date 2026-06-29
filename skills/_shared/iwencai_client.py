"""问财官方 OpenAPI 客户端（同花顺 SkillHub 官方 API 扒取封装）。

不同于 http_helpers.py 里的 pywencai_query（逆向 www.iwencai.com 网页接口的第三方库，
还得 monkey-patch 修 403），这里封装的是官方正式 OpenAPI（openapi.iwencai.com），
走 API key 认证，可靠性是另一个量级。

调用契约（实测验证 + 扒取自官方 news-search skill 的 news_search.py）：
    POST https://openapi.iwencai.com/v1/comprehensive/search
    Headers:
        Authorization: Bearer $IWENCAI_API_KEY
        X-Claw-Trace-Id: <64位hex>      # 网关要求，每次随机
        X-Claw-Skill-Id / Version / Call-Type / Plugin-*（固定值）
    Body: {"channels": ["news"], "app_id": "AIME_SKILL", "query": "关键词"}
    Response: data[] 每篇含 title/summary/source_original(全文)/publish_date/
              publish_source(真实来源)/score(相关度)/site_authority(权威度)

设计原则：
1. **可选增强**——IWENCAI_API_KEY 未配置时 available=False，所有方法返回空，
   调用方（news.py）优雅降级到现有东财源，零行为变化。
2. **可观测性**——每个请求走 http_helpers.record_call，进 _source-health.json 的
   per-source 成功率/耗时统计，和 em_get/pywencai 同一套体系。
3. **可扩展**——类结构，以后扒别的官方 skill（选股/研报/资金流）直接加方法。
   不塞进已臃肿的 http_helpers.py（那是个平铺函数集合，且有全局 monkey-patch 问题）。
"""

import os
import secrets
import time

import requests

# 复用 http_helpers 的 record_call 保持可观测性统一。延迟 import 避免循环依赖，
# 但实际上 http_helpers 无反向依赖本模块。
try:
    from http_helpers import record_call
except Exception:  # pragma: no cover - 防御：单文件被移到别处时不崩
    def record_call(stage, success, error=None, duration_ms=None,
                    url=None, status_code=None, response_size=None,
                    response_snippet=None):
        pass


# ── 常量（扒取自官方 skill 的 news_search.py）─────────────────────────
_DEFAULT_BASE_URL = "https://openapi.iwencai.com"
_SEARCH_PATH = "/v1/comprehensive/search"
_APP_ID = "AIME_SKILL"  # 官方 skill 固定用这个 app_id
_DEFAULT_TIMEOUT = 15
# 官方 skill 固定的 X-Claw-* 网关 headers
_CLAW_HEADERS = {
    "X-Claw-Call-Type": "normal",
    "X-Claw-Skill-Id": "news-search",
    "X-Claw-Skill-Version": "1.0.0",
    "X-Claw-Plugin-Id": "none",
    "X-Claw-Plugin-Version": "none",
}


class IwencaiClient:
    """问财官方 OpenAPI 客户端。

    构造时从环境变量读取配置：
        IWENCAI_API_KEY  — 必填，未设置则 available=False（整个客户端降级为 no-op）
        IWENCAI_BASE_URL — 可选，默认 https://openapi.iwencai.com（私有部署/代理用）

    所有查询方法（search_news 及未来的 search_stock 等）在 available=False 时
    返回空列表，调用方据以 fallback 到免费源。这遵循 pywencai_query 的同款
    "可选依赖、优雅降级"设计。
    """

    def __init__(self, api_key=None, base_url=None, timeout=_DEFAULT_TIMEOUT):
        self.api_key = api_key or os.environ.get("IWENCAI_API_KEY")
        self.base_url = (base_url or os.environ.get("IWENCAI_BASE_URL")
                         or _DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        # available=False 时所有查询短路返回 []，调用方据以 fallback。
        # 不抛异常——让 news.py 等调用方的 try/except 保持"未配置=免费源"语义。
        self.available = bool(self.api_key)

    def _trace_id(self):
        """生成网关要求的 X-Claw-Trace-Id（64 位 hex）。每次请求唯一，便于服务端追踪。"""
        return secrets.token_hex(32)

    def _post(self, body, path=_SEARCH_PATH, stage="iwencai/news"):
        """统一 POST 封装：认证 headers + trace-id + 重试 + record_call 可观测。

        返回解析后的 data 列表；失败（网络/状态码/解析）返回空列表并 record_call
        记录失败原因。调用方据空列表 fallback——不抛异常，降级路径干净。
        """
        if not self.available:
            return []

        url = self.base_url + path
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Claw-Trace-Id": self._trace_id(),
            **_CLAW_HEADERS,
        }
        start = time.monotonic()
        last_error = None
        last_status = None
        last_size = None
        # 重试一次（连接/超时瞬时错误），与 http_helpers._with_retry 同思路但更简单：
        # 问财是付费 API，两次够了，且 401/403 等认证错误不重试（重试无意义）。
        for attempt in range(2):
            try:
                resp = requests.post(url, json=body, headers=headers, timeout=self.timeout)
                last_status = resp.status_code
                last_size = len(resp.content)
                if resp.status_code == 401 or resp.status_code == 403:
                    # 认证错误：key 失效/过期，不重试。标记 available=False 让后续
                    # 查询短路，避免无效请求刷爆配额。
                    last_error = f"auth failed: HTTP {resp.status_code}"
                    self.available = False
                    break
                if resp.status_code != 200:
                    # 其他非 200（限流 429 / 5xx）→ 重试一次
                    last_error = f"http {resp.status_code}"
                    if attempt == 0:
                        time.sleep(0.5)
                        continue
                    break
                payload = resp.json()
                data = payload.get("data") if isinstance(payload, dict) else None
                items = data if isinstance(data, list) else []
                record_call(stage, success=True,
                            duration_ms=(time.monotonic() - start) * 1000,
                            url=url, status_code=resp.status_code,
                            response_size=len(resp.content))
                return items
            except (requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout) as e:
                # 瞬时网络错误：重试一次
                last_error = f"{type(e).__name__}: {e}"
                last_status = None
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                break
            except (ValueError, KeyError) as e:
                # JSON 解析失败 / 结构异常：不重试，记录后返回空
                last_error = f"parse error: {type(e).__name__}: {e}"
                break
            except Exception as e:
                last_error = f"{type(e).__name__}: {e}"
                break

        record_call(stage, success=False, error=last_error,
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=url, status_code=last_status, response_size=last_size)
        return []

    def search_news(self, query):
        """综合搜索财经资讯（官方 news-search skill 同款能力）。

        Args:
            query: 搜索关键词。个股用公司名（如 "贵州茅台"），宏观用主题
                   （如 "央行降准 货币政策"、"A股 大盘 走势"）。

        Returns:
            list[dict]，每篇归一化为 {title, content, time, source}，与 news.py
            的东财新闻同结构（source-agnostic，下游 prompt 注入无需区分源）。
            失败/未配 key/空结果 → []，调用方据以 fallback 到东财/akshare。

        返回结构对齐 news.py 东财新闻的 4 字段（title/content/time/source），
        以便 news.py 无缝替换/合并。content 取 summary（比 source_original 全文短，
        避免单篇过长挤占 prompt token），按 publish_date 降序。
        """
        if not self.available:
            return []

        body = {"channels": ["news"], "app_id": _APP_ID, "query": query}
        items = self._post(body, stage="iwencai/news")
        return [self._normalize_article(it) for it in items if self._normalize_article(it)]

    @staticmethod
    def _normalize_article(raw):
        """把官方 API 的原始字段映射成 news.py 东财新闻的同款 4 字段结构。

        - content 用 summary（精炼摘要），不用 source_original（全文太长挤 token）
        - source 优先 real_publish_source（真实来源如"新京报"），降级 publish_source
        - time 用 publish_date（已是 "YYYY-MM-DD HH:MM:SS" 格式，与东财 date 同款）
        """
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


# ── 进程级单例 ────────────────────────────────────────────────────────
# news.py 等脚本一次运行内多次查询复用同一个 client（key 探测只做一次、
# available 标记在 401 后短路生效）。脚本是短生命周期进程，无需显式回收。
_client = None


def get_client():
    """返回进程级 IwencaiClient 单例。未配 key 时返回的 client.available=False，
    所有查询返回 []——调用方据以 fallback，零成本降级。"""
    global _client
    if _client is None:
        _client = IwencaiClient()
    return _client
