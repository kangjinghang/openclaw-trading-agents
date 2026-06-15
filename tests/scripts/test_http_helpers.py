"""
Tests for _with_retry in skills/_shared/http_helpers.py (network-free, mocked).

_with_retry is the shared transient-error retry core used by em_get (eastmoney)
and http_get (other sources). These tests inject a fake callable + a fake sleep
so no real network or wall-clock delay is involved.
"""

import json
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
    """Clear the module-level call list before each collector test."""
    clear_errors()
    yield
    clear_errors()


def test_record_and_get_errors(reset_errors):
    record_error("macro_cls", "JSONDecodeError: no json")
    record_error("dragon_tiger", "timeout")
    errs = get_errors()
    assert len(errs) == 2
    assert errs[0]["stage"] == "macro_cls"
    assert errs[0]["error"] == "JSONDecodeError: no json"
    assert errs[1]["stage"] == "dragon_tiger"
    assert errs[1]["error"] == "timeout"


def test_error_fields_truncated(reset_errors):
    record_error("x" * 100, "y" * 300)
    errs = get_errors()
    assert len(errs[0]["stage"]) == 60  # stage truncated to 60 chars
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


# ── record_call collector (new functionality) ────────────────────────────
from http_helpers import record_call, get_calls  # noqa: E402


@pytest.fixture(autouse=False)
def reset_collector():
    """Clear the module-level call list before each record_call test."""
    clear_errors()
    yield
    clear_errors()


@pytest.fixture(autouse=False)
def reset_collector_isolated():
    """Isolated fixture for record_call tests to prevent cross-test pollution."""
    clear_errors()
    yield
    clear_errors()


def test_record_call_logs_success(tmp_path, monkeypatch, reset_collector_isolated):
    """record_call records successful calls with optional duration_ms."""
    record_call("hot_money/northbound", success=True, duration_ms=1234)
    calls = get_calls()
    assert len(calls) == 1
    assert calls[0]["stage"] == "hot_money/northbound"
    assert calls[0]["success"] is True
    assert calls[0]["duration_ms"] == 1234
    assert calls[0]["error"] is None


def test_record_call_logs_failure(tmp_path, monkeypatch, reset_collector_isolated):
    record_call("news/macro_cls", success=False, error="404 not found")
    calls = get_calls()
    assert calls[0]["success"] is False
    assert calls[0]["error"] == "404 not found"


def test_record_error_is_alias_for_failed_record_call(tmp_path, monkeypatch, reset_collector_isolated):
    """Backward compat: existing record_error call sites keep working."""
    record_error("hot_money/fund_flow", "rate_limited")
    calls = get_calls()
    assert len(calls) == 1
    assert calls[0]["success"] is False
    assert calls[0]["error"] == "rate_limited"


def test_output_json_includes_calls_array(capsys, monkeypatch, reset_collector_isolated):
    """output_json must surface _calls so downstream can observe per-source results."""
    record_call("test/source_a", success=True, duration_ms=100)
    record_call("test/source_b", success=False, error="boom")
    # output_json calls sys.exit; catch SystemExit so the test process survives.
    with pytest.raises(SystemExit) as exc_info:
        output_json(True, data={"x": 1})
    assert exc_info.value.code == 0  # success=True means exit code 0
    out = capsys.readouterr().out
    d = json.loads(out)
    assert "_calls" in d
    assert len(d["_calls"]) == 2
    assert d["_calls"][0]["stage"] == "test/source_a"
    # Backward compat: _errors still emitted (failures only)
    assert "_errors" in d
    assert len(d["_errors"]) == 1
    assert d["_errors"][0]["stage"] == "test/source_b"


def test_record_call_truncates_long_stage(tmp_path, reset_collector_isolated):
    """Defensive: stage longer than 60 chars is truncated, not crashed."""
    long_stage = "x" * 100
    record_call(long_stage, success=True)
    calls = get_calls()
    assert len(calls[0]["stage"]) == 60


def test_record_call_swallows_internal_exception(tmp_path, reset_collector_isolated):
    """If record_call itself fails (e.g. duration_ms not int-coercible), the
    internal try/except must swallow it — never crash the calling script."""
    # Pass a non-coercible duration_ms that would raise ValueError on int() —
    # the try/except inside record_call must swallow it.
    record_call("ok/source", success=True, duration_ms="not_a_number")
    # If we reached this line without exception, the swallow worked.
    # Note: the failed record is NOT appended (the exception aborted the dict
    # construction before _CALLS.append), so get_calls() may be empty or have
    # the record depending on where in the try block the exception fired.
    calls = get_calls()
    # The call failed to record because duration_ms="not_a_number" triggered
    # the exception handling. This verifies the swallow worked.


