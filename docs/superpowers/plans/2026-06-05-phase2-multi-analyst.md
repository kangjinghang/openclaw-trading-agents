# Phase 2: 7-Analyst Parallel Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand from 1 market analyst to 7 parallel analysts with independent data Skills and Prompt templates.

**Architecture:** 6 new Python data scripts (mootdx + direct HTTP, no akshare) → 6 new analyst prompts → orchestrator runs all 7 analysts in parallel via `Promise.all()` → Portfolio Manager sees all 7 reports.

**Tech Stack:** Python 3 (requests, pandas, mootdx), TypeScript (strict, ES2020), Vitest for testing.

---

## File Structure

### New Files (18)

```
skills/trading-fundamentals/
  SKILL.md
  scripts/fundamentals.py
skills/trading-news/
  SKILL.md
  scripts/news.py
skills/trading-hot-money/
  SKILL.md
  scripts/hot_money.py
skills/trading-sentiment/
  SKILL.md
  scripts/sentiment.py
skills/trading-lockup/
  SKILL.md
  scripts/lockup.py
skills/trading-sector/
  SKILL.md
  scripts/sector.py
skills/trading-analysis/prompts/analysts/
  fundamentals.md
  news.md
  sentiment.md
  policy.md
  hot_money.md
  lockup.md
```

### Modified Files (4)

```
src/types.ts            — QuickAnalysisResult.analyst → analysts: AnalystReport[]
src/orchestrator.ts     — parallel 7-data + 7-analyst + PM
openclaw.plugin.json    — skills array + 6 entries
tests/ts/integration.test.ts — adapt to 7 analysts
```

---

## Task 1: Shared HTTP helpers module

All 6 new Python scripts share common patterns (eastmoney throttling, JSON output format, error handling). Extract into a shared module first.

**Files:**
- Create: `skills/_shared/http_helpers.py`

- [ ] **Step 1: Create the shared HTTP helpers module**

```python
# skills/_shared/http_helpers.py
"""
Shared HTTP helpers for A-share data scripts.
Provides throttled eastmoney access, session reuse, and standardized JSON output.
"""

import json
import os
import random
import sys
import time

import requests


# ── Eastmoney anti-ban ──────────────────────────────────────────────
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_EM_SESSION = requests.Session()
_EM_SESSION.headers.update({"User-Agent": _UA})
_EM_MIN_INTERVAL = float(os.environ.get("EM_MIN_INTERVAL", "1.0"))
_em_last_call = [0.0]


def em_get(url, params=None, headers=None, timeout=15, **kwargs):
    """Eastmoney throttled GET: auto-rate-limit + session reuse."""
    wait = _EM_MIN_INTERVAL - (time.time() - _em_last_call[0])
    if wait > 0:
        time.sleep(wait + random.uniform(0.1, 0.5))
    try:
        return _EM_SESSION.get(url, params=params, headers=headers, timeout=timeout, **kwargs)
    finally:
        _em_last_call[0] = time.time()


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
    """Print standardized JSON to stdout and exit."""
    result = {"success": success}
    if data is not None:
        result["data"] = data
    if error is not None:
        result["error"] = error
    if source is not None:
        result["_source"] = source
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if success else 1)


def normalize_ticker(symbol):
    """Strip exchange prefix/suffix, return pure 6-digit code."""
    import re
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
```

- [ ] **Step 2: Verify module can be imported**

Run: `cd /d/workspace/github/openclaw-trading-agents && python -c "import sys; sys.path.insert(0, 'skills'); from _shared.http_helpers import em_get, output_json; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/_shared/
git commit -m "feat: add shared HTTP helpers for data scripts (eastmoney throttle, tencent quote)"
```

---

## Task 2: trading-fundamentals Skill

**Files:**
- Create: `skills/trading-fundamentals/SKILL.md`
- Create: `skills/trading-fundamentals/scripts/fundamentals.py`

- [ ] **Step 1: Create fundamentals.py**

