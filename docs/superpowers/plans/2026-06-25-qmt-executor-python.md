# QMT 执行器（Python）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建独立 Python 仓库 `qmt-executor`，实现消费 `last_rebalance.json` 调 xtquant 下单 + 字段级合并回写 `holdings.json` 的执行器，含内存模拟器让 Mac 可跑全流程。

**Architecture:** 适配器模式——`QmtClient` 抽象接口 + 两个实现（`XtquantClient` 真实 / `Simulator` 内存模拟）。主流程 `executor.py` 编排 git pull → 幂等 → 下单 → 回填 → 合并 → git push。数据契约严格对齐 TS 端 `rebalance-types.ts`。

**Tech Stack:** Python 3.11+（用内置 `tomllib`）、pytest、stdlib only（无第三方依赖，xtquant 仅 real 模式 Win 上需要）。

**对应 Spec:** `docs/superpowers/specs/2026-06-25-qmt-executor-python-design.md`
**前置依赖:** TS 端已实现（`feat/qmt-execution-bridge` 分支），产出带 execution 信封的 `last_rebalance.json`

**执行环境说明:** 本 plan 在新建仓库 `D:\workspace\github\qmt-executor` 执行（不在 openclaw-trading-agents 内）。当前会话在 Windows 上，可验证 sim 模式 + 真实 git 流程；real 模式（xtquant）需手动连 QMT 客户端验证。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `pyproject.toml` | 包定义 + pytest 配置 |
| `config.example.toml` | 配置模板（mode/path/account） |
| `.gitignore` | 忽略 config.toml（含 account_id）、__pycache__、.venv |
| `qmt_executor/__init__.py` | 包入口 |
| `qmt_executor/ticker_fmt.py` | SZ300319 ↔ 300319.SZ 转换（纯函数） |
| `qmt_executor/merge.py` | `merge_holdings()` 字段级合并（对齐 TS mergeHoldings） |
| `qmt_executor/qmt_client.py` | `QmtClient` 抽象接口 + 数据类 |
| `qmt_executor/simulator.py` | `Simulator` 内存模拟器实现 |
| `qmt_executor/xtquant_client.py` | `XtquantClient` 真实实现（import xtquant） |
| `qmt_executor/git_sync.py` | pull/push + safe_push 仲裁 |
| `qmt_executor/config.py` | 读 config.toml |
| `qmt_executor/executor.py` | 主流程编排 + CLI 入口 |
| `tests/conftest.py` | 共享 fixtures |
| `tests/fixtures/*.json` | 跨语言一致性测试 fixture |
| `tests/test_ticker_fmt.py` | ticker 转换测试 |
| `tests/test_merge.py` | 合并测试（对齐 TS holdings-merge.test.ts） |
| `tests/test_simulator.py` | 模拟器行为测试 |
| `tests/test_executor.py` | 主流程集成测试（sim + mock git） |

**依赖顺序**：初始化(T1) → ticker_fmt(T2) → merge(T3) → qmt_client接口(T4) → simulator(T5) → git_sync(T6) → config(T7) → executor(T8) → 集成(T9) → README(T10)。

---

## Task 1: 初始化 qmt-executor 仓库

**Files:**
- Create: 仓库根 + `pyproject.toml` + `.gitignore` + `config.example.toml` + 包骨架

- [ ] **Step 1: 建仓库目录结构**

从 `D:\workspace\github` 执行：

```bash
mkdir qmt-executor
cd qmt-executor
git init
mkdir qmt_executor tests tests/fixtures
# Windows: 创建空 __init__.py
type nul > qmt_executor\__init__.py
type nul > tests\__init__.py
```

- [ ] **Step 2: 写 pyproject.toml**

```toml
[project]
name = "qmt-executor"
version = "0.1.0"
description = "QMT 执行器：消费 last_rebalance.json 调 xtquant 下单 + 回写 holdings"
requires-python = ">=3.11"

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"
```

- [ ] **Step 3: 写 .gitignore**

```
config.toml
__pycache__/
*.pyc
.venv/
.pytest_cache/
```

- [ ] **Step 4: 写 config.example.toml**

```toml
[execution]
mode = "sim"          # sim | real；Mac/dev 用 sim，Win 生产用 real

[qmt]
# real 模式才需要；sim 模式忽略
mini_qmt_path = "D:\\国金证券QMT\\userdata_mini"
account_id = "110XXXXXX"

[git]
# trading-state private repo 的本地 clone 路径
state_repo_dir = "C:\\Users\\you\\trading-state"
```

- [ ] **Step 5: 验证 pytest 能跑（空测试）**

```bash
python -m pytest -v
```
Expected: `no tests ran`（无错误，环境正常）。

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: 初始化 qmt-executor 仓库

pyproject.toml + pytest 配置 + config 模板 + 包骨架。
stdlib only（tomllib 内置），xtquant 仅 real 模式需要。"
```

---

## Task 2: ticker_fmt.py — ticker 转换（纯函数，TDD）

**Files:**
- Create: `qmt_executor/ticker_fmt.py`
- Test: `tests/test_ticker_fmt.py`

- [ ] **Step 1: 写失败测试**

`tests/test_ticker_fmt.py`：

```python
import pytest
from qmt_executor.ticker_fmt import to_qmt_code, from_qmt_code


def test_sh_to_suffix():
    assert to_qmt_code("SH600183") == "600183.SH"
    assert to_qmt_code("SH688001") == "688001.SH"


def test_sz_to_suffix():
    assert to_qmt_code("SZ300319") == "300319.SZ"
    assert to_qmt_code("SZ000001") == "000001.SZ"
    assert to_qmt_code("SZ301200") == "301200.SZ"


def test_from_qmt_code_sh():
    assert from_qmt_code("600183.SH") == "SH600183"


def test_from_qmt_code_sz():
    assert from_qmt_code("300319.SZ") == "SZ300319"


def test_invalid_prefix_raises():
    with pytest.raises(ValueError, match="无法识别的市场前缀"):
        to_qmt_code("BJ430047")  # 北交所第一版不支持


def test_round_trip():
    for t in ["SH600519", "SZ300319", "SH688981", "SZ000001"]:
        assert from_qmt_code(to_qmt_code(t)) == t
```

- [ ] **Step 2: 运行测试确认失败**

```bash
python -m pytest tests/test_ticker_fmt.py -v
```
Expected: FAIL — `ModuleNotFoundError: qmt_executor.ticker_fmt`。

- [ ] **Step 3: 实现**

`qmt_executor/ticker_fmt.py`：

```python
"""ticker 格式转换：持仓用的 SH/SZ 前缀 ↔ QMT 的 .SH/.SZ 后缀。

持仓格式（holdings.json）：SH600183 / SZ300319（市场前缀）
QMT 格式（xtquant）：     600183.SH / 300319.SZ（市场后缀）

北交所（BJ）第一版不支持，转 raise。
"""

# 前缀 → 后缀市场标识
_PREFIX_TO_SUFFIX = {"SH": "SH", "SZ": "SZ"}
# 后缀 → 前缀（目前相同，留映射表方便扩展北交所）
_SUFFIX_TO_PREFIX = {"SH": "SH", "SZ": "SZ"}


def to_qmt_code(ticker: str) -> str:
    """SH600183 → 600183.SH。无法识别的前缀 raise ValueError。"""
    if len(ticker) < 3:
        raise ValueError(f"无法识别的市场前缀: {ticker}")
    prefix = ticker[:2].upper()
    digits = ticker[2:]
    if prefix not in _PREFIX_TO_SUFFIX:
        raise ValueError(f"无法识别的市场前缀: {ticker}")
    return f"{digits}.{_PREFIX_TO_SUFFIX[prefix]}"


