#!/usr/bin/env python3
"""
第1层：全市场雪球异动快照。
并发扫描 universe.json 里的所有股票，每股存完整 reason_list + range_reason_list。
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from dateutil.relativedelta import relativedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

XUEQIU_URL = "https://xueqiu.com/rainbow/ai/abnormal/reasons.json"
XUEQIU_COOKIE_TOKEN = "XqTest6f8800ddb9f1e382c937c39fa0ea7f2c4149a3ea"
XUEQIU_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
BEIJING_TZ = timezone(timedelta(hours=8))
WINDOW_MONTHS = 14


def compute_window(scan_date: str):
    end_dt = datetime.strptime(scan_date, "%Y-%m-%d").replace(
        hour=23, minute=59, second=59, tzinfo=BEIJING_TZ)
    end_ms = int(end_dt.timestamp() * 1000)

    end_date = datetime.strptime(scan_date, "%Y-%m-%d").replace(tzinfo=BEIJING_TZ)
    begin_dt = end_date - relativedelta(months=WINDOW_MONTHS)
    begin_dt = begin_dt.replace(hour=0, minute=0, second=0)
    begin_ms = int(begin_dt.timestamp() * 1000)
    begin_date = begin_dt.strftime("%Y-%m-%d")

    return begin_ms, end_ms, begin_date, scan_date


def parse_xueqiu_response(raw: dict) -> dict:
    data = raw.get("data", {}) or {}
    return {
        "reason_list": data.get("reason_list", []) or [],
        "range_reason_list": data.get("range_reason_list", []) or [],
    }


def fetch_one(symbol: str, begin_ms: int, end_ms: int, timeout: int = 15):
    start = time.monotonic()
    try:
        r = requests.get(
            XUEQIU_URL,
            params={"symbol": symbol, "begin": begin_ms, "end": end_ms},
            cookies={"xq_a_token": XUEQIU_COOKIE_TOKEN},
            headers={"user-agent": XUEQIU_UA},
            timeout=timeout,
        )
        r.raise_for_status()
        raw = r.json()
        duration = (time.monotonic() - start) * 1000
        if raw.get("code") != 200:
            return symbol, {"scan_error": f"xueqiu code={raw.get('code')}", "duration_ms": duration}
        parsed = parse_xueqiu_response(raw)
        parsed["duration_ms"] = duration
        return symbol, parsed
    except Exception as e:
        duration = (time.monotonic() - start) * 1000
        return symbol, {"scan_error": f"{type(e).__name__}: {str(e)[:120]}", "duration_ms": duration}


def fetch_one_with_retry(symbol: str, begin_ms: int, end_ms: int):
    symbol, result = fetch_one(symbol, begin_ms, end_ms)
    if "scan_error" in result:
        symbol, result = fetch_one(symbol, begin_ms, end_ms)
    result.pop("duration_ms", None)
    return symbol, result


def main():
    parser = argparse.ArgumentParser(description="全市场雪球异动快照")
    parser.add_argument("--date", default=None, help="扫描日 YYYY-MM-DD（默认今天）")
    parser.add_argument("--concurrency", type=int, default=3, help="并发数（默认 3，范围 1-5）")
    parser.add_argument("--watchlist-dir", default=None, help="存储目录")
    parser.add_argument("--limit", type=int, default=None, help="只扫前 N 只（调试用）")
    args = parser.parse_args()

    watchlist_dir = args.watchlist_dir or os.path.expanduser("~/.openclaw/watchlist")
    today = args.date or datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    concurrency = max(1, min(5, args.concurrency))

    universe_path = os.path.join(watchlist_dir, "universe.json")
    if not os.path.exists(universe_path):
        print(f"error: universe.json 不存在，请先运行 scan_universe", file=sys.stderr)
        sys.exit(1)
    with open(universe_path, encoding="utf-8") as f:
        universe = json.load(f)
    stocks_list = universe["stocks"]
    if args.limit:
        stocks_list = stocks_list[:args.limit]

    total = len(stocks_list)
    begin_ms, end_ms, begin_date, end_date = compute_window(today)
    print(f"[snapshot] 扫描 {total} 股 | 窗口 {begin_date}~{end_date} | 并发 {concurrency}", file=sys.stderr)

    stocks_out = {}
    succeeded = 0
    failed = 0
    completed = 0
    t0 = time.monotonic()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(fetch_one_with_retry, s["symbol"], begin_ms, end_ms): s
            for s in stocks_list
        }
        for future in as_completed(futures):
            stock = futures[future]
            symbol, result = future.result()
            name = stock.get("name", "")
            entry = {"name": name, **result}
            stocks_out[symbol] = entry
            if "scan_error" in result:
                failed += 1
            else:
                succeeded += 1
            completed += 1
            if completed % 100 == 0 or completed == total:
                elapsed = time.monotonic() - t0
                rate = completed / elapsed if elapsed > 0 else 0
                eta = (total - completed) / rate if rate > 0 else 0
                print(f"[snapshot] {completed}/{total} (成功 {succeeded}, 失败 {failed}) "
                      f"| {elapsed:.0f}s 已用, ~{eta:.0f}s 剩余", file=sys.stderr)

    payload = {
        "scan_date": today,
        "begin_ms": begin_ms,
        "end_ms": end_ms,
        "begin_date": begin_date,
        "end_date": end_date,
        "window_months": WINDOW_MONTHS,
        "scanned": total,
        "succeeded": succeeded,
        "failed": failed,
        "stocks": stocks_out,
    }

    raw_dir = os.path.join(watchlist_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    out_path = os.path.join(raw_dir, f"{today}.json")
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(f"[snapshot] 写入 {out_path} (成功 {succeeded}/{total})", file=sys.stderr)


if __name__ == "__main__":
    main()
