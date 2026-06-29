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