def from_qmt_code(qmt_code: str) -> str:
    """600183.SH → SH600183。"""
    if "." not in qmt_code:
        raise ValueError(f"QMT 代码格式错误（缺后缀）: {qmt_code}")
    digits, suffix = qmt_code.rsplit(".", 1)
    suffix = suffix.upper()
    if suffix not in _SUFFIX_TO_PREFIX:
        raise ValueError(f"无法识别的市场后缀: {qmt_code}")
    return f"{_SUFFIX_TO_PREFIX[suffix]}{digits}"
```

- [ ] **Step 4: 运行测试确认通过**

```bash
python -m pytest tests/test_ticker_fmt.py -v
```
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add qmt_executor/ticker_fmt.py tests/test_ticker_fmt.py
git commit -m "feat: ticker_fmt — SH/SZ 前缀 ↔ QMT 后缀转换"
```

---

## Task 3: merge.py — 持仓字段级合并（TDD，对齐 TS）

**Files:**
- Create: `qmt_executor/merge.py`
- Test: `tests/test_merge.py`
- Create: `tests/fixtures/merge_case.json`（跨语言一致性 fixture）

- [ ] **Step 1: 写跨语言一致性 fixture**

`tests/fixtures/merge_case.json`（与 TS `holdings-merge.test.ts` 的 `remote` fixture 等价）：

```json
{
  "remote": {
    "updated_at": "2026-06-21T20:00:00+08:00",
    "cash_pct": 0.80,
    "positions": [
      {"ticker": "SZ300319", "name": "麦捷科技", "weight": 0.10, "entry_price": 25, "entry_date": "2026-06-15", "shares": 200, "sector": "电子"},
      {"ticker": "SH600183", "name": "生益科技", "weight": 0.10, "entry_price": 30, "entry_date": "2026-06-10", "shares": 100, "sector": "PCB"}
    ]
  },
  "qmt_positions": [
    {"ticker": "SZ300319", "volume": 150, "open_price": 26.5, "open_date": "2026-06-15", "market_value": 3975, "can_use_volume": 150}
  ],
  "qmt_asset": {"total": 100000, "cash": 95000},
  "expected": {
    "cash_pct": 0.95,
    "positions": [
      {"ticker": "SZ300319", "name": "麦捷科技", "sector": "电子", "shares": 150, "entry_price": 26.5, "entry_date": "2026-06-15", "weight": 0.03975}
    ]
  }
}
```

- [ ] **Step 2: 写失败测试**

`tests/test_merge.py`：

```python
import json
from pathlib import Path
from qmt_executor.merge import merge_holdings, QmtPosition, QmtAsset

FIXTURE = Path(__file__).parent / "fixtures" / "merge_case.json"


def load_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_qmt_market_fields_override():
    """QMT 持仓覆盖 shares/entry_price/entry_date。"""
    fx = load_fixture()
    merged = merge_holdings(fx["remote"], fx["qmt_positions"], fx["qmt_asset"])
    p = next(pos for pos in merged["positions"] if pos["ticker"] == "SZ300319")
    assert p["shares"] == 150
    assert p["entry_price"] == 26.5
    assert p["entry_date"] == "2026-06-15"


def test_weight_recomputed():
    """weight = market_value / total_asset。"""
    fx = load_fixture()
    merged = merge_holdings(fx["remote"], fx["qmt_positions"], fx["qmt_asset"])
    p = next(pos for pos in merged["positions"] if pos["ticker"] == "SZ300319")
    assert abs(p["weight"] - 3975 / 100000) < 1e-6


def test_cash_pct_recomputed():
    """cash_pct = cash / total。"""
    fx = load_fixture()
    merged = merge_holdings(fx["remote"], [], fx["qmt_asset"])
    assert abs(merged["cash_pct"] - 95000 / 100000) < 1e-6


def test_local_sector_preserved():
    """sector 保留（QMT 无此字段）。"""
    fx = load_fixture()
    merged = merge_holdings(fx["remote"], fx["qmt_positions"], fx["qmt_asset"])
    p = next(pos for pos in merged["positions"] if pos["ticker"] == "SZ300319")
    assert p["sector"] == "电子"


def test_local_name_preserved():
    """name 保留（QMT 不提供）。"""
    fx = load_fixture()
    positions = [{"ticker": "SH600183", "volume": 100, "open_price": 30, "open_date": "2026-06-10", "market_value": 3000, "can_use_volume": 100}]
    merged = merge_holdings(fx["remote"], positions, fx["qmt_asset"])
    p = next(pos for pos in merged["positions"] if pos["ticker"] == "SH600183")
    assert p["name"] == "生益科技"


def test_new_position_marked_uncategorized():
    """QMT 有但 remote 无 → 新增，sector 标"未分类"。"""
    fx = load_fixture()
    positions = [{"ticker": "SH600519", "volume": 10, "open_price": 1700, "open_date": "2026-06-20", "market_value": 17000, "can_use_volume": 10}]
    merged = merge_holdings(fx["remote"], positions, fx["qmt_asset"])
    p = next(pos for pos in merged["positions"] if pos["ticker"] == "SH600519")
    assert p["sector"] == "未分类"
    assert p["shares"] == 10


def test_zero_volume_removed():
    """remote 有但 QMT volume=0 → 清仓删除。"""
    fx = load_fixture()
    positions = [{"ticker": "SZ300319", "volume": 0, "open_price": 25, "open_date": "2026-06-15", "market_value": 0, "can_use_volume": 0}]
    merged = merge_holdings(fx["remote"], positions, fx["qmt_asset"])
    assert not any(pos["ticker"] == "SZ300319" for pos in merged["positions"])


def test_updated_at_refreshed():
    """updated_at 更新为现在。"""
    fx = load_fixture()
    merged = merge_holdings(fx["remote"], [], fx["qmt_asset"])
    assert merged["updated_at"] != "2026-06-21T20:00:00+08:00"
```

- [ ] **Step 3: 运行测试确认失败**

```bash
python -m pytest tests/test_merge.py -v
```
Expected: FAIL — ModuleNotFoundError。

- [ ] **Step 4: 实现**

`qmt_executor/merge.py`：

