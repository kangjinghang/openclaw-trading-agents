# QMT 执行器（Python，云服务器端）设计

> 状态：设计待审 | 日期：2026-06-25
> 前置：`2026-06-25-qmt-execution-bridge-design.md`（TS 端，已实现）
> 定位：消费 TS 端产出的 `last_rebalance.json`，调 xtquant 下单，回写 `holdings.json`。

## 1. 定位

TS 开发机端（已实现）产出带 `order_id` + `execution:pending` + `execution_sequence` 的 `last_rebalance.json`，推到 `trading-state` private repo。**本执行器**跑在 Win 云服务器上，是这套异步链路的消费方：

```
git pull → 幂等检查 → 按 execution_sequence 下单 → 回填 execution → 字段级合并 holdings → git push
```

执行器是**独立 Python 项目**（新建仓库 `qmt-executor`），与 openclaw-trading-agents 零代码耦合，仅通过 `trading-state` repo 的两个 JSON 文件通信。

## 2. 核心约束

| # | 约束 | 来源 |
|---|---|---|
| E1 | **xtquant 是 Windows-only**，Mac 开发机装不上 | 技术现实 |
| E2 | **主力开发机是 Mac**，需要能在 Mac 上跑通完整逻辑 | 用户确认 |
| E3 | **QMT 客户端必须开着登录**，云服务器已验证可用 | TS spec C3 |
| E4 | **第一版手动触发**（一次性命令），守护轮询后续 | TS spec D7 |
| E5 | 数据契约严格对齐 TS 端 `rebalance-types.ts`（order_id/execution/execution_sequence） | TS spec §5 |

**E1+E2 直接驱动核心设计：适配器模式 + 内置模拟器。** 参考 aiagents-stock 的 `SmartMonitorQMTSimulator`（10 万模拟资金、本地字典记持仓），让 Mac 上能跑通完整流程（含 git 同步），Win 上切真实 xtquant。

## 3. 架构

```
┌──────────── qmt-executor（独立 Python 项目）────────────┐
│                                                          │
│  executor.py ──── 主流程编排                             │
│     │                                                    │
│     ├── qmt_client.py ── 适配器接口 QmtClient            │
│     │     ├── xtquant_client.py  (Win: 真实 xtquant)     │
│     │     └── simulator.py       (任意: 内存模拟器)      │
│     │                                                    │
│     ├── git_sync.py ─── pull/push + safe_push 仲裁       │
│     ├── merge.py ────── 持仓合并（对齐 TS mergeHoldings）│
│     ├── ticker_fmt.py ─ SZ300319 ↔ 300319.SZ             │
│     └── config.py ───── 读 config.toml（mode/path/account)│
│                                                          │
│  tests/ ── pytest（模拟器跑全流程 + 单元测试）           │
└──────────────────────────────────────────────────────────┘
```

**适配器模式**：`QmtClient` 是抽象接口（connect/buy/sell/cancel/query_positions/query_asset/query_orders），两个实现：
- `XtquantClient`：`try: from xtquant import xttrader` 成功才可用，否则 import 失败（Mac 上 import 就报错，符合预期）
- `Simulator`：10 万模拟资金，本地字典记持仓，按现价即时成交，模拟 T+1（买入当日 can_use_volume=0）

`config.toml` 的 `mode = "real" | "sim"` 决定加载哪个实现。Mac 永远用 sim，Win 默认 real。

## 4. 数据契约（严格对齐 TS 端）

执行器**只读写**这两个文件，字段定义以 TS 端 `rebalance-types.ts` 为准（权威源）：

### 输入：`last_rebalance.json`（TS 产出）
```jsonc
{
  "date": "2026-06-23",
  "order_id": "2026-06-23-a3f9b2",        // 幂等键
  "execution_sequence": [                   // 执行器按此顺序下单
    { "step": 1, "action": "SELL", "ticker": "SZ300319", "weight_delta": -0.10, "est_cash_after": 0.90 }
  ],
  "execution": { "status": "pending", ... } // 初始 pending
}
```
执行器**只读 `execution_sequence`**，不碰 `actions`（那是 LLM 原始记录）。不重算排序（TS 已算好）。

