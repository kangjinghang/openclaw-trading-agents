"""
Tests for snapshot.py (network-free: window calc + single-stock parse).
"""
import sys
from pathlib import Path

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "watchlist" / "scripts"))

from snapshot import compute_window, parse_xueqiu_response  # noqa: E402


def test_compute_window_end_is_today_2359():
    begin_ms, end_ms, begin_date, end_date = compute_window("2026-06-17")
    assert end_date == "2026-06-17"
    assert begin_date < "2025-06-17"
    assert begin_ms < end_ms


def test_compute_window_begin_is_14_months_back():
    begin_ms, end_ms, begin_date, end_date = compute_window("2026-06-17")
    assert begin_date.startswith("2025-04")


def test_parse_xueqiu_response_normal():
    raw = {
        "code": 200,
        "data": {
            "reason_list": [{"timestamp": 1000, "reason": "a", "description": "d"}],
            "range_reason_list": [{"begin": 1, "end": 2, "type": "LONG", "percent": 50, "summary": "s", "points": "p"}],
        },
    }
    result = parse_xueqiu_response(raw)
    assert result["reason_list"] == raw["data"]["reason_list"]
    assert result["range_reason_list"] == raw["data"]["range_reason_list"]


def test_parse_xueqiu_response_empty_lists():
    raw = {"code": 200, "data": {"reason_list": [], "range_reason_list": []}}
    result = parse_xueqiu_response(raw)
    assert result["reason_list"] == []
    assert result["range_reason_list"] == []


def test_parse_xueqiu_response_missing_fields():
    raw = {"code": 200, "data": {}}
    result = parse_xueqiu_response(raw)
    assert result["reason_list"] == []
    assert result["range_reason_list"] == []