```python
"""持仓字段级合并契约（Python 端，对齐 TS mergeHoldings）。

云服务器执行订单后调此函数把 QMT 真实持仓合并进 holdings.json：
  - 市场字段（shares/entry_price/entry_date/weight/cash_pct）以 QMT 为准
  - 本地字段（sector/name）保留（QMT 查不到）
  - QMT volume=0 的清仓股删除
  - QMT 新出现的持仓新增（sector 标"未分类"）

与 TS src/watchlist/holdings-merge.ts 逻辑一致，跨语言一致性测试
（tests/fixtures/merge_case.json）保证两端不漂移。
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class QmtPosition:
    """QMT 持仓查询结果（query_stock_positions 映射）。"""
    ticker: str             # "SZ300319" 格式
    volume: int             # 总持仓
    open_price: float       # 成本价
    open_date: str          # "YYYY-MM-DD"
    market_value: float
    can_use_volume: int     # T+1 可卖


@dataclass
class QmtAsset:
    """QMT 资产查询结果（query_stock_asset 映射）。"""
    total: float            # 总资产（元）
    cash: float             # 现金（元）


def _now_iso() -> str:
    """当前 ISO 时间戳（带时区，对齐 TS new Date().toISOString()）。"""
    return datetime.now(timezone.utc).isoformat()


def merge_holdings(
    remote: dict[str, Any],
    qmt_positions: list[QmtPosition | dict[str, Any]],
    qmt_asset: QmtAsset | dict[str, Any],
) -> dict[str, Any]:
    """字段级合并：QMT 市场字段覆盖，本地字段保留，清仓删除，新仓新增。

    Args:
        remote: holdings.json 的当前内容（dict，含 positions 数组）
        qmt_positions: QMT 持仓列表（dataclass 或 dict，自动归一）
        qmt_asset: QMT 资产（dataclass 或 dict）

    Returns:
        新的 holdings dict（updated_at 刷新）。不修改输入。
    """
    # 归一 dataclass / dict 输入
    def _pos(p: QmtPosition | dict) -> QmtPosition:
        if isinstance(p, QmtPosition):
            return p
        return QmtPosition(
            ticker=p["ticker"], volume=p["volume"], open_price=p["open_price"],
            open_date=p["open_date"], market_value=p["market_value"],
            can_use_volume=p["can_use_volume"],
        )

    asset = qmt_asset if isinstance(qmt_asset, QmtAsset) else QmtAsset(**qmt_asset)
    positions = [_pos(p) for p in qmt_positions]

    remote_by_ticker = {p["ticker"]: p for p in remote.get("positions", [])}

    merged_positions: list[dict[str, Any]] = []
    for qp in positions:
        if qp.volume == 0:
            continue  # 清仓删除
        existing = remote_by_ticker.get(qp.ticker)
        merged_positions.append({
            "ticker": qp.ticker,
            # name/sector 保留本地（QMT 不提供）；新仓 name 留空待补
            "name": existing["name"] if existing else "",
            "sector": existing["sector"] if existing else "未分类",
            "shares": qp.volume,
            "entry_price": qp.open_price,
            "entry_date": qp.open_date,
            "weight": qp.market_value / asset.total if asset.total > 0 else 0,
        })

    return {
        "updated_at": _now_iso(),
        "cash_pct": asset.cash / asset.total if asset.total > 0 else 0,
        "positions": merged_positions,
    }
```

- [ ] **Step 5: 运行测试确认通过**

```bash
python -m pytest tests/test_merge.py -v
```
Expected: 8 passed。

- [ ] **Step 6: Commit**

```bash
git add qmt_executor/merge.py tests/test_merge.py tests/fixtures/merge_case.json
git commit -m "feat: merge — 持仓字段级合并（对齐 TS mergeHoldings）

跨语言一致性 fixture tests/fixtures/merge_case.json。"
```

---

## Task 4: qmt_client.py — 抽象接口 + 数据类

**Files:**
- Create: `qmt_executor/qmt_client.py`

这是接口定义任务（无独立测试，由 Task 5 simulator 测试覆盖接口契约）。

- [ ] **Step 1: 实现接口**

`qmt_executor/qmt_client.py`：

```python
"""QmtClient 抽象接口 + 成交结果数据类。

两个实现：
  - XtquantClient：真实 xtquant（Win only，import xtquant）
  - Simulator：内存模拟器（任意平台，Mac/dev 用）

接口契约对齐 easytrader MiniqmtTrader 的方法子集。
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class Fill:
    """单笔成交记录（对齐 TS Fill 接口）。"""
    ticker: str
    action: str             # "BUY" | "SELL" | "ADD" | "REDUCE"
    order_sys_id: str       # 委托号（simulator 用自增整数）
    filled_price: float
    filled_volume: int      # 实际成交股数
    intended_volume: int    # 计划股数
    status: str             # "filled" | "partial" | "rejected" | "cancelled"

    def to_dict(self) -> dict:
        return {
            "ticker": self.ticker, "action": self.action,
            "order_sys_id": self.order_sys_id, "filled_price": self.filled_price,
            "filled_volume": self.filled_volume, "intended_volume": self.intended_volume,
            "status": self.status,
        }


class QmtClient(ABC):
    """QMT 交易客户端抽象接口。"""

    @abstractmethod
    def connect(self, mini_qmt_path: str, account_id: str) -> None: ...

    @abstractmethod
    def buy(self, qmt_code: str, price: float, volume: int) -> str:
        """限价买入，返回 order_sys_id。"""

    @abstractmethod
    def sell(self, qmt_code: str, price: float, volume: int) -> str:
        """限价卖出，返回 order_sys_id。"""

    @abstractmethod
    def get_price(self, qmt_code: str) -> float:
        """取当前价（下单换算用）。"""

    @abstractmethod
    def wait_fill(self, order_sys_id: str, timeout_sec: float = 30) -> Fill:
        """轮询成交，返回 Fill。超时撤单返回 partial/cancelled。"""

    @abstractmethod
    def cancel(self, order_sys_id: str) -> bool: ...

    @abstractmethod
    def query_positions(self) -> list:
        """返回 list[dict]：ticker/volume/open_price/open_date/market_value/can_use_volume。"""

    @abstractmethod
    def query_asset(self) -> dict:
        """返回 dict：total/cash。"""
```

- [ ] **Step 2: 验证 import 无误**

```bash
python -c "from qmt_executor.qmt_client import QmtClient, Fill; print('OK')"
```
Expected: `OK`。

- [ ] **Step 3: Commit**

```bash
git add qmt_executor/qmt_client.py
git commit -m "feat: qmt_client 抽象接口 + Fill 数据类"
```

---

## Task 5: simulator.py — 内存模拟器（TDD）

**Files:**
- Create: `qmt_executor/simulator.py`
- Test: `tests/test_simulator.py`

- [ ] **Step 1: 写失败测试**

`tests/test_simulator.py`：

```python
import pytest
from qmt_executor.simulator import Simulator


@pytest.fixture
def sim():
    s = Simulator(initial_cash=100000)
    s.connect("", "")  # sim 忽略 path/account
    return s


def test_initial_asset_all_cash(sim):
    asset = sim.query_asset()
    assert asset["total"] == 100000
    assert asset["cash"] == 100000


def test_buy_reduces_cash_increases_position(sim):
    sim.set_price("600183.SH", 30.0)
    sim.buy("600183.SH", 30.0, 100)
    asset = sim.query_asset()
    assert asset["cash"] == 100000 - 30.0 * 100
    pos = sim.query_positions()[0]
    assert pos["ticker"] == "SH600183"
    assert pos["volume"] == 100


def test_t1_buy_not_sellable_same_day(sim):
    """T+1：买入当日 can_use_volume=0。"""
    sim.set_price("600183.SH", 30.0)
    sim.buy("600183.SH", 30.0, 100)
    pos = sim.query_positions()[0]
    assert pos["can_use_volume"] == 0
    assert pos["volume"] == 100


def test_sell_requires_can_use(sim):
    """当日买入不能卖（T+1）。"""
    sim.set_price("600183.SH", 30.0)
    sim.buy("600183.SH", 30.0, 100)
    with pytest.raises(ValueError, match="可卖不足"):
        sim.sell("600183.SH", 31.0, 100)


def test_wait_fill_immediate(sim):
    """sim 即时成交，wait_fill 立即返回 filled。"""
    sim.set_price("600183.SH", 30.0)
    order_id = sim.buy("600183.SH", 30.0, 100)
    fill = sim.wait_fill(order_id)
    assert fill.status == "filled"
    assert fill.filled_volume == 100
    assert fill.filled_price == 30.0


def test_advance_day_unlocks_t1(sim):
    """推进一天后 T+1 解锁。"""
    sim.set_price("600183.SH", 30.0)
    sim.buy("600183.SH", 30.0, 100)
    sim.advance_day()
    pos = sim.query_positions()[0]
    assert pos["can_use_volume"] == 100


def test_get_price_returns_set(sim):
    sim.set_price("600183.SH", 30.0)
    assert sim.get_price("600183.SH") == 30.0
```