### 输出：回填 `last_rebalance.json.execution` + 重写 `holdings.json`
- `execution.status`: pending → executing → filled/partial/failed
- `execution.fills[]`: 每单成交记录
- `holdings.json`: 调 `merge_holdings()` 字段级合并（逻辑与 TS `mergeHoldings` 一致）

### 字段映射（Python ↔ TS）
| TS (rebalance-types.ts) | Python | 说明 |
|---|---|---|
| `ExecutionStep.weight_delta` | 下单股数换算 | `volume = round(target_weight × total_asset / price / 100) × 100` |
| `Action.action` BUY/SELL/ADD/REDUCE | `buy()`/`sell()` | ADD→buy，REDUCE→sell |
| `Fill.order_sys_id` | xtquant order_id | 委托号 |
| `QmtPosition.volume/open_price/open_date` | xtquant 字段 | 直接映射 |

### ticker 转换
```python
def to_qmt_code(ticker: str) -> str:
    # "SZ300319" → "300319.SZ"；"SH600183" → "600183.SH"
```

## 5. 主流程（executor.py）

```python
def run():
    cfg = load_config()
    git_sync.pull()
    last = load_last_rebalance()

    # 幂等：终态跳过
    if is_terminal(last["execution"]["status"]):
        log("order_id 已执行，跳过"); return

    # 冲突仲裁（云服务器端 safe_push 规则 2：都 pending 后写胜出）
    if git_sync.remote_has_new_commits():
        remote_last = git_sync.read_remote_last()
        # 远端有更新的 pending 订单 → 用远端版（后写胜出）
        if is_pending(remote_last["execution"]["status"]) and \
           remote_last.get("order_id") != last.get("order_id"):
            last = remote_last

    # 实例化 client（real 或 sim）
    client = make_client(cfg)   # sim 模式 Mac 可跑
    client.connect(cfg.mini_qmt_path, cfg.account_id)

    # 标记 executing 并 push（防并发执行）
    last["execution"]["status"] = "executing"
    save_last(last); git_sync.safe_push()

    # 下单前实时查总资产（换算基准）
    asset = client.query_asset()
    fills, errors = [], []
    for step in last["execution_sequence"]:
        try:
            price = client.get_price(to_qmt_code(step["ticker"]))
            volume = calc_volume(step, asset.total, price)
            if step["action"] in ("SELL", "REDUCE"):
                order_id = client.sell(to_qmt_code(step["ticker"]), price, volume)
            else:  # BUY / ADD
                order_id = client.buy(to_qmt_code(step["ticker"]), price, volume)
            filled = client.wait_fill(order_id)   # 轮询成交，超时撤单
            fills.append(filled)
        except Exception as e:
            errors.append(f"{step['ticker']}: {e}")  # list[str]，与 TS Execution.errors: string[] 对齐

    # 回填 execution
    last["execution"] = {
        "status": summarize(fills),          # filled/partial/failed
        "executed_at": now_iso(),
        "account_total_asset": asset.total,
        "fills": fills, "errors": errors,
    }

    # 字段级合并 holdings
    new_holdings = merge_holdings(load_holdings(), client.query_positions(), client.query_asset())

    git_sync.safe_push(last, new_holdings)
```

## 6. 模拟器设计（Mac 可跑）

`Simulator` 实现 `QmtClient` 接口：
- **资金**：初始 10 万现金，本地字典记持仓 `{ticker: {volume, avg_price, open_date}}`
- **成交**：`buy/sell` 即时按传入 price 成交（不模拟滑点/部分成交，第一版 KISS）
- **T+1**：买入当日 `can_use_volume=0`，次日变 `volume`（用 open_date 判断）
- **行情**：`get_price()` 返回最近一次 buy/sell 的 price，或配置的固定价（测试可控）
- **query_asset**：现金 + Σ(持仓 × 最后成交价)

这让 Mac 上能跑：sim executor + 真 git 同步（用一个测试用 private repo）→ 验证全流程逻辑，无需 xtquant。

## 7. 冲突仲裁（云服务器端 safe_push）

对照 TS 端（开发机）的规则，云服务器端多一条：

| 情况 | 开发机（TS syncPush） | 云服务器（Python safe_push） |
|---|---|---|
| 本地 pending 撞远端已执行 | abort（ConflictAbortedError） | abort |
| 本地 pending 撞远端 pending | 后写胜出 | 后写胜出（**规则 2，云服务器专属**） |
| 本地已执行（filled）撞远端 pending | 不发生（开发机不产 filled） | push 覆盖远端（执行结果权威） |

