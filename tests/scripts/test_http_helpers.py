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


# ── Error collector (record_error / get_errors / output_json _errors) ──
# These pin the contract that whole-source failures recorded via record_error
# surface in output_json's top-level _errors array WITHOUT affecting `success`,
# so a partial outage is observable instead of masquerading as "no data".
from http_helpers import record_error, get_errors, clear_errors, output_json  # noqa: E402


@pytest.fixture(autouse=False)
def reset_errors():
    """Clear the module-level error list before each collector test."""
    clear_errors()
    yield
    clear_errors()


def test_record_and_get_errors(reset_errors):
    record_error("macro_cls", "JSONDecodeError: no json")
    record_error("dragon_tiger", "timeout")
    errs = get_errors()
    assert len(errs) == 2
    assert errs[0] == {"stage": "macro_cls", "error": "JSONDecodeError: no json"}
    assert errs[1] == {"stage": "dragon_tiger", "error": "timeout"}


def test_error_fields_truncated(reset_errors):
    record_error("x" * 100, "y" * 300)
    errs = get_errors()
    assert len(errs[0]["stage"]) == 40  # stage truncated to 40 chars
    assert len(errs[0]["error"]) == 160  # error truncated to 160 chars


def test_get_errors_returns_copy_not_reference(reset_errors):
    record_error("s1", "e1")
    snapshot = get_errors()
    snapshot.append({"stage": "tamper", "error": "x"})
    # Mutating the returned list must not affect the internal collector
    assert len(get_errors()) == 1


def test_clear_errors(reset_errors):
    record_error("s1", "e1")
    record_error("s2", "e2")
    clear_errors()
    assert get_errors() == []


def test_output_json_includes_errors_when_present(capsys, reset_errors):
    record_error("macro_cls", "down")
    # output_json calls sys.exit; catch SystemExit so the test process survives.
    with pytest.raises(SystemExit):
        output_json(True, data={"k": "v"}, source="test")
    out = capsys.readouterr().out
    import json
    d = json.loads(out)
    assert d["success"] is True  # errors do NOT flip success
    assert d["_errors"] == [{"stage": "macro_cls", "error": "down"}]


def test_output_json_omits_errors_when_absent(capsys, reset_errors):
    # No record_error calls → _errors must be absent (not an empty array)
    with pytest.raises(SystemExit):
        output_json(True, data={"k": "v"})
    out = capsys.readouterr().out
    import json
    d = json.loads(out)
    assert "_errors" not in d