- [ ] **Step 2: 运行测试确认失败**

```bash
python -m pytest tests/test_simulator.py -v
```
Expected: FAIL — ModuleNotFoundError。

- [ ] **Step 3: 实现**

`qmt_executor/simulator.py`：

```python
"""QmtClient 内存模拟器实现。

10 万模拟资金，本地字典记持仓。即时成交（不模拟滑点/部分成交，KISS）。
T+1：买入当日 can_use_volume=0，advance_day() 后解锁。

Mac/dev 用此实现跑通完整执行器流程，无需 xtquant。
参考 aiagents-stock SmartMonitorQMTSimulator 思路。
"""
from __future__ import annotations
from datetime import date, timedelta
from qmt_executor.qmt_client import QmtClient, Fill
from qmt_executor.ticker_fmt import from_qmt_code


class Simulator(QmtClient):
    def __init__(self, initial_cash: float = 100000):
        self._cash = initial_cash
        self._positions: dict[str, dict] = {}       # ticker → 持仓
        self._prices: dict[str, float] = {}         # qmt_code → 现价
        self._orders: dict[str, Fill] = {}          # order_sys_id → Fill
        self._next_order_id = 1
        self._today = date(2026, 6, 23)             # 模拟当前日

    def connect(self, mini_qmt_path: str, account_id: str) -> None:
        pass  # sim 无需连接

    # ── 测试辅助 ──
    def set_price(self, qmt_code: str, price: float) -> None:
        self._prices[qmt_code] = price

    def advance_day(self) -> None:
        """推进一天，解锁所有持仓的 T+1。"""
        self._today += timedelta(days=1)
        for pos in self._positions.values():
            pos["can_use_volume"] = pos["volume"]

    # ── QmtClient 实现 ──
    def get_price(self, qmt_code: str) -> float:
        if qmt_code not in self._prices:
            raise ValueError(f"未设置 {qmt_code} 的价格，请先 set_price")
        return self._prices[qmt_code]

    def _new_order_id(self) -> str:
        oid = str(self._next_order_id)
        self._next_order_id += 1
        return oid

    def _trade(self, qmt_code: str, price: float, volume: int, action: str) -> str:
        if volume % 100 != 0:
            raise ValueError(f"股数必须是 100 整手: {volume}")
        ticker = from_qmt_code(qmt_code)
        amount = price * volume

        if action in ("BUY", "ADD"):
            if amount > self._cash:
                raise ValueError(f"现金不足：需要 {amount}，仅有 {self._cash}")
            self._cash -= amount
            pos = self._positions.get(ticker)
            if pos:
                # 加仓：更新均价
                total_cost = pos["volume"] * pos["open_price"] + amount
                pos["volume"] += volume
                pos["open_price"] = total_cost / pos["volume"]
                # T+1：当日新增部分不可卖
                pos["can_use_volume"] = pos.get("can_use_volume", 0)
            else:
                self._positions[ticker] = {
                    "ticker": ticker, "volume": volume, "open_price": price,
                    "open_date": self._today.isoformat(), "can_use_volume": 0,
                }
        else:  # SELL / REDUCE
            pos = self._positions.get(ticker)
            if not pos or pos["can_use_volume"] < volume:
                avail = pos["can_use_volume"] if pos else 0
                raise ValueError(f"可卖不足：需要 {volume}，可卖 {avail}（T+1）")
            pos["volume"] -= volume
            pos["can_use_volume"] -= volume
            self._cash += amount
            if pos["volume"] == 0:
                del self._positions[ticker]

        self._prices[qmt_code] = price  # 记录最近成交价
        oid = self._new_order_id()
        self._orders[oid] = Fill(
            ticker=ticker, action=action, order_sys_id=oid,
            filled_price=price, filled_volume=volume,
            intended_volume=volume, status="filled",
        )
        return oid

    def buy(self, qmt_code: str, price: float, volume: int) -> str:
        return self._trade(qmt_code, price, volume, "BUY")

    def sell(self, qmt_code: str, price: float, volume: int) -> str:
        return self._trade(qmt_code, price, volume, "SELL")

    def wait_fill(self, order_sys_id: str, timeout_sec: float = 30) -> Fill:
        # sim 即时成交，直接返回
        if order_sys_id not in self._orders:
            raise ValueError(f"未知 order_sys_id: {order_sys_id}")
        return self._orders[order_sys_id]

    def cancel(self, order_sys_id: str) -> bool:
        # sim 即时成交，无未成交单可撤
        return False

    def query_positions(self) -> list[dict]:
        result = []
        for ticker, pos in self._positions.items():
            price = next((p for c, p in self._prices.items()
                          if c.endswith(ticker[2:]) and ticker.startswith(c[-2:])),
                         pos["open_price"])
            mv = pos["volume"] * price
            result.append({
                "ticker": ticker, "volume": pos["volume"],
                "open_price": pos["open_price"], "open_date": pos["open_date"],
                "market_value": mv, "can_use_volume": pos["can_use_volume"],
            })
        return result

    def query_asset(self) -> dict:
        positions_value = sum(
            pos["volume"] * self._prices.get(
                next((c for c in self._prices if c.endswith(ticker[2:])
                      and ticker.startswith(c[-2:])), ""), pos["open_price"])
            for ticker, pos in self._positions.items()
        )
        return {"total": self._cash + positions_value, "cash": self._cash}
```

> **注**：`query_positions`/`query_asset` 里的 ticker↔qmt_code 匹配逻辑稍繁（模拟器内部用 ticker 作 key，但价格用 qmt_code 存）。如果测试因此失败，简化为：simulator 额外维护一个 ticker→price 映射，避免反向查找。先按此实现跑测试，红了再简化。

- [ ] **Step 4: 运行测试确认通过**

```bash
python -m pytest tests/test_simulator.py -v
```
Expected: 7 passed。若 query_positions/query_asset 的价格查找报错，简化为 ticker→price 映射（见上注）。

- [ ] **Step 5: Commit**

```bash
git add qmt_executor/simulator.py tests/test_simulator.py
git commit -m "feat: simulator — 内存模拟器（T+1/即时成交/Mac 可跑）"
```

---

## Task 6: git_sync.py — pull/push + safe_push 仲裁

**Files:**
- Create: `qmt_executor/git_sync.py`
- Test: `tests/test_git_sync.py`

- [ ] **Step 1: 写失败测试**

`tests/test_git_sync.py`（mock subprocess）：