云服务器是 execution 的**唯一写方**，所以它的 filled 永远权威，push 时若远端是 pending 直接覆盖。

## 8. 故障恢复

| 故障 | 恢复 |
|---|---|
| 执行到一半崩溃 | 重启 git pull → status=executing → 查各委托状态补全 fills → 推进终态 |
| 部分成交后撤单超时 | fills[].status=partial，execution.status=partial，人 review |
| QMT 未登录（real 模式） | client.connect 抛错，execution 保持 pending（未标记 executing），下次重试 |
| 非交易时段 | client.sell/buy 报错 → 记 error → execution.status=failed |
| git push 冲突 | safe_push 仲裁重试 |

## 9. 测试策略（pytest，Mac 可全跑）

| 测试对象 | 方式 |
|---|---|
| `ticker_fmt` | 纯函数，双向转换 |
| `merge.py` | 与 TS `holdings-merge.test.ts` 同 fixture（跨语言一致性） |
| `Simulator` | 内存验证：buy 后持仓/现金变化、T+1、query_asset |
| `executor` 主流程 | mock `git_sync`（用临时目录）+ Simulator → 跑 pending→filled 全流程 |
| 冲突仲裁 | mock git_sync.remote_has_new_commits，验证三条规则 |
| 真实 xtquant | 仅 Win 手动跑，不进 CI |

## 10. 配置（config.toml）

```toml
[execution]
mode = "sim"          # sim | real；Mac 用 sim，Win 用 real

[qmt]
mini_qmt_path = "D:\\国金证券QMT\\userdata_mini"   # real 模式才需要
account_id = "110XXXXXX"

[git]
state_repo_dir = "C:\\Users\\...\\trading-state"   # trading-state repo 本地路径
```

## 11. 不做的事（YAGNI）

- **不做守护轮询**（第一版手动 `python executor.py`）
- **不做滑点/部分成交模拟**（sim 即时成交，KISS）
- **不做多账户**
- **不做实时行情订阅**（下单时 get_price 一次性查）
- **不做 Web UI**（CLI + 日志够用）

## 12. 验收标准

1. `ticker_fmt` / `merge` / `Simulator` 单元测试在 Mac 上全绿
2. executor + sim 模式跑通 pending→filled 全流程（Mac，临时 git repo）
3. 冲突仲裁三条规则测试覆盖
4. Win 上 real 模式：一笔小单（REDUCE）真实成交并回写 holdings
5. 闭环：Win 执行后，Mac pull 得到真实 holdings，下次 rebalancer 用真实持仓

## 13. 项目初始化（新仓库 qmt-executor）

```
qmt-executor/
├── README.md
├── pyproject.toml          # 或 requirements.txt: 仅 tomli/python-dateutil
├── config.example.toml
├── .gitignore              # config.toml（含 account_id）
├── qmt_executor/
│   ├── __init__.py
│   ├── executor.py
│   ├── qmt_client.py       # 抽象接口
│   ├── xtquant_client.py   # 真实实现（import xtquant，Mac import 失败）
│   ├── simulator.py
│   ├── git_sync.py
│   ├── merge.py
│   ├── ticker_fmt.py
│   └── config.py
└── tests/
    ├── conftest.py         # fixtures
    ├── test_ticker_fmt.py
    ├── test_merge.py
    ├── test_simulator.py
    ├── test_executor.py
    └── fixtures/           # 跨语言一致性测试的 JSON fixture（与 TS 共享）
```

## 14. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| P1 | 独立仓库 qmt-executor | 与 openclaw 解耦，各自技术栈清晰 |
| P2 | 适配器模式 + 内置模拟器 | Mac 可跑全流程（E1+E2），参考 aiagents-stock |
| P3 | 第一版手动触发 | 与 TS spec D7 一致 |
| P4 | 数据契约以 TS rebalance-types.ts 为权威 | TS 先实现，Python 对齐 |
| P5 | sim 即时成交不模拟滑点 | KISS，第一版验证链路 |
| P6 | 只读 execution_sequence 不碰 actions | TS 已算好顺序，避免双端漂移 |
