#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""雪球「AI 异常涨跌原因」接口探针（最小化版本）。

接口：GET https://xueqiu.com/rainbow/ai/abnormal/reasons.json
作用：返回某只股票在指定时间区间内的「异常涨跌日 + AI 归因原因」列表，
      可作为股票池异动扫描的信号源。

最小必需请求（经裁剪实验验证，见 probe_xueqiu_min.py 历史）：
  Query:  symbol=<SH/SZ/BK 前缀的代码>  begin=<ms>  end=<ms>
  Header: Cookie: xq_a_token=<登录态 token>
          User-Agent: <任意浏览器 UA>
其余（md5__1038 埋点、xqat/xq_r_token/xq_id_token、Referer、X-Requested-With、
sec-ch-ua 等）均可省略。

鉴权：xq_a_token 来自浏览器登录后的 cookie，会过期（JWT exp 约 30 天）。
      过期时返回 HTTP 400 error_code=400016，需重新从浏览器复制。
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

URL = "https://xueqiu.com/rainbow/ai/abnormal/reasons.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

# token 来源优先级：命令行 --token > 环境变量 XQ_A_TOKEN
DEFAULT_TOKEN = os.environ.get("XQ_A_TOKEN", "")


def fetch_abnormal_reasons(symbol: str, token: str, days: int = 90) -> dict:
    """拉取某股票近 N 天的异常涨跌原因。

    Args:
        symbol: 带交易所前缀的代码，如 SH688146、SZ000001
        token:  xq_a_token 登录态
        days:   回溯天数（默认 90 天）

    Returns:
        接口原始 JSON（dict）。失败时抛异常。
    """
    end_ms = int(time.time() * 1000)
    begin_ms = end_ms - days * 86_400_000
    query = f"symbol={symbol}&begin={begin_ms}&end={end_ms}"
    headers = {"Cookie": f"xq_a_token={token}", "User-Agent": UA}
    req = urllib.request.Request(f"{URL}?{query}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 400 and "400016" in body:
            raise RuntimeError("xq_a_token 已过期，请重新从浏览器复制") from None
        raise RuntimeError(f"HTTP {e.code}: {body[:200]}") from None


def main():
    ap = argparse.ArgumentParser(description="雪球异常涨跌原因探针（最小化）")
    ap.add_argument("--symbol", default="SH688146", help="带前缀代码，如 SH688146")
    ap.add_argument("--token", default=DEFAULT_TOKEN, help="xq_a_token（或设环境变量 XQ_A_TOKEN）")
    ap.add_argument("--days", type=int, default=90, help="回溯天数，默认 90")
    args = ap.parse_args()

    if not args.token:
        print("错误：缺少 token。请用 --token 传入，或设置环境变量 XQ_A_TOKEN", file=sys.stderr)
        sys.exit(2)

    try:
        data = fetch_abnormal_reasons(args.symbol, args.token, args.days)
    except Exception as e:
        print(f"失败：{e}", file=sys.stderr)
        sys.exit(1)

    reasons = (data.get("data") or {}).get("reason_list") or []
    print(f"symbol={args.symbol} 近{args.days}天共 {len(reasons)} 条异动：\n")
    for r in reasons:
        ts = time.strftime("%Y-%m-%d", time.localtime(r["timestamp"] / 1000))
        print(f"[{ts}] {r.get('description', '')}")
        print(f"  原因：{r.get('reason', '')}\n")


if __name__ == "__main__":
    main()
