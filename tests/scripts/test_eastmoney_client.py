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
