"""
Tests for scan_universe.py (network-free: pure functions dedupe + symbol conversion).
"""
import sys
from pathlib import Path

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "watchlist" / "scripts"))

from scan_universe import dedupe_stocks, to_xueqiu_symbol  # noqa: E402


def test_to_xueqiu_symbol_shanghai():
    assert to_xueqiu_symbol("600519") == "SH600519"
    assert to_xueqiu_symbol("688146") == "SH688146"


def test_to_xueqiu_symbol_shenzhen():
    assert to_xueqiu_symbol("000001") == "SZ000001"
    assert to_xueqiu_symbol("300750") == "SZ300750"


def test_dedupe_removes_duplicate_codes():
    stocks = [
        {"code": "600519", "name": "贵州茅台", "f13": 1},
        {"code": "600519", "name": "贵州茅台", "f13": 1},
        {"code": "000001", "name": "平安银行", "f13": 0},
    ]
    result = dedupe_stocks(stocks)
    assert len(result) == 2
    codes = [s["code"] for s in result]
    assert "600519" in codes and "000001" in codes


def test_dedupe_excludes_beijing_exchange():
    stocks = [
        {"code": "600519", "name": "贵州茅台", "f13": 1},
        {"code": "920178", "name": "锐翔智能", "f13": 0},
    ]
    result = dedupe_stocks(stocks)
    codes = [s["code"] for s in result]
    assert "920178" not in codes
    assert len(result) == 1


def test_dedupe_output_has_symbol_field():
    stocks = [{"code": "600519", "name": "贵州茅台", "f13": 1}]
    result = dedupe_stocks(stocks)
    assert result[0]["symbol"] == "SH600519"
