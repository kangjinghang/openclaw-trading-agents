"""
Tests for IwencaiClient in skills/_shared/iwencai_client.py.

All network calls are mocked — no real HTTP traffic to openapi.iwencai.com.
Covers: normal query, field normalization, unconfigured key (no-op), 401 auth
failure (marks unavailable), timeout retry, empty result, parse error.
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
import requests

shared_dir = Path(__file__).parent.parent.parent / "skills" / "_shared"
sys.path.insert(0, str(shared_dir))

from iwencai_client import IwencaiClient  # noqa: E402
from http_helpers import clear_errors  # noqa: E402


def _mock_response(status_code=200, json_data=None, content=b""):
    """Build a fake requests.Response."""
    r = MagicMock()
    r.status_code = status_code
    r.content = content or (str(json_data).encode() if json_data else b"{}")
    r.json.return_value = json_data if json_data is not None else {}
    return r


def _sample_article(title="贵州茅台年报发布", extra_source="新京报",
                    publish_date="2026-06-29 13:33:05"):
    """One raw article as returned by the official API."""
    return {
        "title": title,
        "summary": "公司全年营收1721亿元，同比增长。",
        "publish_date": publish_date,
        "extra": {"real_publish_source": extra_source, "publish_source": "fallback_src"},
    }


class TestIwencaiClient:
    def setup_method(self):
        clear_errors()

    def test_unconfigured_key_means_unavailable(self):
        """No IWENCAI_API_KEY → available=False, search returns [] (no-op)."""
        c = IwencaiClient(api_key=None)
        with patch.dict("os.environ", {}, clear=True):
            assert c.available is False
            assert c.search_news("anything") == []

    def test_normal_query_returns_normalized_articles(self):
        """200 + valid data → list of {title,content,time,source}."""
        c = IwencaiClient(api_key="sk-test")
        fake = _mock_response(200, {"data": [_sample_article()]})
        with patch("iwencai_client.requests.post", return_value=fake) as mp:
            result = c.search_news("贵州茅台")
        assert len(result) == 1
        assert result[0]["title"] == "贵州茅台年报发布"
        # 字段对齐 news.py 东财结构
        assert result[0]["source"] == "新京报"  # real_publish_source 优先
        assert result[0]["time"] == "2026-06-29 13:33:05"
        assert "营收" in result[0]["content"]
        # 验证认证 + trace headers 传了
        _, kwargs = mp.call_args
        assert kwargs["headers"]["Authorization"] == "Bearer sk-test"
        assert "X-Claw-Trace-Id" in kwargs["headers"]
        assert kwargs["json"]["query"] == "贵州茅台"
        assert kwargs["json"]["app_id"] == "AIME_SKILL"

    def test_source_fallback_to_publish_source(self):
        """无 real_publish_source 时降级 publish_source。"""
        c = IwencaiClient(api_key="sk-test")
        art = _sample_article(extra_source=None)
        art["extra"] = {"publish_source": "经济日报"}
        with patch("iwencai_client.requests.post",
                   return_value=_mock_response(200, {"data": [art]})):
            result = c.search_news("x")
        assert result[0]["source"] == "经济日报"

    def test_401_marks_unavailable_and_short_circuits(self):
        """401 → 标记 available=False，后续查询不再发请求（防刷爆配额）。"""
        c = IwencaiClient(api_key="sk-test")
        with patch("iwencai_client.requests.post",
                   return_value=_mock_response(401)) as mp:
            r1 = c.search_news("a")
            r2 = c.search_news("b")
        assert r1 == []
        assert r2 == []
        # 401 后短路：第二次没发请求
        assert mp.call_count == 1
        assert c.available is False

    def test_timeout_retried_once(self):
        """超时重试一次，第二次成功 → 返回结果。"""
        c = IwencaiClient(api_key="sk-test")
        good = _mock_response(200, {"data": [_sample_article()]})
        with patch("iwencai_client.time.sleep") as ts:
            with patch("iwencai_client.requests.post",
                       side_effect=[requests.exceptions.Timeout("slow"), good]) as mp:
                result = c.search_news("a")
        assert len(result) == 1
        assert mp.call_count == 2
        assert ts.called  # 重试前 sleep 了

    def test_empty_data_returns_empty_list(self):
        """200 + data:[] → []（调用方据以 fallback）。"""
        c = IwencaiClient(api_key="sk-test")
        with patch("iwencai_client.requests.post",
                   return_value=_mock_response(200, {"data": []})):
            assert c.search_news("a") == []

    def test_missing_data_key_treated_as_empty(self):
        """响应无 data 字段（非预期结构）→ []。"""
        c = IwencaiClient(api_key="sk-test")
        with patch("iwencai_client.requests.post",
                   return_value=_mock_response(200, {"unexpected": 1})):
            assert c.search_news("a") == []

    def test_parse_error_returns_empty(self):
        """JSON 解析抛异常 → []，不向上传播。"""
        c = IwencaiClient(api_key="sk-test")
        bad = _mock_response(200, {"data": None})
        bad.json.side_effect = ValueError("not json")
        with patch("iwencai_client.requests.post", return_value=bad):
            assert c.search_news("a") == []

    def test_5xx_retried_once_then_empty(self):
        """500 → 重试一次仍 500 → []（不无限重试）。"""
        c = IwencaiClient(api_key="sk-test")
        with patch("iwencai_client.time.sleep"):
            with patch("iwencai_client.requests.post",
                       return_value=_mock_response(500)) as mp:
                assert c.search_news("a") == []
        assert mp.call_count == 2

    def test_title_less_article_filtered(self):
        """无 title 的条目被过滤（normalize 返回 None）。"""
        c = IwencaiClient(api_key="sk-test")
        art = _sample_article()
        art["title"] = "   "
        with patch("iwencai_client.requests.post",
                   return_value=_mock_response(200, {"data": [art, _sample_article()]})):
            result = c.search_news("a")
        assert len(result) == 1  # 空 title 的那条被丢

    def test_record_call_emitted(self):
        """成功/失败都 record_call 进 _calls（与 em_get/pywencai 同可观测体系）。"""
        from http_helpers import get_calls
        clear_errors()
        c = IwencaiClient(api_key="sk-test")
        with patch("iwencai_client.requests.post",
                   return_value=_mock_response(200, {"data": [_sample_article()]})):
            c.search_news("a")
        calls = get_calls()
        assert any(c["stage"] == "iwencai/news" and c["success"] for c in calls)

    def test_get_client_singleton(self):
        """get_client() 返回进程级单例。"""
        from iwencai_client import get_client
        with patch.dict("os.environ", {"IWENCAI_API_KEY": "sk-env"}):
            # reset module-level singleton by re-fetching after env set
            import iwencai_client as ic
            ic._client = None
            c = get_client()
            assert c.api_key == "sk-env"
            assert c.available is True
            # 再次 get 返回同一实例
            assert get_client() is c
        ic._client = None  # 清理，避免污染其他测试