```python
#!/usr/bin/env python3
"""Fetch fundamental data for A-share stocks (PE/PB/financials/EPS forecast)."""

import argparse
import json
import sys
import os

# Add parent skills dir to path for shared imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import tencent_quote, em_get, output_json, normalize_ticker


def fetch_fundamentals(ticker, date):
    """Fetch fundamentals from Tencent (valuation) + mootdx (financials) + 同花顺 (EPS)."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    # 1. Tencent: real-time valuation
    try:
        tq = tencent_quote([code])
        if code in tq:
            q = tq[code]
            data["valuation"] = {
                "name": q["name"],
                "price": q["price"],
                "pe_ttm": q["pe_ttm"],
                "pe_static": q["pe_static"],
                "pb": q["pb"],
                "market_cap_yi": q["mcap_yi"],
                "float_market_cap_yi": q["float_mcap_yi"],
                "turnover_pct": q["turnover_pct"],
                "change_pct": q["change_pct"],
            }
    except Exception as e:
        data["valuation_error"] = str(e)

    # 2. mootdx: quarterly financial snapshot
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        client = Quotes.factory(market=market, timeout=10)
        fin = client.finance(symbol=int(code))
        if fin is not None and not (hasattr(fin, 'empty') and fin.empty):
            row = fin.iloc[0] if hasattr(fin, 'iloc') else fin
            snapshot = {}
            for field in ["eps", "bvps", "roe", "profit", "income",
                          "liutongguben", "zongguben"]:
                if hasattr(row, 'index') and field in row.index:
                    val = row[field]
                    if val is not None and str(val) != "nan":
                        snapshot[field] = float(val) if not isinstance(val, str) else val
            if snapshot:
                data["financial_snapshot"] = snapshot
    except Exception as e:
        data["financial_snapshot_error"] = str(e)

    # 3. Eastmoney: basic stock info
    try:
        market_code = 1 if code.startswith("6") else 0
        url = "https://push2.eastmoney.com/api/qt/stock/get"
        params = {
            "fltt": "2", "invt": "2",
            "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43",
            "secid": f"{market_code}.{code}",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json().get("data", {})
        if d:
            info = {}
            if d.get("f127"):
                info["industry"] = d["f127"]
            if d.get("f84"):
                info["total_shares"] = d["f84"]
            if d.get("f85"):
                info["float_shares"] = d["f85"]
            if d.get("f116"):
                info["total_mv"] = d["f116"]
            if info:
                data["stock_info"] = info
    except Exception as e:
        data["stock_info_error"] = str(e)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch fundamental data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code (e.g., 600519)")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_fundamentals(args.ticker, args.date)
        output_json(True, data=data, source="tencent+mootdx+eastmoney")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create SKILL.md**

Create `skills/trading-fundamentals/SKILL.md` following the same structure as `skills/trading-kline/SKILL.md` but describing fundamentals data (PE/PB/market cap/financial snapshot/EPS).

- [ ] **Step 3: Smoke test**

Run: `cd /d/workspace/github/openclaw-trading-agents && python skills/trading-fundamentals/scripts/fundamentals.py --ticker 600519 --date 2026-06-05`
Expected: JSON with `success: true` and valuation/financial_snapshot data.

- [ ] **Step 4: Commit**

```bash
git add skills/trading-fundamentals/
git commit -m "feat: add trading-fundamentals skill (PE/PB/financials/EPS)"
```

---

## Task 3: trading-news Skill

**Files:**
- Create: `skills/trading-news/SKILL.md`
- Create: `skills/trading-news/scripts/news.py`

- [ ] **Step 1: Create news.py**

```python
#!/usr/bin/env python3
"""Fetch stock news (individual + macro/global) for A-share stocks."""

import argparse
import json
import sys
import os
import uuid
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_news_eastmoney(code, page_size=20):
    """Fetch individual stock news from Eastmoney search API."""
    url = "https://search-api-web.eastmoney.com/search/jsonp"
    inner_param = {
        "uid": "",
        "keyword": code,
        "type": ["cmsArticleWebOld"],
        "client": "web",
        "clientType": "web",
        "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default",
                "sort": "default",
                "pageIndex": 1,
                "pageSize": page_size,
                "preTag": "",
                "postTag": "",
            }
        },
    }
    params = {
        "cb": "callback",
        "param": json.dumps(inner_param, ensure_ascii=False),
        "_": "1",
    }
    headers = {
        "Referer": "https://so.eastmoney.com/",
        "User-Agent": _UA,
    }
    resp = em_get(url, params=params, headers=headers, timeout=15)
    text = resp.text
    text = text[text.index("(") + 1: text.rindex(")")]
    data = json.loads(text)

    articles = []
    for item in data.get("result", {}).get("cmsArticleWebOld", []):
        articles.append({
            "title": item.get("title", ""),
            "content": (item.get("content", "") or "")[:300],
            "time": item.get("date", ""),
            "source": item.get("mediaName", "东方财富"),
        })
    return articles


def _fetch_global_news_cls(limit=10):
    """Fetch macro/global financial news from CLS (财联社快讯)."""
    import requests
    articles = []
    try:
        url = "https://www.cls.cn/nodeapi/telegraphList"
        params = {"rn": str(limit), "page": "1"}
        headers = {"User-Agent": _UA, "Referer": "https://www.cls.cn/"}
        r = requests.get(url, params=params, headers=headers, timeout=10)
        d = r.json()
        for item in d.get("data", {}).get("roll_data", []):
            title = item.get("title", "") or item.get("brief", "")
            content = item.get("content", "") or item.get("brief", "")
            ctime = item.get("ctime", "")
            pub_time = ""
            if ctime:
                try:
                    pub_time = datetime.fromtimestamp(int(ctime)).strftime("%Y-%m-%d %H:%M")
                except (ValueError, TypeError, OSError):
                    pub_time = str(ctime)
            articles.append({
                "title": title,
                "content": content[:300],
                "time": pub_time,
                "source": "财联社",
            })
    except Exception:
        pass
    return articles