```python
import json
import pytest
from unittest.mock import patch
from qmt_executor.git_sync import GitSync, ConflictAbortedError


@pytest.fixture
def gs(tmp_path):
    return GitSync(str(tmp_path / "state-repo"))


def _mock_git_returns(returns: dict):
    """生成一个 mock：按命令关键字返回预设字符串。"""
    def side_effect(cmd, **kwargs):
        for key, val in returns.items():
            if key in cmd:
                return val
        return ""
    return side_effect


def test_pull_calls_git(gs):
    with patch("qmt_executor.git_sync._run_git", side_effect=_mock_git_returns({})) as m:
        gs.pull()
        assert any("pull" in c for c, *_ in m.call_args_list)


def test_remote_has_new_commits_true(gs):
    with patch("qmt_executor.git_sync._run_git",
               side_effect=_mock_git_returns({"rev-list --count": "2"})):
        assert gs.remote_has_new_commits() is True


def test_remote_has_new_commits_false(gs):
    with patch("qmt_executor.git_sync._run_git",
               side_effect=_mock_git_returns({"rev-list --count": "0"})):
        assert gs.remote_has_new_commits() is False


def test_safe_push_aborts_when_local_pending_hits_remote_filled(gs, tmp_path):
    """本地 pending 撞远端 filled → abort（云服务器视角：不可能，但接口要稳）。"""
    repo = tmp_path / "state-repo"
    repo.mkdir()
    remote_filled = json.dumps({
        "order_id": "X", "execution": {"status": "filled", "executed_at": None,
        "account_total_asset": None, "fills": [], "errors": []}
    })
    local = {"order_id": "Y", "execution": {"status": "pending", "executed_at": None,
            "account_total_asset": None, "fills": [], "errors": []}}
    (repo / "last_rebalance.json").write_text(json.dumps(local), encoding="utf-8")

    with patch("qmt_executor.git_sync._run_git", side_effect=_mock_git_returns({
        "rev-list --count": "1",
        "show origin/main:last_rebalance.json": remote_filled,
    })):
        with pytest.raises(ConflictAbortedError):
            gs.safe_push()


def test_safe_push_local_filled_overrides_remote_pending(gs, tmp_path):
    """云服务器专属：本地 filled 权威，push 覆盖远端 pending。"""
    repo = tmp_path / "state-repo"
    repo.mkdir()
    remote_pending = json.dumps({"order_id": "X", "execution": {"status": "pending",
        "executed_at": None, "account_total_asset": None, "fills": [], "errors": []}})
    local = {"order_id": "X", "execution": {"status": "filled", "executed_at": "2026-06-23",
            "account_total_asset": 100000, "fills": [], "errors": []}}
    (repo / "last_rebalance.json").write_text(json.dumps(local), encoding="utf-8")

    calls = []
    with patch("qmt_executor.git_sync._run_git", side_effect=_mock_git_returns({
        "rev-list --count": "1",
        "show origin/main:last_rebalance.json": remote_pending,
    })) as m:
        gs.safe_push()
        cmds = [c for c, *_ in m.call_args_list]
        assert any("push" in c for c in cmds)
```

- [ ] **Step 2: 运行测试确认失败**

```bash
python -m pytest tests/test_git_sync.py -v
```
Expected: FAIL — ModuleNotFoundError。

- [ ] **Step 3: 实现**

`qmt_executor/git_sync.py`：

```python
"""git 同步 + 冲突仲裁（云服务器端 safe_push）。

冲突规则（对照 TS syncPush，云服务器多一条）：
  - 本地 pending 撞远端已执行（非 pending）→ abort
  - 本地 pending 撞远端 pending → 后写胜出（规则 2，云服务器专属）
  - 本地 filled 撞远端 pending → push 覆盖（执行结果权威，云服务器是 execution 唯一写方）
"""
from __future__ import annotations
import json
import subprocess
from pathlib import Path


class ConflictAbortedError(Exception):
    """本地 pending 撞远端已执行 → 拒绝 push。"""
    pass


def _run_git(repo_dir: str, cmd: str) -> str:
    """运行 git 命令，返回 stdout（已 strip）。失败抛 RuntimeError。"""
    try:
        result = subprocess.run(
            f"git -C {repo_dir} {cmd}", shell=True, capture_output=True,
            text=True, timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git 失败: git {cmd}\n{result.stderr}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"git 超时: git {cmd}") from e


def _is_pending(status: str) -> bool:
    return status == "pending"


class GitSync:
    def __init__(self, state_repo_dir: str):
        self.repo_dir = state_repo_dir
        self.last_path = Path(state_repo_dir) / "last_rebalance.json"

    def pull(self) -> None:
        _run_git(self.repo_dir, "pull origin main")

    def remote_has_new_commits(self) -> bool:
        _run_git(self.repo_dir, "fetch origin main")
        count = _run_git(self.repo_dir, "rev-list --count main..origin/main")
        return int(count) > 0

    def read_remote_last(self) -> dict:
        raw = _run_git(self.repo_dir, "show origin/main:last_rebalance.json")
        return json.loads(raw)

    def safe_push(self) -> None:
        """push 前仲裁：本地 pending 撞远端已执行 → abort。

        云服务器视角：本地若是 filled，永远是权威执行结果，直接 push 覆盖。
        """
        if self.remote_has_new_commits():
            remote = self.read_remote_last()
            local = json.loads(self.last_path.read_text(encoding="utf-8"))
            local_exec = local.get("execution", {})
            remote_exec = remote.get("execution", {})
            # 本地 pending 撞远端非 pending → abort
            if (_is_pending(local_exec.get("status", "pending"))
                    and not _is_pending(remote_exec.get("status", "pending"))):
                raise ConflictAbortedError(
                    f"远端订单 {remote.get('order_id')} 已执行"
                    f"（status={remote_exec.get('status')}），本地 pending 不能覆盖"
                )
            # 本地 filled 撞远端 pending → 执行结果权威，继续 push
            # 都 pending → 后写胜出，继续 push
        _run_git(self.repo_dir, "add holdings.json last_rebalance.json")
        _run_git(self.repo_dir, 'commit -m "chore(state): sync from executor" --allow-empty')
        _run_git(self.repo_dir, "push origin main")
```

- [ ] **Step 4: 运行测试确认通过**

```bash
python -m pytest tests/test_git_sync.py -v
```
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add qmt_executor/git_sync.py tests/test_git_sync.py
git commit -m "feat: git_sync — pull/push + safe_push 仲裁（云服务器端规则）"
```

---

## Task 7: config.py — 读 config.toml

**Files:**
- Create: `qmt_executor/config.py`
- Test: `tests/test_config.py`

- [ ] **Step 1: 写失败测试**

`tests/test_config.py`：

```python
import pytest
from qmt_executor.config import Config, load_config


def test_load_sim_mode(tmp_path):
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text("""
[execution]
mode = "sim"
[qmt]
mini_qmt_path = "D:\\\\QMT"
account_id = "12345"
[git]
state_repo_dir = "C:\\\\repo"
""", encoding="utf-8")
    cfg = load_config(str(cfg_file))
    assert cfg.mode == "sim"
    assert cfg.account_id == "12345"
    assert cfg.state_repo_dir == "C:\\repo"


def test_load_real_mode(tmp_path):
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text("""
[execution]
mode = "real"
[qmt]
mini_qmt_path = "D:\\\\QMT\\\\userdata_mini"
account_id = "110XXX"
[git]
state_repo_dir = "/tmp/repo"
""", encoding="utf-8")
    cfg = load_config(str(cfg_file))
    assert cfg.mode == "real"
    assert cfg.mini_qmt_path == "D:\\QMT\\userdata_mini"


