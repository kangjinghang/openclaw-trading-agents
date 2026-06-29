"""hot_money.py 板块资金流 iwencai 主源测试。

验证 _fetch_sector_fund_flow 的双向语义 + 兜底逻辑：
  1. iwencai 主源：流入 top（正）+ 流出 top（负）分别查询，正确合并
  2. 主源空/失败 → akshare 兜底
  3. 字段映射（主力净买入额 元→亿 /1e8，涨跌幅提取）

全 mock 网络，无真实流量。
"""

import sys
from pathlib import Path
from unittest import mock

import pytest

shared_dir = Path(__file__).parent.parent.parent / "skills" / "_shared"
sys.path.insert(0, str(shared_dir))
hot_money_dir = Path(__file__).parent.parent.parent / "skills" / "trading-hot-money" / "scripts"
sys.path.insert(0, str(hot_money_dir))


def _iw_board(name, net_yuan, chg_pct):
    """构造 iwencai select_sector 返回的单行（带日期后缀的 key）。"""
    return {
        "指数代码": "884244.TI",
        "指数简称": name,
        "最新涨跌幅:前复权": chg_pct,
        "主力净买入额[20260629]": net_yuan,
    }


def test_sector_fund_flow_iwencai_inflow_positive_outflow_negative():
    """iwencai 主源：流入 top 正 + 流出 top 负，双向语义正确。"""
    import hot_money
    # 第一次查询（流入）返回正数，第二次（流出）返回负数
    inflow_data = [_iw_board("半导体", 11235885000.0, 2.73), _iw_board("芯片", 6630956000.0, 0.91)]
    outflow_data = [_iw_board("光学光电子", -5341352800.0, -1.68), _iw_board("通信", -4998457000.0, -3.02)]

    with mock.patch.object(hot_money, "get_iwencai_client") as gi:
        gi.return_value.select_sector.side_effect = [
            (inflow_data, 2, False),   # 第一次调用（流入查询）
            (outflow_data, 2, False),  # 第二次调用（流出查询）
        ]
        result, source = hot_money._fetch_sector_fund_flow(top_n=5)

    assert source == "iwencai"
    assert result["total_boards"] == 4
    # 流入全正
    assert all(b["main_net_yi"] > 0 for b in result["inflow_top"])
    assert result["inflow_top"][0]["name"] == "半导体"
    assert result["inflow_top"][0]["main_net_yi"] == 112.36  # 元→亿
    # 流出全负
    assert all(b["main_net_yi"] < 0 for b in result["outflow_top"])
    assert result["outflow_top"][0]["name"] == "光学光电子"
    assert result["outflow_top"][0]["main_net_yi"] == -53.41


def test_sector_fund_flow_iwencai_empty_falls_back_to_akshare():
    """iwencai 主源空（流入流出都空）→ 走 akshare 兜底。"""
    import hot_money
    ak_result = {
        "inflow_top": [{"name": "半导体", "change_pct": 2.0, "main_net_yi": 100.0, "super_net_yi": 0}],
        "outflow_top": [{"name": "地产", "change_pct": -1.0, "main_net_yi": -50.0, "super_net_yi": 0}],
        "total_boards": 2,
    }
    with mock.patch.object(hot_money, "get_iwencai_client") as gi, \
         mock.patch.object(hot_money, "_fetch_sector_fund_flow_akshare", return_value=ak_result) as ga:
        gi.return_value.select_sector.side_effect = [([], 0, False), ([], 0, False)]
        result, source = hot_money._fetch_sector_fund_flow(top_n=5)

    assert source == "akshare"
    assert result == ak_result
    ga.assert_called_once()


def test_sector_fund_flow_both_empty_returns_none():
    """iwencai 空 + akshare 也空 → result=None, source=none。"""
    import hot_money
    with mock.patch.object(hot_money, "get_iwencai_client") as gi, \
         mock.patch.object(hot_money, "_fetch_sector_fund_flow_akshare", return_value=None) as ga:
        gi.return_value.select_sector.side_effect = [([], 0, False), ([], 0, False)]
        result, source = hot_money._fetch_sector_fund_flow(top_n=5)

    assert result is None
    assert source == "none"


def test_sector_fund_flow_iwencai_only_inflow_returns_partial():
    """iwencai 只有流入、流出空 → 仍算主源命中（partial），不走兜底。"""
    import hot_money
    inflow_data = [_iw_board("半导体", 11235885000.0, 2.73)]
    with mock.patch.object(hot_money, "get_iwencai_client") as gi, \
         mock.patch.object(hot_money, "_fetch_sector_fund_flow_akshare") as ga:
        gi.return_value.select_sector.side_effect = [
            (inflow_data, 1, False),  # 流入有数据
            ([], 0, False),           # 流出空
        ]
        result, source = hot_money._fetch_sector_fund_flow(top_n=5)

    assert source == "iwencai"  # 有流入就算主源命中
    assert len(result["inflow_top"]) == 1
    assert result["outflow_top"] == []
    ga.assert_not_called()
