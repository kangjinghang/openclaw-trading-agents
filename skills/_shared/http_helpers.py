# skills/_shared/http_helpers.py
"""
Shared HTTP helpers for A-share data scripts.
Provides throttled eastmoney access, session reuse, and standardized JSON output.
"""

import json
import os
import random
import re
import socket
import sys
import time

import requests


# ── Whole-source call collector ──────────────────────────────────────
# Scripts record per-source call results here (success AND failure).
# output_json() surfaces them as a top-level `_calls` array so downstream
# can compute per-source success rates and detect outages/rate-limits.
# `_errors` (failure-only view) is kept for backward compat with code
# that reads result.errors (commit d3e5d34).
_CALLS = []


def record_call(stage, success, error=None, duration_ms=None,
                url=None, status_code=None, response_size=None, response_snippet=None):
    """Record a per-source call result (success or failure).

    Args:
        stage: source identifier, slash-separated for hierarchy
               (e.g. "hot_money/northbound", "news/macro_cls"). Truncated to 60 chars.
        success: True if the call yielded usable data
        error: short error message if failed (truncated to 160 chars)
        duration_ms: optional call duration in ms (for slow-source detection)
        url: optional HTTP URL that was called (for debugging)
        status_code: optional HTTP status code (for debugging)
        response_size: optional response body size in bytes (for debugging)
        response_snippet: optional first 200 chars of response body (for debugging)
    """
    try:
        entry = {
            "stage": str(stage)[:60],
            "success": bool(success),
            "error": str(error)[:160] if error else None,
            "duration_ms": int(duration_ms) if duration_ms is not None else None,
        }
        if url is not None:
            entry["url"] = str(url)[:200]
        if status_code is not None:
            entry["status_code"] = int(status_code)
        if response_size is not None:
            entry["response_size"] = int(response_size)
        if response_snippet is not None:
            entry["response_snippet"] = str(response_snippet)[:2000]
        _CALLS.append(entry)
    except Exception:
        pass  # never crash the script over a stats record


def record_error(stage, msg):
    """Backward-compatible alias: records a failed call. Existing call sites
    that use record_error keep working; new code should prefer record_call."""
    record_call(stage, success=False, error=msg)


def get_calls():
    """Return accumulated calls (does not clear)."""
    return list(_CALLS)


def get_errors():
    """Backward-compat: return failure-only view of _CALLS, shaped like the
    `_errors` JSON field emitted by output_json() — i.e. list of {stage, error}."""
    return [{"stage": c["stage"], "error": c["error"]} for c in _CALLS if not c["success"]]


def clear_errors():
    """Clear accumulated calls. Call at start of each fetch if reusing the
    process across runs (tests do this)."""
    del _CALLS[:]


# ── Force IPv4 for eastmoney push2 (IPv6 connections get reset) ─────
if socket.has_ipv6:
    _orig_getaddrinfo = socket.getaddrinfo
    def _prefer_ipv4(host, port, family=0, type=0, proto=0, flags=0):
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    socket.getaddrinfo = _prefer_ipv4


# ── Eastmoney anti-ban ──────────────────────────────────────────────
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_EM_SESSION = requests.Session()
_EM_SESSION.headers.update({"User-Agent": _UA})
_EM_MIN_INTERVAL = float(os.environ.get("EM_MIN_INTERVAL", "1.0"))
_em_last_call = [0.0]


def _with_retry(fn, *, attempts=3, base_delay=0.5, factor=2.0,
                retry_on=None, _sleep=time.sleep):
    """Call fn() with exponential-backoff retry on transient (fast) errors.

    By default retries connection-level errors and HTTP errors — both are fast
    to surface (<1s) and transient (a flapping upstream or a temporary bad
    gateway), so 3 attempts stay well within the 30s script budget. Timeouts
    are deliberately NOT retried by default: a single timeout already nears the
    budget, and retrying it would blow the deadline. Pass ``retry_on`` to
    override.

    Note: requests does not raise HTTPError for 4xx/5xx unless the caller also
    invokes raise_for_status(). To get 5xx retries, wrap the get + raise in the
    fn passed to _with_retry (see http_get_checked below). A JSONDecodeError
    from r.json() similarly only fires if json parsing happens inside fn —
    callers that parse .json() themselves will not benefit from that retry and
    must handle it (e.g. the CLS macro fallback in news.py/policy.py).

    ``_sleep`` is injectable for testing.
    """
    if retry_on is None:
        retry_on = (
            requests.exceptions.ConnectionError,
            requests.exceptions.HTTPError,
        )
    last_exc = None
    for attempt in range(attempts):
        try:
            return fn()
        except retry_on as exc:
            last_exc = exc
            if attempt + 1 >= attempts:
                break
            delay = base_delay * (factor ** attempt) + random.uniform(0, base_delay * 0.5)
            _sleep(delay)
    raise last_exc


