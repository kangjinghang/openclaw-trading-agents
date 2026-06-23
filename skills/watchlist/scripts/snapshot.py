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
XUEQIU_COOKIE_TOKEN = os.environ.get("XUEQIU_TOKEN", "XqTestc79726cc9517198fb708bef5c76a6e65c02dfccc")
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


def compute_data_date(stocks_out: dict):
    """从扫描结果算「雪球最新交易日」= max(所有 reason.timestamp ∪ range.end) 转日期。
    全市场扫完后调用，用于命名文件 + 幂等判定 + raw 元信息。
    跳过 scan_error 的失败股。返回 None 表示没抓到任何异动数据（异常，不应写文件）。"""
    max_ms = 0
    for entry in stocks_out.values():
        if entry.get("scan_error"):
            continue
        for r in entry.get("reason_list") or []:
            if r.get("timestamp", 0) > max_ms:
                max_ms = r["timestamp"]
        for rg in entry.get("range_reason_list") or []:
            if rg.get("end", 0) > max_ms:
                max_ms = rg["end"]
    if max_ms == 0:
        return None
    return datetime.fromtimestamp(max_ms / 1000, BEIJING_TZ).strftime("%Y-%m-%d")


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
    scan_target = args.date or datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")  # 仅查询窗口上限
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

    # 查询窗口（传雪球）：基于 scan_target
    q_begin_ms, q_end_ms, _, _ = compute_window(scan_target)

    # 探针：提前发现 token 过期，避免全量扫完才知道
    probe_symbol = stocks_list[0]["symbol"]
    try:
        pr = requests.get(
            XUEQIU_URL,
            params={"symbol": probe_symbol, "begin": q_begin_ms, "end": q_end_ms},
            cookies={"xq_a_token": XUEQIU_COOKIE_TOKEN},
            headers={"user-agent": XUEQIU_UA},
            timeout=15,
        )
        if pr.status_code == 400 and "400016" in pr.text:
            print("error: xq_a_token 已过期，请从浏览器重新复制", file=sys.stderr)
            sys.exit(1)
        pr.raise_for_status()
    except requests.RequestException as e:
        print(f"[snapshot] 探针警告 {probe_symbol}: {e}", file=sys.stderr)

    total = len(stocks_list)
    print(f"[snapshot] 扫描 {total} 股 | 查询日 {scan_target} | 并发 {concurrency}", file=sys.stderr)

    stocks_out = {}
    succeeded = 0
    failed = 0
    completed = 0
    t0 = time.monotonic()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(fetch_one_with_retry, s["symbol"], q_begin_ms, q_end_ms): s
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

    # data_date：从数据现算（命名文件 + 幂等 + raw 元信息的权威）
    data_date = compute_data_date(stocks_out)
    if data_date is None:
        print("error: 未抓到任何异动数据（雪球可能异常或全部失败），不写文件", file=sys.stderr)
        sys.exit(1)

    raw_dir = os.path.join(watchlist_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    out_path = os.path.join(raw_dir, f"{data_date}.json")

    # 幂等：data_date 快照已存在 → 跳过
    if os.path.exists(out_path):
        print(f"[snapshot] {data_date} 已处理，跳过（幂等）", file=sys.stderr)
        return

    # 存储窗口元信息：基于 data_date（自洽）
    begin_ms, end_ms, begin_date, end_date = compute_window(data_date)
    payload = {
        "scan_date": data_date,
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

    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(f"[snapshot] 写入 {out_path} (数据日 {data_date}, 成功 {succeeded}/{total})", file=sys.stderr)


if __name__ == "__main__":
    main()