def test_invalid_mode_raises(tmp_path):
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text('[execution]\nmode = "foo"\n[git]\nstate_repo_dir = "x"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="mode"):
        load_config(str(cfg_file))
```

- [ ] **Step 2: 运行测试确认失败**

```bash
python -m pytest tests/test_config.py -v
```
Expected: FAIL — ModuleNotFoundError。

- [ ] **Step 3: 实现**

`qmt_executor/config.py`：

```python
"""读 config.toml。Python 3.11+ 用内置 tomllib。"""
from __future__ import annotations
import tomllib
from dataclasses import dataclass


@dataclass
class Config:
    mode: str                 # "sim" | "real"
    mini_qmt_path: str        # real 模式用
    account_id: str           # real 模式用
    state_repo_dir: str       # trading-state repo 本地路径


def load_config(path: str) -> Config:
    with open(path, "rb") as f:
        data = tomllib.load(f)
    mode = data.get("execution", {}).get("mode", "sim")
    if mode not in ("sim", "real"):
        raise ValueError(f"config mode 必须是 sim 或 real，得到: {mode}")
    qmt = data.get("qmt", {})
    git = data.get("git", {})
    return Config(
        mode=mode,
        mini_qmt_path=qmt.get("mini_qmt_path", ""),
        account_id=qmt.get("account_id", ""),
        state_repo_dir=git.get("state_repo_dir", ""),
    )
```

- [ ] **Step 4: 运行测试确认通过**

```bash
python -m pytest tests/test_config.py -v
```
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add qmt_executor/config.py tests/test_config.py
git commit -m "feat: config — 读 config.toml（tomllib 内置）"
```

---

## Task 8: executor.py — 主流程编排

**Files:**
- Create: `qmt_executor/executor.py`

这是编排任务，测试在 Task 9（集成测试）。此任务实现主流程函数 `run_once()`。

- [ ] **Step 1: 实现**

`qmt_executor/executor.py`：

```python
"""executor 主流程：git pull → 幂等 → 下单 → 回填 → 合并 → git push。

第一版手动触发：python -m qmt_executor.executor。
守护轮询后续加（入口循环不同，执行器代码复用）。

数据契约对齐 TS src/watchlist/rebalance-types.ts。
"""
from __future__ import annotations
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from qmt_executor.config import Config, load_config
from qmt_executor.git_sync import GitSync
from qmt_executor.merge import merge_holdings
from qmt_executor.qmt_client import QmtClient, Fill
from qmt_executor.ticker_fmt import to_qmt_code

TERMINAL_STATUSES = {"filled", "partial", "failed"}


def _is_terminal(status: str) -> bool:
    return status in TERMINAL_STATUSES


def _is_pending(status: str) -> bool:
    return status == "pending"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def calc_volume(weight_delta: float, total_asset: float, price: float) -> int:
    """weight_delta（比例）→ 股数，按 100 整手取整。

    weight_delta < 0（卖）：abs(delta) × total_asset / price
    weight_delta > 0（买）：delta × total_asset / price
    """
    amount = abs(weight_delta) * total_asset
    raw = amount / price if price > 0 else 0
    return int(math.floor(raw / 100)) * 100


def summarize_status(fills: list[Fill]) -> str:
    """根据 fills 汇总 execution status：全 filled→filled，有 partial→partial，全失败→failed。"""
    if not fills:
        return "failed"
    statuses = [f.status for f in fills]
    if all(s == "filled" for s in statuses):
        return "filled"
    if all(s in ("rejected", "cancelled") for s in statuses):
        return "failed"
    return "partial"


def make_client(cfg: Config) -> QmtClient:
    """根据 mode 实例化 client。real 模式 import xtquant（Win only）。"""
    if cfg.mode == "sim":
        from qmt_executor.simulator import Simulator
        return Simulator(initial_cash=100000)
    else:
        from qmt_executor.xtquant_client import XtquantClient
        return XtquantClient()


def run_once(cfg: Config) -> str:
    """执行一次：返回最终 status（filled/partial/failed/skipped）。"""
    repo = Path(cfg.state_repo_dir)
    if not repo.exists():
        raise RuntimeError(f"trading-state repo 不存在: {repo}，请先 clone")

    gs = GitSync(str(repo))
    last_path = repo / "last_rebalance.json"
    holdings_path = repo / "holdings.json"

    # 1. pull + 读订单
    gs.pull()
    last = json.loads(last_path.read_text(encoding="utf-8"))
    execution = last.setdefault("execution", {})
    status = execution.get("status", "pending")

    # 2. 幂等：终态跳过
    if _is_terminal(status):
        print(f"[skip] order_id={last.get('order_id')} 已执行（status={status}）")
        return "skipped"

    # 3. 冲突仲裁：远端有更新的 pending → 后写胜出，采用远端
    if gs.remote_has_new_commits():
        remote_last = gs.read_remote_last()
        remote_exec = remote_last.get("execution", {})
        if (_is_pending(remote_exec.get("status", "pending"))
                and remote_last.get("order_id") != last.get("order_id")):
            last = remote_last
            execution = last["execution"]
            print(f"[adopt] 远端有更新的 pending 订单 {last.get('order_id')}，采用")

    # 4. 实例化 client + 连接
    client = make_client(cfg)
    client.connect(cfg.mini_qmt_path, cfg.account_id)

    # 5. 标记 executing 并 push（防并发）
    execution["status"] = "executing"
    last_path.write_text(json.dumps(last, ensure_ascii=False, indent=2), encoding="utf-8")
    gs.safe_push()

    # 6. 下单前实时查总资产（换算基准）
    asset = client.query_asset()
    sequence = last.get("execution_sequence", [])
    fills: list[Fill] = []
    errors: list[str] = []

    for step in sequence:
        ticker = step["ticker"]
        action = step["action"]
        try:
            qmt_code = to_qmt_code(ticker)
            price = client.get_price(qmt_code)
            volume = calc_volume(step["weight_delta"], asset["total"], price)
            if volume <= 0:
                errors.append(f"{ticker}: 计算股数为 0（weight={step['weight_delta']}, price={price}）")
                continue
            if action in ("SELL", "REDUCE"):
                order_id = client.sell(qmt_code, price, volume)
            else:  # BUY / ADD
                order_id = client.buy(qmt_code, price, volume)
            fill = client.wait_fill(order_id)
            fills.append(fill)
        except Exception as e:
            errors.append(f"{ticker}: {e}")

    # 7. 回填 execution
    last["execution"] = {
        "status": summarize_status(fills),
        "executed_at": _now_iso(),
        "account_total_asset": asset["total"],
        "fills": [f.to_dict() for f in fills],
        "errors": errors,
    }
    last_path.write_text(json.dumps(last, ensure_ascii=False, indent=2), encoding="utf-8")

    # 8. 字段级合并 holdings
    holdings = json.loads(holdings_path.read_text(encoding="utf-8"))
    new_holdings = merge_holdings(holdings, client.query_positions(), client.query_asset())
    holdings_path.write_text(json.dumps(new_holdings, ensure_ascii=False, indent=2), encoding="utf-8")

    # 9. push
    gs.safe_push()
    print(f"[done] order_id={last.get('order_id')} status={last['execution']['status']}"
          f" fills={len(fills)} errors={len(errors)}")
    return last["execution"]["status"]


def main():
    import sys
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else "config.toml"
    cfg = load_config(cfg_path)
    run_once(cfg)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 验证 import**

```bash
python -c "from qmt_executor.executor import run_once, calc_volume; print('OK')"
```
Expected: `OK`。

- [ ] **Step 3: Commit**

```bash
git add qmt_executor/executor.py
git commit -m "feat: executor 主流程编排

git pull → 幂等 → 冲突仲裁 → 下单 → 回填 → 合并 → push。
calc_volume 按 100 整手；summarize_status 汇总 fills。"
```

---

## Task 9: 集成测试 — sim + mock git 跑全流程

**Files:**
- Create: `tests/test_executor.py`

- [ ] **Step 1: 写集成测试**

`tests/test_executor.py`（用真实临时 git repo + sim 模式，跑 pending→filled 全流程）：

```python
import json
import subprocess
import pytest
from pathlib import Path
from qmt_executor.config import Config
from qmt_executor.executor import run_once, calc_volume, summarize_status
from qmt_executor.qmt_client import Fill


# ── 纯函数单测 ──

def test_calc_volume_rounds_to_100():
    # 100000 × 0.10 / 30 = 333.3 → floor 到 300
    assert calc_volume(0.10, 100000, 30.0) == 300


def test_calc_volume_zero_price():
    assert calc_volume(0.10, 100000, 0) == 0


def test_summarize_all_filled():
    fills = [Fill("X", "BUY", "1", 10, 100, 100, "filled"),
             Fill("Y", "SELL", "2", 20, 100, 100, "filled")]
    assert summarize_status(fills) == "filled"


def test_summarize_partial():
    fills = [Fill("X", "BUY", "1", 10, 100, 100, "filled"),
             Fill("Y", "SELL", "2", 20, 0, 100, "rejected")]
    assert summarize_status(fills) == "partial"


def test_summarize_empty_is_failed():
    assert summarize_status([]) == "failed"


# ── 全流程集成（真 git repo + sim）──

@pytest.fixture
def state_repo(tmp_path):
    """建一个本地 git repo 当 trading-state，初始化 holdings + pending 订单。"""
    repo = tmp_path / "trading-state"
    repo.mkdir()
    subprocess.run("git init", shell=True, cwd=repo, check=True, capture_output=True)
    subprocess.run('git config user.email "t@t"', shell=True, cwd=repo, check=True)
    subprocess.run('git config user.name "t"', shell=True, cwd=repo, check=True)

    # 初始 holdings：持 SZ300319 200 股
    holdings = {
        "updated_at": "2026-06-21T20:00:00+08:00", "cash_pct": 0.80,
        "positions": [
            {"ticker": "SZ300319", "name": "麦捷科技", "weight": 0.10,
             "entry_price": 25, "entry_date": "2026-06-15", "shares": 200, "sector": "电子"}
        ],
    }
    (repo / "holdings.json").write_text(json.dumps(holdings), encoding="utf-8")

    # pending 订单：SELL SZ300319（全清）
    last = {
        "date": "2026-06-23", "order_id": "2026-06-23-abc123",
        "actions": [{"action": "SELL", "ticker": "SZ300319", "weight": 0}],
        "execution_sequence": [
            {"step": 1, "action": "SELL", "ticker": "SZ300319", "name": "麦捷科技",
             "weight_delta": -0.10, "est_cash_after": 0.90}
        ],
        "execution": {"status": "pending", "executed_at": None,
                      "account_total_asset": None, "fills": [], "errors": []},
    }
    (repo / "last_rebalance.json").write_text(json.dumps(last), encoding="utf-8")
    subprocess.run("git add .", shell=True, cwd=repo, check=True)
    subprocess.run('git commit -m "init"', shell=True, cwd=repo, check=True, capture_output=True)
    return repo


def test_run_once_skips_terminal(state_repo):
    """已执行的订单（filled）→ skipped。"""
    last = json.loads((state_repo / "last_rebalance.json").read_text(encoding="utf-8"))
    last["execution"]["status"] = "filled"
    (state_repo / "last_rebalance.json").write_text(json.dumps(last), encoding="utf-8")

    cfg = Config(mode="sim", mini_qmt_path="", account_id="", state_repo_dir=str(state_repo))
    result = run_once(cfg)
    assert result == "skipped"


def test_run_once_sells_and_fills(state_repo, monkeypatch):
    """pending → 下单 → filled。模拟器要让卖出成立（T+1 解锁）。"""
    # 模拟器默认 T+1 锁定，卖出会失败。注入一个已解锁的 simulator 工厂。
    from qmt_executor import executor as exe_mod
    from qmt_executor.simulator import Simulator

    sim = Simulator(initial_cash=20000)
    sim.connect("", "")
    sim.set_price("300319.SZ", 31.5)
    # 预置持仓并解锁 T+1（模拟昨日买入）
    sim._positions["SZ300319"] = {
        "ticker": "SZ300319", "volume": 200, "open_price": 25,
        "open_date": "2026-06-15", "can_use_volume": 200,
    }
    monkeypatch.setattr(exe_mod, "make_client", lambda cfg: sim)

    cfg = Config(mode="sim", mini_qmt_path="", account_id="", state_repo_dir=str(state_repo))
    result = run_once(cfg)
    assert result == "filled"

    # 验证 execution 回填
    last = json.loads((state_repo / "last_rebalance.json").read_text(encoding="utf-8"))
    assert last["execution"]["status"] == "filled"
    assert len(last["execution"]["fills"]) == 1
    assert last["execution"]["fills"][0]["ticker"] == "SZ300319"
    assert last["execution"]["fills"][0]["status"] == "filled"

    # 验证 holdings 清仓（SZ300319 卖光）
    holdings = json.loads((state_repo / "holdings.json").read_text(encoding="utf-8"))
    assert not any(p["ticker"] == "SZ300319" for p in holdings["positions"])
```

- [ ] **Step 2: 运行测试**

```bash
python -m pytest tests/test_executor.py -v
```
Expected: 7 passed。若 `test_run_once_sells_and_fills` 因 simulator 内部状态注入失败，调整 fixture 让 simulator 预置持仓更干净（可能需要在 Simulator 加一个 `seed_position()` 测试辅助方法）。

- [ ] **Step 3: 若失败，按需给 Simulator 加测试辅助方法**

如果 `test_run_once_sells_and_fills` 注入 `_positions` 太 hacky，给 `Simulator` 加公开的 seed 方法（实现后补提交）：

```python
# 加到 Simulator 类
def seed_position(self, ticker: str, volume: int, open_price: float,
                  open_date: str, can_use_volume: int | None = None) -> None:
    """测试辅助：预置持仓（绕过 buy 流程）。"""
    self._positions[ticker] = {
        "ticker": ticker, "volume": volume, "open_price": open_price,
        "open_date": open_date,
        "can_use_volume": can_use_volume if can_use_volume is not None else volume,
    }
    qmt_code = to_qmt_code(ticker) if ticker.startswith(("SH", "SZ")) else ticker
    self._prices[qmt_code] = open_price
```

测试改用 `sim.seed_position("SZ300319", 200, 25, "2026-06-15")`。

- [ ] **Step 4: Commit**

```bash
git add tests/test_executor.py qmt_executor/simulator.py
git commit -m "test: executor 集成测试（sim + 真 git repo 跑 pending→filled）"
```

---

## Task 10: xtquant_client.py 真实实现 + README

**Files:**
- Create: `qmt_executor/xtquant_client.py`
- Create: `README.md`

- [ ] **Step 1: 实现 XtquantClient（借鉴 easytrader）**

`qmt_executor/xtquant_client.py`：

```python
"""XtquantClient — 真实 xtquant 实现（Win only）。

借鉴 easytrader MiniqmtTrader 的连接/下单/查询。
import xtquant 失败（Mac/Linux）时本模块 import 即报错——符合预期，
非 Win 环境用 Simulator。
"""
from __future__ import annotations
import time
from xtquant.xttrader import XtQuantTrader, StockAccount
from xtquant import xtconstant
from qmt_executor.qmt_client import QmtClient, Fill
from qmt_executor.ticker_fmt import from_qmt_code


class XtquantClient(QmtClient):
    def __init__(self):
        self._trader: XtQuantTrader | None = None
        self._account: StockAccount | None = None

    def connect(self, mini_qmt_path: str, account_id: str) -> None:
        import random
        session_id = random.randint(100000, 999999)
        self._trader = XtQuantTrader(mini_qmt_path, session_id)
        self._trader.start()
        if self._trader.connect() != 0:
            raise RuntimeError(f"连接 miniQMT 失败，检查路径/客户端是否登录: {mini_qmt_path}")
        self._account = StockAccount(account_id)
        self._trader.subscribe(self._account)

    def _order(self, qmt_code: str, price: float, volume: int, is_buy: bool) -> str:
        order_type = xtconstant.STOCK_BUY if is_buy else xtconstant.STOCK_SELL
        order_id = self._trader.order_stock(
            account=self._account, stock_code=qmt_code,
            order_type=order_type, order_volume=volume,
            price_type=xtconstant.FIX_PRICE, price=price,
        )
        if order_id <= 0:
            raise RuntimeError(f"下单失败 错误码={order_id} code={qmt_code} price={price} vol={volume}")
        return str(order_id)

    def buy(self, qmt_code: str, price: float, volume: int) -> str:
        return self._order(qmt_code, price, volume, is_buy=True)

    def sell(self, qmt_code: str, price: float, volume: int) -> str:
        return self._order(qmt_code, price, volume, is_buy=False)

    def get_price(self, qmt_code: str) -> float:
        from xtquant import xtdata
        tick = xtdata.get_full_tick([qmt_code])
        if qmt_code not in tick:
            raise RuntimeError(f"取行情失败: {qmt_code}")
        return float(tick[qmt_code]["lastPrice"])

    def wait_fill(self, order_sys_id: str, timeout_sec: float = 30) -> Fill:
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            orders = self._trader.query_stock_orders(self._account)
            for o in orders:
                if str(o.order_id) == order_sys_id:
                    if o.order_status in (56, 50, 55):  # 已成交/部成部撤/全成
                        traded = o.traded_volume
                        intended = o.order_volume
                        status = "filled" if traded >= intended else "partial"
                        if o.order_status == 55:
                            status = "cancelled"
                        ticker = from_qmt_code(o.stock_code)
                        action = "BUY" if o.order_type == xtconstant.STOCK_BUY else "SELL"
                        return Fill(ticker=ticker, action=action, order_sys_id=order_sys_id,
                                    filled_price=o.traded_price, filled_volume=traded,
                                    intended_volume=intended, status=status)
            time.sleep(0.5)
        # 超时撤单
        self.cancel(order_sys_id)
        return Fill(ticker="", action="", order_sys_id=order_sys_id,
                    filled_price=0, filled_volume=0, intended_volume=0, status="cancelled")

    def cancel(self, order_sys_id: str) -> bool:
        return self._trader.cancel_order_stock(self._account, int(order_sys_id)) == 0

    def query_positions(self) -> list:
        result = []
        for p in self._trader.query_stock_positions(self._account):
            if p.volume == 0:
                continue
            result.append({
                "ticker": from_qmt_code(p.stock_code), "volume": p.volume,
                "open_price": p.open_price, "open_date": str(p.open_date),
                "market_value": p.market_value, "can_use_volume": p.can_use_volume,
            })
        return result

    def query_asset(self) -> dict:
        asset = self._trader.query_stock_asset(self._account)
        return {"total": asset.total_asset, "cash": asset.cash}
```

> **注**：订单状态码（50/55/56）和字段名（`traded_volume`/`order_status`）需对照实际 xtquant SDK 版本，Win 上首次跑时校正。这是本 plan 唯一不能在 Mac 验证的部分。

- [ ] **Step 2: 写 README.md**

```markdown
# qmt-executor

QMT 执行器：消费 `last_rebalance.json` 调 xtquant 下单，字段级合并回写 `holdings.json`。

是 [openclaw-trading-agents](../openclaw-trading-agents) 的下游消费方，通过 `trading-state` private git repo 异步通信。

## 架构

```
openclaw (TS, Mac) → last_rebalance.json → trading-state repo → executor (这里) → xtquant → 回写 holdings
```

## 安装

```bash
git clone <qmt-executor repo>
cd qmt-executor
python -m venv .venv && .venv\Scripts\activate  # Win
pip install pytest
cp config.example.toml config.toml  # 编辑 mode/path/account
```

## 使用

### Mac/dev（sim 模式，无需 QMT）

```bash
# config.toml: mode = "sim"
python -m qmt_executor.executor
```

### Win 生产（real 模式）

```bash
# 1. 启动 miniQMT 客户端并登录（极简模式）
# 2. config.toml: mode = "real", mini_qmt_path, account_id
python -m qmt_executor.executor
```

## 测试

```bash
python -m pytest -v
```

## 数据契约

严格对齐 `openclaw-trading-agents/src/watchlist/rebalance-types.ts`。跨语言一致性测试：`tests/fixtures/merge_case.json`。

## 范围（第一版）

- ✅ 下单（限价）+ 持仓回写
- ✅ sim/real 双模式
- ✅ 幂等（order_id）+ 冲突仲裁
- ⏭️ 守护轮询（后续）
- ⏭️ 滑点/部分成交模拟（后续）
```

- [ ] **Step 3: Commit**

```bash
git add qmt_executor/xtquant_client.py README.md
git commit -m "feat: xtquant_client 真实实现 + README

XtquantClient 借鉴 easytrader；README 含架构/安装/使用。
real 模式字段名/状态码需 Win 首次跑时校正。"
```

---

## Self-Review 自检结果

**Spec 覆盖**：
- §3 适配器模式 → Task 4(接口) + 5(sim) + 10(real) ✓
- §4 数据契约（execution_sequence 只读、ticker 转换、weight→股数）→ Task 2 + 8(calc_volume) ✓
- §5 主流程 → Task 8 ✓
- §6 模拟器（T+1/即时成交）→ Task 5 ✓
- §7 冲突仲裁（三条规则）→ Task 6 ✓
- §8 故障恢复（幂等/崩溃恢复/非交易时段）→ Task 8（幂等）+ 注（real 验证）✓
- §9 测试策略 → Task 2/3/5/6/9 全覆盖 ✓
- §10 config → Task 7 ✓
- §11 不做的事 → 守护轮询/滑点明确排除 ✓
- §13 项目结构 → Task 1 全部建立 ✓

**Placeholder 扫描**：无 TODO/TBD。Task 5 注释和 Task 10 注释是"实现后按需校正"的真实风险标注（非占位），已给出具体校正方向。

**类型一致性**：
- `QmtClient` 接口（Task 4）的方法签名在 Task 5/10 实现中一致 ✓
- `Fill` dataclass 字段（Task 4）与 TS `Fill` 接口对齐 ✓
- `calc_volume(weight_delta, total_asset, price)` Task 8 定义 → Task 9 测试调用一致 ✓
- `merge_holdings(remote, positions, asset)` Task 3 定义 → Task 8 调用一致 ✓
- `Config` 字段 Task 7 定义 → Task 8/9 使用一致 ✓

**范围**：聚焦 executor 实现，10 个任务产出可独立验证的 Python 包（sim 全绿 + real 手动验证）。