def em_get(url, params=None, headers=None, timeout=15, **kwargs):
    """Eastmoney throttled GET: auto-rate-limit + session reuse + transient retry."""
    wait = _EM_MIN_INTERVAL - (time.time() - _em_last_call[0])
    if wait > 0:
        time.sleep(wait + random.uniform(0.1, 0.5))
    try:
        return _with_retry(
            lambda: _EM_SESSION.get(url, params=params, headers=headers, timeout=timeout, **kwargs)
        )
    finally:
        _em_last_call[0] = time.time()


def http_get(url, **kwargs):
    """requests.get with automatic retry on transient connection errors.

    Drop-in replacement for requests.get (same Response return type) used for
    non-eastmoney sources (sina / 10jqka / cls / baidu). All kwargs forward to
    requests.get.
    """
    return _with_retry(lambda: requests.get(url, **kwargs))


def eastmoney_datacenter(report_name, columns="ALL", filter_str="",
                         page_size=50, sort_columns="", sort_types="-1"):
    """Eastmoney Datacenter unified query (shared by dragon-tiger, lockup, etc.).

    Returns (data, http_details) where http_details = {url, status_code, response_size, response_snippet}.
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": report_name,
        "columns": columns,
        "filter": filter_str,
        "pageNumber": "1",
        "pageSize": str(page_size),
        "sortColumns": sort_columns,
        "sortTypes": sort_types,
        "source": "WEB",
        "client": "WEB",
    }
    r = em_get(url, params=params, timeout=15)
    http = {"url": url, "status_code": r.status_code,
            "response_size": len(r.content), "response_snippet": r.text[:2000]}
    d = r.json()
    if d.get("result") and d["result"].get("data"):
        return d["result"]["data"], http
    return [], http


# ── Tencent real-time quote ─────────────────────────────────────────
def tencent_quote(codes):
    """Batch real-time quotes from Tencent Finance (qt.gtimg.cn).
    codes: list of 6-digit strings. Returns (result, http_details) where:
      result: dict[code] -> {name, price, pe_ttm, pb, ...}
      http_details: dict with url, status_code, response_size, response_snippet
    """
    import urllib.request
    from urllib.error import HTTPError, URLError

    def _get_prefix(code):
        if code.startswith(("6", "9")):
            return "sh"
        elif code.startswith("8"):
            return "bj"
        return "sz"

    prefixed = [f"{_get_prefix(c)}{c}" for c in codes]
    url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")
    resp = urllib.request.urlopen(req, timeout=10)
    raw_bytes = resp.read()
    raw = raw_bytes.decode("gbk")
    status_code = resp.status
    http_details = {
        "url": url,
        "status_code": status_code,
        "response_size": len(raw_bytes),
        "response_snippet": raw[:200],
    }

    result = {}
    for line in raw.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key[2:]
        result[code] = {
            "name": vals[1],
            "price": _safe_float(vals[3]),
            "last_close": _safe_float(vals[4]),
            "open": _safe_float(vals[5]),
            "change_pct": _safe_float(vals[32]),
            "high": _safe_float(vals[33]),
            "low": _safe_float(vals[34]),
            "turnover_pct": _safe_float(vals[38]),
            "pe_ttm": _safe_float(vals[39]),
            "mcap_yi": _safe_float(vals[44]),
            "float_mcap_yi": _safe_float(vals[45]),
            "pb": _safe_float(vals[46]),
            "limit_up": _safe_float(vals[47]),
            "limit_down": _safe_float(vals[48]),
            "pe_static": _safe_float(vals[52]),
        }
    return result, http_details


def _safe_float(val):
    try:
        return float(val) if val else 0
    except (ValueError, TypeError):
        return 0


# ── Standard JSON output ────────────────────────────────────────────
def output_json(success, data=None, error=None, source=None):
    """Standard JSON output for data scripts.

    Any errors recorded via record_error() or calls via record_call() during
    this run are surfaced as top-level `_calls` (all results) and `_errors`
    (failure-only view, backward compat).
    """
    payload = {"success": success}
    if data is not None:
        payload["data"] = data
    if error:
        payload["error"] = error
    if source:
        payload["source"] = source
    if _CALLS:
        payload["_calls"] = list(_CALLS)
        # Backward compat: failure-only view for existing TS code that reads
        # result.errors (commit d3e5d34 added this; we keep it working).
        failed = [c for c in _CALLS if not c["success"]]
        if failed:
            payload["_errors"] = [
                {"stage": c["stage"], "error": c["error"]} for c in failed
            ]
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0 if success else 1)


def normalize_ticker(symbol):
    """Strip exchange prefix/suffix, return pure 6-digit code."""
    s = symbol.strip().upper()
    for suffix in (".SH", ".SZ", ".BJ"):
        if s.endswith(suffix):
            s = s[:-len(suffix)]
            break
    for prefix in ("SH", "SZ", "BJ"):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    return re.sub(r"[^0-9]", "", s)


# ── pywencai natural language query ─────────────────────────────────
def pywencai_query(query, loop=True):
    """Natural language query via pywencai (同花顺问财).

    pywencai is an OPTIONAL dependency — when not installed this returns None
    so callers can graceful-degrade (the rest of the script's data sources keep
    working). Returns list[dict] on success, [] on an empty result, or None on
    import failure / exception (so callers can distinguish "no pywencai" from
    "query returned nothing").

    pywencai.get returns several shapes depending on the query; this normalizes
    DataFrame / list / nested-dict (tableV1|data|result) / None all into a flat
    list[dict].
    """
    start = time.monotonic()
    try:
        import pywencai
    except ImportError:
        record_call("pywencai", success=False, error="pywencai not installed",
                    duration_ms=(time.monotonic() - start) * 1000)
        return None

    try:
        # NOTE: pywencai.get signature is (loop=False, **kwargs) — the query
        # goes through **kwargs as `query=`, NOT as the first positional arg
        # (which would bind to `loop`). aiagents-stock uses get(query=q, loop=True).
        raw = pywencai.get(query=query, loop=loop)
    except Exception as e:
        record_call("pywencai", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return None

    # Unwrap nested dict carriers (pywencai wraps the table under varying keys:
    # tableV1 for tabular queries, news_list1 for news, etc.). Prefer the
    # known keys, then fall back to the first list/DataFrame value found.
    # Carrier value is typically a DataFrame (real usage) but tests stub a list.
    if isinstance(raw, dict):
        unwrapped = False
        for key in ("tableV1", "data", "result"):
            inner = raw.get(key)
            if isinstance(inner, list) or hasattr(inner, "to_dict"):
                raw = inner
                unwrapped = True
                break
        if not unwrapped:
            # Generic fallback: first list/DataFrame value (e.g. news_list1)
            for v in raw.values():
                if isinstance(v, list) and v:
                    raw = v
                    unwrapped = True
                    break
                if hasattr(v, "to_dict"):
                    raw = v
                    unwrapped = True
                    break

    # Empty DataFrame / None → empty list (a valid "no rows" result, not an error)
    if raw is None:
        record_call("pywencai", success=True, error="empty result",
                    duration_ms=(time.monotonic() - start) * 1000)
        return []
    if hasattr(raw, "empty") and raw.empty:
        record_call("pywencai", success=True, error="empty result",
                    duration_ms=(time.monotonic() - start) * 1000)
        return []

    if hasattr(raw, "to_dict"):
        result = raw.to_dict("records")
    elif isinstance(raw, list):
        result = raw
    else:
        result = [raw]

    record_call("pywencai", success=True,
                duration_ms=(time.monotonic() - start) * 1000)
    return result