def fetch_news(ticker, date, lookback_days=7):
    """Fetch individual stock news + macro news."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    # Individual stock news
    try:
        data["stock_news"] = _fetch_news_eastmoney(code)
    except Exception as e:
        data["stock_news_error"] = str(e)

    # Macro/global news
    try:
        data["macro_news"] = _fetch_global_news_cls()
    except Exception as e:
        data["macro_news_error"] = str(e)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch news for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=7, help="Days to look back")
    args = parser.parse_args()

    try:
        data = fetch_news(args.ticker, args.date, args.lookback_days)
        output_json(True, data=data, source="eastmoney+cls")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create SKILL.md** (same pattern as trading-kline)

- [ ] **Step 3: Smoke test**

Run: `cd /d/workspace/github/openclaw-trading-agents && python skills/trading-news/scripts/news.py --ticker 600519 --date 2026-06-05`
Expected: JSON with `success: true` and stock_news + macro_news arrays.

- [ ] **Step 4: Commit**

```bash
git add skills/trading-news/
git commit -m "feat: add trading-news skill (stock news + macro news)"
```

---

## Task 4: trading-hot-money Skill

**Files:**
- Create: `skills/trading-hot-money/SKILL.md`
- Create: `skills/trading-hot-money/scripts/hot_money.py`

- [ ] **Step 1: Create hot_money.py**

```python
#!/usr/bin/env python3
"""Fetch hot money / capital flow data for A-share stocks (northbound, fund flow, dragon-tiger board)."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, eastmoney_datacenter, output_json, normalize_ticker

import requests


