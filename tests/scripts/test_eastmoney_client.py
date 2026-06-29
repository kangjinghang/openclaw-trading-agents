"""EastmoneyClient 单元测试 — 全 mock 网络，无真实流量。

import 路径照搬 test_iwencai_client.py 的模式：sys.path.insert _shared 目录。
"""
import sys
from pathlib import Path
from unittest import mock

import pytest
import requests

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


def test_post_mcp_timeout_retried_then_empty(with_key):
    """ConnectionError/Timeout 重试一次后返回空。"""
    from eastmoney_client import get_client
    c = get_client()
    err = requests.exceptions.Timeout("simulated timeout")
    with mock.patch("eastmoney_client.requests.post", side_effect=err) as mp, \
         mock.patch("eastmoney_client.time.sleep"):
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}
    assert mp.call_count == 2  # 重试 1 次


def test_post_mcp_json_parse_error_returns_empty(with_key):
    """resp.json() 抛异常时走 except Exception 兜底，返回空。"""
    from eastmoney_client import get_client
    c = get_client()
    r = mock.Mock()
    r.status_code = 200
    r.content = b"not json"
    r.json.side_effect = ValueError("invalid json")
    with mock.patch("eastmoney_client.requests.post", return_value=r):
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}


def test_record_call_emitted_on_success_and_failure(with_key, monkeypatch):
    """成功和失败两条路径都调 record_call。"""
    import eastmoney_client
    calls = []
    monkeypatch.setattr(eastmoney_client, "record_call",
                        lambda stage, success, **kw: calls.append((stage, success)))
    c = eastmoney_client.get_client()
    # success path
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload({"code": 0})):
        c._post_mcp({"query": "x"}, "searchData", "em/ok")
    # failure path (401)
    with mock.patch("eastmoney_client.requests.post", return_value=_status_payload(401)):
        c._post_mcp({"query": "x"}, "searchData", "em/fail")
    success_calls = [x for x in calls if x[1] is True]
    failure_calls = [x for x in calls if x[1] is False]
    assert len(success_calls) == 1 and success_calls[0][0] == "em/ok"
    assert len(failure_calls) == 1 and failure_calls[0][0] == "em/fail"
