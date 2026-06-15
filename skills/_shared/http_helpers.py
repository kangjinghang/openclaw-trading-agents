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


# ── Whole-source error collector ─────────────────────────────────────
# Scripts accumulate non-fatal errors here (e.g. a secondary data source that
# failed but didn't break the whole fetch). output_json() surfaces them as a
# top-level `_errors` array so a silent source outage is observable downstream
# instead of masquerading as "no data". Per-record parse failures inside loops
# should NOT use this — only whole-source/sub-source failures.
_ERRORS = []


def record_error(stage, msg):
    """Record a whole-source/sub-source failure (non-fatal).

    Args:
        stage: short label identifying which fetch failed (e.g. "macro_cls",
               "dragon_tiger_ths"). Truncated to 40 chars.
        msg: the error message. Truncated to 160 chars.
    """
    _ERRORS.append({"stage": str(stage)[:40], "error": str(msg)[:160]})


def get_errors():
    """Return accumulated errors (does not clear)."""
    return list(_ERRORS)


def clear_errors():
    """Clear accumulated errors. Call at the start of each fetch if reusing
    the process across runs (tests do this)."""
    del _ERRORS[:]


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
    """Eastmoney Datacenter unified query (shared by dragon-tiger, lockup, etc.)."""
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
    d = r.json()
    if d.get("result") and d["result"].get("data"):
        return d["result"]["data"]
    return []


# ── Tencent real-time quote ─────────────────────────────────────────
def tencent_quote(codes):
    """Batch real-time quotes from Tencent Finance (qt.gtimg.cn).
    codes: list of 6-digit strings. Returns dict[code] -> {name, price, pe_ttm, pb, ...}
    """
    import urllib.request

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
    raw = resp.read().decode("gbk")

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
    return result


def _safe_float(val):
    try:
        return float(val) if val else 0
    except (ValueError, TypeError):
        return 0


# ── Standard JSON output ────────────────────────────────────────────
def output_json(success, data=None, error=None, source=None):
    """Print standardized JSON to stdout and exit.

    Any errors recorded via record_error() during this run are surfaced as a
    top-level `_errors` array (only when non-empty), so a non-fatal source
    failure is visible to the caller without affecting the `success` flag.
    """
    result = {"success": success}
    if data is not None:
        result["data"] = data
    if error is not None:
        result["error"] = error
    if source is not None:
        result["_source"] = source
    if _ERRORS:
        result["_errors"] = get_errors()
    print(json.dumps(result, ensure_ascii=False))
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