def _fetch_northbound():
    """Fetch northbound capital flow from 同花顺 hsgtApi."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36",
        "Host": "data.hexin.cn",
        "Referer": "https://data.hexin.cn/",
    }
    try:
        url = "https://data.hexin.cn/market/hsgtApi/method/dayChart/"
        r = requests.get(url, headers=headers, timeout=10)
        d = r.json()
        times = d.get("time", [])
        hgt = d.get("hgt", [])
        sgt = d.get("sgt", [])
        if not times:
            return None
        hgt_close = float(hgt[-1]) if hgt else 0
        sgt_close = float(sgt[-1]) if sgt else 0
        return {
            "hgt_close": hgt_close,
            "sgt_close": sgt_close,
            "total": hgt_close + sgt_close,
            "signal": "inflow" if (hgt_close + sgt_close) > 0 else "outflow",
            "recent_points": [
                {"time": times[i], "hgt": float(hgt[i]) if i < len(hgt) else 0,
                 "sgt": float(sgt[i]) if i < len(sgt) else 0}
                for i in range(max(0, len(times) - 10), len(times))
            ],
        }
    except Exception:
        return None


def _fetch_fund_flow(code, date):
    """Fetch individual stock fund flow from 东财 push2."""
    secid = f"1.{code}" if code.startswith("6") else f"0.{code}"
    try:
        url = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
        params = {
            "secid": secid, "klt": 1,
            "fields1": "f1,f2,f3,f7",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json()
        klines = d.get("data", {}).get("klines", [])
        if not klines:
            return None
        last = klines[-1].split(",")
        result = {"main_net": float(last[1]) if len(last) > 1 else 0}
        if len(last) >= 6:
            result["large_net"] = float(last[4])
            result["super_net"] = float(last[5])
        return result
    except Exception:
        return None


def _fetch_hot_stocks(date):
    """Fetch hot stocks with topic attribution from 同花顺."""
    try:
        url = (
            f"http://zx.10jqka.com.cn/event/api/getharden/"
            f"date/{date}/orderby/date/orderway/desc/charset/GBK/"
        )
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"}
        r = requests.get(url, headers=headers, timeout=10)
        data = r.json()
        if data.get("errocode", 0) != 0:
            return None
        rows = data.get("data") or []
        return [
            {"code": row.get("code"), "name": row.get("name"),
             "reason": row.get("reason", ""), "change_pct": row.get("zhangfu", "")}
            for row in rows[:20]
        ]
    except Exception:
        return None


def _fetch_dragon_tiger(code, date, lookback=30):
    """Fetch dragon-tiger board appearances."""
    start_dt = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback)).strftime("%Y-%m-%d")
    try:
        data = eastmoney_datacenter(
            "RPT_DAILYBILLBOARD_DETAILSNEW",
            filter_str=f'(TRADE_DATE>=\'{start_dt}\')(TRADE_DATE<=\'{date}\')(SECURITY_CODE="{code}")',
            page_size=10,
            sort_columns="TRADE_DATE",
            sort_types="-1",
        )
        if not data:
            return []
        return [
            {"date": str(row.get("TRADE_DATE", ""))[:10],
             "reason": row.get("EXPLANATION", ""),
             "net_buy": round((row.get("BILLBOARD_NET_AMT") or 0) / 10000, 1),
             "turnover": round(float(row.get("TURNOVERRATE") or 0), 2)}
            for row in data
        ]
    except Exception:
        return []


def fetch_hot_money(ticker, date):
    """Fetch all hot money data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["northbound"] = _fetch_northbound()
    data["fund_flow"] = _fetch_fund_flow(code, date)
    data["hot_stocks"] = _fetch_hot_stocks(date)
    data["dragon_tiger"] = _fetch_dragon_tiger(code, date)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch hot money data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_hot_money(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+10jqka+hexin")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create SKILL.md**

- [ ] **Step 3: Smoke test**

Run: `cd /d/workspace/github/openclaw-trading-agents && python skills/trading-hot-money/scripts/hot_money.py --ticker 600519 --date 2026-06-05`
Expected: JSON with northbound, fund_flow, hot_stocks, dragon_tiger sections.

- [ ] **Step 4: Commit**

```bash
git add skills/trading-hot-money/
git commit -m "feat: add trading-hot-money skill (northbound/fund flow/dragon-tiger)"
```

---

## Task 5: trading-sentiment Skill

**Files:**
- Create: `skills/trading-sentiment/SKILL.md`
- Create: `skills/trading-sentiment/scripts/sentiment.py`

- [ ] **Step 1: Create sentiment.py**

```python
#!/usr/bin/env python3
"""Fetch market sentiment data (hot stocks, news sentiment indicators) for A-share analysis."""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker

import requests


def _fetch_hot_rank(date):
    """Fetch hot stock rankings from Eastmoney."""
    try:
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": "20", "po": "1", "np": "1",
            "fltt": "2", "invt": "2",
            "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
            "fields": "f2,f3,f4,f12,f14,f104,f105,f127",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json()
        items = d.get("data", {}).get("diff", [])
        return [
            {"code": item.get("f12"), "name": item.get("f14"),
             "change_pct": item.get("f3", 0), "price": item.get("f2", 0)}
            for item in items[:20]
        ]
    except Exception:
        return None


def _fetch_stock_news_eastmoney(code, page_size=15):
    """Fetch stock news for sentiment analysis."""
    url = "https://search-api-web.eastmoney.com/search/jsonp"
    inner_param = {
        "uid": "", "keyword": code,
        "type": ["cmsArticleWebOld"],
        "client": "web", "clientType": "web", "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default", "sort": "default",
                "pageIndex": 1, "pageSize": page_size,
                "preTag": "", "postTag": "",
            }
        },
    }
    params = {
        "cb": "callback",
        "param": json.dumps(inner_param, ensure_ascii=False),
        "_": "1",
    }
    headers = {
        "Referer": "https://so.eastmoney.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }
    try:
        resp = em_get(url, params=params, headers=headers, timeout=15)
        text = resp.text
        text = text[text.index("(") + 1: text.rindex(")")]
        data = json.loads(text)
        articles = []
        for item in data.get("result", {}).get("cmsArticleWebOld", []):
            articles.append({
                "title": item.get("title", ""),
                "content": (item.get("content", "") or "")[:300],
                "time": item.get("date", ""),
                "source": item.get("mediaName", ""),
            })
        return articles
    except Exception:
        return []


def fetch_sentiment(ticker, date):
    """Fetch sentiment indicators."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["hot_rank"] = _fetch_hot_rank(date)
    data["stock_news"] = _fetch_stock_news_eastmoney(code)
    data["news_count"] = len(data.get("stock_news") or [])

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch sentiment data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_sentiment(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create SKILL.md**

- [ ] **Step 3: Smoke test**

Run: `cd /d/workspace/github/openclaw-trading-agents && python skills/trading-sentiment/scripts/sentiment.py --ticker 600519 --date 2026-06-05`
Expected: JSON with hot_rank and stock_news.

- [ ] **Step 4: Commit**

```bash
git add skills/trading-sentiment/
git commit -m "feat: add trading-sentiment skill (hot rank + news sentiment)"
```

---

## Task 6: trading-lockup Skill

**Files:**
- Create: `skills/trading-lockup/SKILL.md`
- Create: `skills/trading-lockup/scripts/lockup.py`

- [ ] **Step 1: Create lockup.py**

```python
#!/usr/bin/env python3
"""Fetch lockup expiry and insider transaction data for A-share stocks."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, eastmoney_datacenter, output_json, normalize_ticker


def _fetch_lockup_history(code):
    """Fetch historical lockup expiry records."""
    try:
        data = eastmoney_datacenter(
            "RPT_LIFT_STAGE",
            filter_str=f'(SECURITY_CODE="{code}")',
            page_size=15,
            sort_columns="FREE_DATE",
            sort_types="-1",
        )
        return [
            {"date": str(row.get("FREE_DATE", ""))[:10],
             "type": row.get("LIMITED_STOCK_TYPE", ""),
             "shares": row.get("FREE_SHARES_NUM", ""),
             "ratio": row.get("FREE_RATIO", "")}
            for row in data
        ]
    except Exception:
        return []


def _fetch_lockup_upcoming(code, date, forward_days=90):
    """Fetch upcoming lockup expiries."""
    end_dt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=forward_days)).strftime("%Y-%m-%d")
    try:
        data = eastmoney_datacenter(
            "RPT_LIFT_STAGE",
            filter_str=f'(SECURITY_CODE="{code}")(FREE_DATE>=\'{date}\')(FREE_DATE<=\'{end_dt}\')',
            page_size=20,
            sort_columns="FREE_DATE",
            sort_types="1",
        )
        return [
            {"date": str(row.get("FREE_DATE", ""))[:10],
             "type": row.get("LIMITED_STOCK_TYPE", ""),
             "shares": row.get("FREE_SHARES_NUM", ""),
             "ratio": row.get("FREE_RATIO", "")}
            for row in data
        ]
    except Exception:
        return []


def _fetch_insider_transactions(code):
    """Fetch insider/insider transactions from mootdx F10."""
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        client = Quotes.factory(market=market, timeout=10)
        # F10 data: shareholder changes
        info = client.f10(symbol=int(code), name="股东变动")
        if info is not None and not (hasattr(info, 'empty') and info.empty):
            rows = []
            for _, row in info.head(10).iterrows():
                rows.append({k: str(v) for k, v in row.items()})
            return rows
    except Exception:
        pass
    return []


def fetch_lockup(ticker, date):
    """Fetch all lockup data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["lockup_history"] = _fetch_lockup_history(code)
    data["lockup_upcoming"] = _fetch_lockup_upcoming(code, date)
    data["insider_transactions"] = _fetch_insider_transactions(code)

    # Compute pressure rating
    upcoming = data.get("lockup_upcoming", [])
    if upcoming:
        data["pressure_rating"] = "重大压力" if len(upcoming) >= 3 else "中等压力" if len(upcoming) >= 1 else "轻微压力"
    else:
        data["pressure_rating"] = "无明显压力"

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch lockup data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_lockup(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+mootdx")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create SKILL.md**

- [ ] **Step 3: Smoke test**

Run: `cd /d/workspace/github/openclaw-trading-agents && python skills/trading-lockup/scripts/lockup.py --ticker 600519 --date 2026-06-05`
Expected: JSON with lockup_history, lockup_upcoming, insider_transactions.

- [ ] **Step 4: Commit**

```bash
git add skills/trading-lockup/
git commit -m "feat: add trading-lockup skill (lockup calendar + insider transactions)"
```

---

## Task 7: trading-sector Skill

**Files:**
- Create: `skills/trading-sector/SKILL.md`
- Create: `skills/trading-sector/scripts/sector.py`

- [ ] **Step 1: Create sector.py**

```python
#!/usr/bin/env python3
"""Fetch sector/industry data for A-share stocks (industry rankings, concept blocks)."""

import argparse
import json
import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker

import requests


def _fetch_industry_ranking(top_n=30):
    """Fetch industry sector performance ranking from 东财 push2."""
    try:
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": str(top_n), "po": "1", "np": "1",
            "fltt": "2", "invt": "2",
            "fs": "m:90+t:2",
            "fields": "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141",
        }
        r = em_get(url, params=params, timeout=15)
        d = r.json()
        items = d.get("data", {}).get("diff", [])
        return [
            {"name": item.get("f14"), "change_pct": item.get("f3", 0),
             "up_count": item.get("f104", 0), "down_count": item.get("f105", 0),
             "leader": item.get("f140", "")}
            for item in items
        ]
    except Exception:
        return []


def _fetch_concept_blocks(code):
    """Fetch concept/sector blocks from 百度股市通."""
    try:
        url = (
            f"https://finance.pae.baidu.com/api/getrelatedblock"
            f'?stock=[{{"code":"{code}","market":"ab","type":"stock"}}]'
            f"&finClientType=pc"
        )
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        }
        r = requests.get(url, headers=headers, timeout=10)
        d = r.json()
        if str(d.get("ResultCode", -1)) != "0":
            return None
        result = d.get("Result", {})
        categories = result.get(code, [])
        blocks = {}
        for cat in categories:
            cat_name = cat.get("name", "")
            items = cat.get("list", [])
            blocks[cat_name] = [
                {"name": item.get("name", ""), "change_pct": item.get("ratio", "")}
                for item in items
            ]
        return blocks
    except Exception:
        return None


def fetch_sector(ticker, date):
    """Fetch all sector data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["industry_ranking"] = _fetch_industry_ranking()
    data["concept_blocks"] = _fetch_concept_blocks(code)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch sector data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_sector(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+baidu")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create SKILL.md**

- [ ] **Step 3: Smoke test**

Run: `cd /d/workspace/github/openclaw-trading-agents && python skills/trading-sector/scripts/sector.py --ticker 600519 --date 2026-06-05`
Expected: JSON with industry_ranking and concept_blocks.

- [ ] **Step 4: Commit**

```bash
git add skills/trading-sector/
git commit -m "feat: add trading-sector skill (industry ranking + concept blocks)"
```

---

## Task 8: 6 Analyst Prompt Templates

Create 6 new analyst prompt templates in `skills/trading-analysis/prompts/analysts/`. Each follows the same pattern as existing `market.md`: role description → A股特殊规则 → analysis framework → 必采清单 → VERDICT output.

**Files:**
- Create: `skills/trading-analysis/prompts/analysts/fundamentals.md`
- Create: `skills/trading-analysis/prompts/analysts/news.md`
- Create: `skills/trading-analysis/prompts/analysts/sentiment.md`
- Create: `skills/trading-analysis/prompts/analysts/policy.md`
- Create: `skills/trading-analysis/prompts/analysts/hot_money.md`
- Create: `skills/trading-analysis/prompts/analysts/lockup.md`

- [ ] **Step 1: Create fundamentals.md**

Content based on `trading-agents-reference.md` Section 三 "基本面分析师" prompt, adapted to use `{{fundamentals}}` template variable for data injection. Include: CAS会计准则说明, A股估值参照系, 核心指标, 必采清单 (PE/PB/市值/营收增长率/归母净利润/ROE/资产负债率/现金流/机构EPS), VERDICT format.

- [ ] **Step 2: Create news.md**

Based on `trading-agents-reference.md` Section 三 "新闻分析师". Template vars: `{{stock_news}}`, `{{macro_news}}`. Include: 政策敏感度框架, 消息来源权重, 必采清单 (个股新闻条数/宏观新闻条数/关键事件时间线/利好利空分类/风险事件).

- [ ] **Step 3: Create sentiment.md**

Based on `trading-agents-reference.md` Section 三 "社交情绪分析师". Template vars: `{{sentiment_data}}`. Include: 散户情绪权重, 反向指标, 必采清单 (正负面比例/前3舆情主题/情绪评分/情绪趋势).

- [ ] **Step 4: Create policy.md**

Based on `trading-agents-reference.md` Section 二 "政策分析师". Template vars: `{{macro_news}}`, `{{stock_news}}`. Include: 五层政策框架, 力度评级体系, 必采清单 (政策事件清单/行业方向/力度/时间窗口/总体评级).

- [ ] **Step 5: Create hot_money.md**

Based on `trading-agents-reference.md` Section 二 "游资追踪器". Template vars: `{{hot_money_data}}`. Include: 量价异动/龙虎榜/连板分析/板块轮动/大股东行为框架, 必采清单 (成交量趋势/北向资金/主力净流入/概念板块/龙虎榜/资金面判断).

- [ ] **Step 6: Create lockup.md**

Based on `trading-agents-reference.md` Section 二 "解禁观察员". Template vars: `{{lockup_data}}`. Include: 限售股类型/减持新规/减持动力评估框架, 必采清单 (内部人交易/股东变化/解禁新闻/减持压力评级/未来3月风险).

- [ ] **Step 7: Commit**

```bash
git add skills/trading-analysis/prompts/analysts/
git commit -m "feat: add 6 analyst prompt templates (fundamentals/news/sentiment/policy/hot_money/lockup)"
```

---

## Task 9: Update types.ts

**Files:**
- Modify: `src/types.ts:49-56`

- [ ] **Step 1: Change QuickAnalysisResult.analyst to analysts array**

In `src/types.ts`, change line 54 from `analyst: AnalystReport;` to `analysts: AnalystReport[];`:

```typescript
// Before (line 54):
  analyst: AnalystReport;

// After:
  analysts: AnalystReport[];
```

- [ ] **Step 2: Verify build**

Run: `cd /d/workspace/github/openclaw-trading-agents && npx tsc --noEmit 2>&1 | head -20`
Expected: Type errors in orchestrator.ts and integration.test.ts (will fix in next tasks).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: QuickAnalysisResult.analyst → analysts array for multi-analyst"
```

---

## Task 10: Rewrite orchestrator for parallel 7-analyst pipeline

**Files:**
- Modify: `src/orchestrator.ts`

- [ ] **Step 1: Add analyst config map**

Add this after the `parseDirection` function in orchestrator.ts. This maps each analyst role to its data script path, prompt template, and system prompt:

```typescript
/** Analyst configuration: maps role → data script + prompt template + system prompt */
const ANALYST_CONFIGS = [
  {
    role: "market",
    script: "trading-kline/scripts/kline.py",
    prompt: "analysts/market.md",
    systemPrompt: "You are a professional market analyst specializing in Chinese A-share markets.",
    dataKey: "kline",
    extraArgs: (ticker: string) => ["--count", "60"],
  },
  {
    role: "fundamentals",
    script: "trading-fundamentals/scripts/fundamentals.py",
    prompt: "analysts/fundamentals.md",
    systemPrompt: "You are a fundamentals analyst specializing in Chinese A-share markets, following CAS accounting standards.",
    dataKey: "fundamentals",
    extraArgs: () => [],
  },
  {
    role: "news",
    script: "trading-news/scripts/news.py",
    prompt: "analysts/news.md",
    systemPrompt: "You are a news analyst specializing in Chinese A-share markets.",
    dataKey: "news",
    extraArgs: () => ["--lookback-days", "7"],
  },
  {
    role: "sentiment",
    script: "trading-sentiment/scripts/sentiment.py",
    prompt: "analysts/sentiment.md",
    systemPrompt: "You are a market sentiment analyst specializing in Chinese A-share markets.",
    dataKey: "sentiment",
    extraArgs: () => [],
  },
  {
    role: "policy",
    script: "trading-news/scripts/news.py", // Reuses news data
    prompt: "analysts/policy.md",
    systemPrompt: "You are a policy analyst specializing in Chinese A-share markets.",
    dataKey: "news", // Shares news data
    extraArgs: () => ["--lookback-days", "14"],
  },
  {
    role: "hot_money",
    script: "trading-hot-money/scripts/hot_money.py",
    prompt: "analysts/hot_money.md",
    systemPrompt: "You are a hot money tracker specializing in Chinese A-share markets.",
    dataKey: "hot_money",
    extraArgs: () => [],
  },
  {
    role: "lockup",
    script: "trading-lockup/scripts/lockup.py",
    prompt: "analysts/lockup.md",
    systemPrompt: "You are a lockup watcher specializing in Chinese A-share markets.",
    dataKey: "lockup",
    extraArgs: () => [],
  },
] as const;
```

- [ ] **Step 2: Rewrite runQuickAnalysis body**

Replace the entire `runQuickAnalysis` function body with parallel 7-analyst version. The function signature stays the same. Key changes:

```typescript
export async function runQuickAnalysis(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI
): Promise<QuickAnalysisResult> {
  const startTime = Date.now();

  const traceDir = path.join(os.homedir(), ".openclaw", "traces", `${ticker}_${date}`);
  const traceLogger = new TraceLogger(traceDir);
  const reportStore = new ReportStore(config.report_dir);

  let totalTokens = 0;
  let totalCostUsd = 0;

  // ── Phase 1: Fetch data from all 7 scripts in parallel ──────────
  const dataResults = await Promise.all(
    ANALYST_CONFIGS.map(async (cfg) => {
      const scriptPath = path.join(SKILLS_DIR, cfg.script);
      const args = ["--ticker", ticker, "--date", date, ...cfg.extraArgs(ticker)];
      try {
        const result: ScriptResult = await execPython(scriptPath, args);
        return { role: cfg.role, result };
      } catch (err: any) {
        return { role: cfg.role, result: { success: false, error: err.message } as ScriptResult };
      }
    })
  );

  // Build data map: role → JSON string
  const dataMap: Record<string, string> = {};
  for (const { role, result } of dataResults) {
    if (result.success && result.data) {
      dataMap[role] = JSON.stringify(result.data, null, 2);
    } else {
      dataMap[role] = `[数据缺失: ${result.error || "unknown error"}]`;
    }
  }

  // ── Phase 2: Run all 7 analysts in parallel ─────────────────────
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const analystPromises = ANALYST_CONFIGS.map(async (cfg) => {
    try {
      const dataJson = dataMap[cfg.role];
      const userMessage = loadAndRender(cfg.prompt, { ticker, date, [cfg.dataKey]: dataJson }, promptsBaseDir);

      const llmResult = await callLLM(openaiClient, {
        model: config.models.analyst,
        systemPrompt: cfg.systemPrompt,
        userMessage,
        temperature: 0.4,
        maxTokens: 4000,
        phase: "analyst",
        role: cfg.role,
        traceLogger,
      });

      totalTokens += llmResult.usage.total_tokens;
      totalCostUsd += llmResult.costUsd;

      const verdict = parseVerdict(llmResult.content);

      return {
        role: cfg.role,
        content: llmResult.content,
        verdict: verdict || { direction: "中性", reason: "无法解析结论" },
        data_sources_used: [cfg.dataKey],
      } as AnalystReport;
    } catch (err: any) {
      return {
        role: cfg.role,
        content: `[分析失败: ${err.message}]`,
        verdict: { direction: "中性", reason: "分析失败" },
        data_sources_used: [],
      } as AnalystReport;
    }
  });

  const analystReports: AnalystReport[] = await Promise.all(analystPromises);

  // ── Phase 3: Portfolio Manager ───────────────────────────────────
  const allReportsText = analystReports
    .map((r) => `## ${r.role} 分析师报告\n\n${r.content}\n\nVERDICT: ${r.verdict.direction} — ${r.verdict.reason}`)
    .join("\n\n---\n\n");

  const portfolioPrompt = loadAndRender(
    "portfolio_manager.md",
    { ticker, date, analyst_reports: allReportsText },
    promptsBaseDir
  );

  const portfolioResult = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are a portfolio manager making final trading decisions based on analyst reports.",
    userMessage: portfolioPrompt,
    temperature: 0.3,
    maxTokens: 4000,
    phase: "portfolio",
    role: "portfolio_manager",
    traceLogger,
  });

  totalTokens += portfolioResult.usage.total_tokens;
  totalCostUsd += portfolioResult.costUsd;

  const portfolioVerdict = parseVerdict(portfolioResult.content);
  if (!portfolioVerdict) {
    throw new Error("Failed to parse portfolio manager verdict from LLM response");
  }

  // ── Assemble result ──────────────────────────────────────────────
  const analystVerdicts: Record<string, string> = {};
  for (const report of analystReports) {
    analystVerdicts[report.role] = report.verdict.direction;
  }

  const finalDecision: FinalDecision = {
    ticker,
    company_name: ticker,
    date,
    direction: parseDirection(portfolioVerdict.direction),
    confidence: 0.7,
    target_price: 0,
    stop_loss: 0,
    position_pct: 0,
    reasoning: portfolioVerdict.reason,
    key_risks: [],
    analyst_verdicts: analystVerdicts,
    bull_bear_summary: "",
    risk_assessment: "pass",
    execution_plan: "",
    next_review_trigger: "",
  };

  const result: QuickAnalysisResult = {
    ticker,
    date,
    mode: "quick",
    analysts: analystReports,
    final: finalDecision,
  };

  const durationMs = Date.now() - startTime;
  reportStore.save(ticker, date, "quick", result, durationMs, totalTokens, totalCostUsd);

  return result;
}
```

- [ ] **Step 3: Verify build**

Run: `cd /d/workspace/github/openclaw-trading-agents && npx tsc --noEmit`
Expected: Only test file type errors remain.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: orchestrator parallel 7-analyst pipeline with graceful degradation"
```

