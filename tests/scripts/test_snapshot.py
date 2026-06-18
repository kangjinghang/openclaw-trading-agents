"""
Tests for snapshot.py (network-free: window calc + single-stock parse).
"""
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "watchlist" / "scripts"))

from snapshot import compute_window, parse_xueqiu_response, compute_data_date  # noqa: E402


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


BEIJING_TZ = timezone(timedelta(hours=8))


def _day_ms(date_str):
    """某天 00:00:00 北京时间的毫秒时间戳，用于构造测试数据。"""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=BEIJING_TZ)
    return int(dt.timestamp() * 1000)


def test_compute_data_date_max_of_timestamps_and_ends():
    stocks = {
        "A": {"reason_list": [{"timestamp": 1000}], "range_reason_list": [{"end": 2000}]},
        "B": {"reason_list": [{"timestamp": 5000}], "range_reason_list": []},
    }
    # max = 5000（B 的 reason timestamp）
    assert compute_data_date(stocks) == datetime.fromtimestamp(5, BEIJING_TZ).strftime("%Y-%m-%d")


def test_compute_data_date_skips_scan_error():
    stocks = {
        "A": {"reason_list": [{"timestamp": 3000}]},
        "B": {"scan_error": "timeout"},  # 失败股跳过
    }
    assert compute_data_date(stocks) == datetime.fromtimestamp(3, BEIJING_TZ).strftime("%Y-%m-%d")


def test_compute_data_date_returns_none_when_empty():
    assert compute_data_date({}) is None
    assert compute_data_date({"A": {"scan_error": "x"}}) is None


def test_compute_data_date_picks_range_end_when_larger():
    stocks = {
        "A": {"reason_list": [{"timestamp": _day_ms("2026-06-16")}],
              "range_reason_list": [{"end": _day_ms("2026-06-17")}]},
    }
    # range.end (06-17) > reason.timestamp (06-16) → 取 06-17
    assert compute_data_date(stocks) == "2026-06-17"


def test_main_idempotent_skips_when_data_date_exists(tmp_path, monkeypatch, capsys):
    """盘中跑(06-18)但雪球数据还是 06-17 → data_date=06-17，
    若 06-17 快照已存在 → 跳过，不写 06-18.json。"""
    import json
    import snapshot

    watchlist = tmp_path / "watchlist"
    raw_dir = watchlist / "raw"
    raw_dir.mkdir(parents=True)
    (watchlist / "universe.json").write_text(
        json.dumps({"stocks": [{"symbol": "SH600519", "name": "贵州茅台"}]}),
        encoding="utf-8",
    )
    # 假装 06-17 已处理
    (raw_dir / "2026-06-17.json").write_text("{}", encoding="utf-8")

    # mock 网络：返回的数据最新日 = 06-17（雪球还没出 06-18）
    def fake_fetch(symbol, begin_ms, end_ms):
        return symbol, {"reason_list": [{"timestamp": _day_ms("2026-06-17")}], "range_reason_list": []}
    monkeypatch.setattr(snapshot, "fetch_one_with_retry", fake_fetch)

    monkeypatch.setattr("sys.argv", [
        "snapshot.py", "--watchlist-dir", str(watchlist), "--date", "2026-06-18",
    ])
    snapshot.main()

    assert not (raw_dir / "2026-06-18.json").exists()  # 没写新文件
    assert "跳过" in capsys.readouterr().err


def test_main_writes_data_date_named_file_when_new(tmp_path, monkeypatch):
    """盘后跑(06-18)，雪球出了 06-18 数据 → data_date=06-18，文件不存在 → 写 raw/2026-06-18.json。"""
    import json
    import snapshot

    watchlist = tmp_path / "watchlist"
    raw_dir = watchlist / "raw"
    raw_dir.mkdir(parents=True)
    (watchlist / "universe.json").write_text(
        json.dumps({"stocks": [{"symbol": "SH600519", "name": "贵州茅台"}]}),
        encoding="utf-8",
    )

    def fake_fetch(symbol, begin_ms, end_ms):
        return symbol, {"reason_list": [{"timestamp": _day_ms("2026-06-18")}], "range_reason_list": []}
    monkeypatch.setattr(snapshot, "fetch_one_with_retry", fake_fetch)

    monkeypatch.setattr("sys.argv", [
        "snapshot.py", "--watchlist-dir", str(watchlist), "--date", "2026-06-18",
    ])
    snapshot.main()

    out = raw_dir / "2026-06-18.json"
    assert out.exists()
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["scan_date"] == "2026-06-18"   # 文件名 + scan_date = data_date
    assert payload["end_date"] == "2026-06-18"
