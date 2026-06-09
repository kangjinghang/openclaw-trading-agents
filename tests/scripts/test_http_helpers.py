"""
Tests for _with_retry in skills/_shared/http_helpers.py (network-free, mocked).

_with_retry is the shared transient-error retry core used by em_get (eastmoney)
and http_get (other sources). These tests inject a fake callable + a fake sleep
so no real network or wall-clock delay is involved.
"""

import sys
from pathlib import Path

import pytest
import requests

# Add skills/_shared to path so we can import http_helpers
shared_dir = Path(__file__).parent.parent.parent / "skills" / "_shared"
sys.path.insert(0, str(shared_dir))

from http_helpers import _with_retry  # noqa: E402


class _Flaky:
    """Callable that raises the queued exceptions, then returns then_return."""

    def __init__(self, raises, then_return="ok"):
        self.raises = list(raises)
        self.then_return = then_return
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.raises:
            raise self.raises.pop(0)
        return self.then_return


def test_returns_on_first_success_no_backoff():
    f = _Flaky([])
    sleeps = []
    assert _with_retry(f, _sleep=sleeps.append) == "ok"
    assert f.calls == 1
    assert sleeps == []


def test_retries_connection_error_then_succeeds():
    f = _Flaky([requests.exceptions.ConnectionError("blip")])
    sleeps = []
    assert _with_retry(f, attempts=3, base_delay=0.5, _sleep=sleeps.append) == "ok"
    assert f.calls == 2  # 1 fail + 1 success
    assert len(sleeps) == 1  # one backoff between them


def test_exhausts_attempts_then_reraises_last():
    f = _Flaky([
        requests.exceptions.ConnectionError("a"),
        requests.exceptions.ConnectionError("b"),
        requests.exceptions.ConnectionError("c"),
    ])
    sleeps = []
    with pytest.raises(requests.exceptions.ConnectionError):
        _with_retry(f, attempts=3, base_delay=0.5, _sleep=sleeps.append)
    assert f.calls == 3
    assert len(sleeps) == 2  # backoff after attempt 1 and 2, NOT after the final


def test_backoff_grows_exponentially():
    f = _Flaky([
        requests.exceptions.ConnectionError("a"),
        requests.exceptions.ConnectionError("b"),
        requests.exceptions.ConnectionError("c"),
    ])
    sleeps = []
    with pytest.raises(requests.exceptions.ConnectionError):
        _with_retry(f, attempts=3, base_delay=1.0, factor=2.0, _sleep=sleeps.append)
    # delay = base * factor**attempt + jitter(0, base*0.5)
    # attempt 0 → 1.0 + [0,0.5] = [1.0, 1.5] ; attempt 1 → 2.0 + [0,0.5] = [2.0, 2.5]
    assert 1.0 <= sleeps[0] < 1.6
    assert 2.0 <= sleeps[1] < 2.6
    assert sleeps[1] > sleeps[0]


def test_does_not_retry_non_transient_errors():
    # ValueError is not in the default retry_on → propagates immediately
    f = _Flaky([ValueError("nope")])
    sleeps = []
    with pytest.raises(ValueError):
        _with_retry(f, attempts=3, _sleep=sleeps.append)
    assert f.calls == 1
    assert sleeps == []


def test_timeout_not_retried_by_default():
    # Timeout is deliberately excluded from default retry_on (would blow the
    # 30s script budget). It must propagate on the first attempt.
    f = _Flaky([requests.exceptions.Timeout("slow")])
    with pytest.raises(requests.exceptions.Timeout):
        _with_retry(f, attempts=3, _sleep=lambda _d: None)
    assert f.calls == 1


def test_custom_retry_on_opts_in():
    # A caller can explicitly opt into retrying other exception types.
    f = _Flaky([requests.exceptions.Timeout("slow")])
    sleeps = []
    assert _with_retry(
        f, attempts=3, retry_on=(requests.exceptions.Timeout,), _sleep=sleeps.append
    ) == "ok"
    assert f.calls == 2
    assert len(sleeps) == 1