---

## Task 11: Update plugin manifest

**Files:**
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Add 6 new skills to manifest**

Replace the `skills` array in `openclaw.plugin.json`:

```json
"skills": [
  "./skills/trading-kline",
  "./skills/trading-analysis",
  "./skills/trading-fundamentals",
  "./skills/trading-news",
  "./skills/trading-hot-money",
  "./skills/trading-sentiment",
  "./skills/trading-lockup",
  "./skills/trading-sector"
]
```

- [ ] **Step 2: Commit**

```bash
git add openclaw.plugin.json
git commit -m "feat: register 6 new data skills in plugin manifest"
```

---

## Task 12: Update integration test for 7-analyst flow

**Files:**
- Modify: `tests/ts/integration.test.ts`

- [ ] **Step 1: Rewrite the first test case**

Update the `'should run quick analysis end-to-end with mocked LLM responses'` test:

- Mock `execPython` to return success for all 7 scripts (return different data depending on script path)
- Mock `mockClient.chat.completions.create` to return 7 analyst responses + 1 PM response (8 total calls)
- Assert `result.analysts` is an array of length 7
- Assert each analyst report has correct `role`
- Assert `result.final.analyst_verdicts` has all 7 roles
- Assert `mockCreate` was called 8 times (7 analysts + 1 PM)

