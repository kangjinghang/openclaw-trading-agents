#!/usr/bin/env python3
"""
第0层：全市场 A 股清单刷新。
从 akshare stock_info_a_code_name 获取全量（排除北交所），转雪球 symbol。
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta


def to_xueqiu_symbol(code: str) -> str:
    if code.startswith("6"):
        return "SH" + code
    if code.startswith(("0", "3")):
        return "SZ" + code
    raise ValueError(f"无法识别的代码前缀: {code}")


def dedupe_stocks(raw_items: list) -> list:
    """去重并排除北交所。raw_items: [{"code": "600519", "name": "..."}]"""
    seen = set()
    result = []
    for it in raw_items:
        code = str(it.get("code", ""))
        if code.startswith(("8", "9", "4")):
            continue
        if code in seen or not code:
            continue
        seen.add(code)
        try:
            symbol = to_xueqiu_symbol(code)
        except ValueError:
            continue
        result.append({
            "code": code,
            "symbol": symbol,
            "name": str(it.get("name", "")).strip(),
        })
    return result


def fetch_all() -> list:
    import akshare as ak
    df = ak.stock_info_a_code_name()
    result = []
    for _, row in df.iterrows():
        code = str(row["code"]).strip()
        name = str(row["name"]).strip()
        if code.startswith(("8", "9", "4")):
            continue
        result.append({"code": code, "name": name})
    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="刷新全市场 A 股清单")
    parser.add_argument(
        "--watchlist-dir",
        default=os.path.expanduser("~/.openclaw/watchlist"),
        help="存储目录",
    )
    args = parser.parse_args()

    out_path = os.path.join(args.watchlist_dir, "universe.json")

    print(f"[universe] 从 akshare 获取全量...", file=sys.stderr)
    t0 = time.monotonic()
    raw = fetch_all()
    elapsed = time.monotonic() - t0
    print(f"[universe] 原始 {len(raw)} 条 ({elapsed:.1f}s)", file=sys.stderr)

    stocks = dedupe_stocks(raw)
    print(f"[universe] 排除北交所后 {len(stocks)} 条", file=sys.stderr)

    tz = timezone(timedelta(hours=8))
    payload = {
        "updated_at": datetime.now(tz).isoformat(timespec="seconds"),
        "source": "akshare stock_info_a_code_name",
        "total": len(stocks),
        "stocks": stocks,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)
    print(f"[universe] 写入 {out_path} ({len(stocks)} 股)", file=sys.stderr)


if __name__ == "__main__":
    main()