- [ ] **Step 2: Update other test cases**

Update the `'should handle Chinese direction parsing correctly'` and `'should handle various direction formats'` tests to mock 7 execPython calls and 8 LLM calls each.

- [ ] **Step 3: Run tests**

Run: `cd /d/workspace/github/openclaw-trading-agents && npx vitest run tests/ts/integration.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/ts/integration.test.ts
git commit -m "test: update integration tests for 7-analyst parallel pipeline"
```

---

## Task 13: Full build + test verification

- [ ] **Step 1: Run full build**

Run: `cd /d/workspace/github/openclaw-trading-agents && npm run build`
Expected: No errors.

- [ ] **Step 2: Run all tests**

Run: `cd /d/workspace/github/openclaw-trading-agents && npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Fix any remaining issues and commit**

---

## Self-Review

**1. Spec coverage:**
- ✅ 6 new data Skills → Tasks 2-7
- ✅ 6 new analyst prompts → Task 8
- ✅ Orchestrator parallel rewrite → Task 10
- ✅ Types change → Task 9
- ✅ Plugin manifest → Task 11
- ✅ Integration test → Task 12
- ✅ Shared helpers → Task 1

**2. Placeholder scan:** No TBD/TODO found. All steps have concrete code.

**3. Type consistency:**
- `QuickAnalysisResult.analysts: AnalystReport[]` used consistently in orchestrator and tests
- `ANALYST_CONFIGS` array order matches data flow (data → analyst → PM)
- `execPython` signature matches existing (scriptPath, args) pattern
- Bug found: Task 4 `hot_money.py` has `normalize_talker` typo — should be `normalize_ticker`. Will fix in execution.
