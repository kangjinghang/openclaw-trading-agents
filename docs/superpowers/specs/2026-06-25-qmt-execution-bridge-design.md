# QMT 执行桥设计 — git 文件队列跨机下单

> 状态：设计待审 | 日期：2026-06-25
> 目标：让 openclaw-trading-agents 的调仓结论能自动落到 QMT 真实账户，同时保持"Mac 开发机不依赖 QMT"的跨平台隔离。

## 1. 背景与动机

当前调仓链路止于文件：

```
rebalancer (TS) → plan.json + last_rebalance.json → (人工看 plan.md，手动下单)
```

`holdings.json`（持仓）和 `last_rebalance.json`（调仓结论）都是手动维护的 JSON 文件，代码只读写文件、不碰券商接口。**问题**：决策产出后仍需人工逐笔下单，容易漏单、记错成本价、持仓状态与真实账户脱节。

**目标**：自动把调仓结论转发到 QMT 执行，执行后把真实持仓/成交价回写，形成闭环。

## 2. 核心约束（驱动设计的关键事实）

| # | 约束 | 来源 |
|---|---|---|
| C1 | **xtquant 是 Windows-only Python 库**，openclaw-trading-agents 是 TypeScript —— TS 无法直接调用 xtquant | 技术栈现实 |
| C2 | **Mac 和 Win 混合开发**，Mac 上开发/测试不能依赖 QMT | 用户工作流 |
| C3 | **QMT 客户端必须开着并登录**（xtquant 复用已登录 session，不需要密码）—— 已在 Win 云服务器验证可用 | 三参考项目共性 + 用户确认 |
| C4 | **多台开发机**（Mac + 其他 Win）都可能跑 rebalancer 产出新订单 | 用户确认 |
| C5 | **下单执行只有一台**（Win 云服务器） | 用户确认 |
| C6 | **holdings.json 含真实持仓 + 成本价，仓库必须 private**（现有 openclaw-trading-agents 是 public） | 用户确认 |
| C7 | 现有 `~/.openclaw/` 整个被 `.gitignore` 排除 | `.gitignore:11` |

C1+C2 直接否决了"进程内直连 xtquant"（easytrader / aiagents-stock 的做法）—— 那会让宿主进程强耦合 Windows-only 依赖。

## 3. 方案选型（已与用户确认）

三选一对比：

| 方案 | 适合场景 | 本场景评价 |
|---|---|---|
| **HTTP 服务中介**（EasyXT qka 模式：xtquant→FastAPI） | 实时请求-响应、查询类、局域网 | ❌ 跨公网要暴露服务+鉴权；强耦合运行时（Mac 发请求等 Win 响应，Win 挂了 Mac 阻塞）；Mac 调试依赖服务在线 |
| **子进程脚本**（下单时 spawn Python） | 偶尔下单、单机 | ❌ Mac spawn 失败需处理；每次起进程慢；仍强耦合 |
| **git 文件队列**（决策→文件→git→Win 执行→回写） | **异步单向消息、命令类、跨机** | ✅ 天然鉴权加密（git/SSH）；异步不阻塞 Mac；Mac 调试无关 Win 是否在线；契合"用户偏好用 github 同步" |

**选定：git 文件队列。** 第一版范围 = **下单 + 持仓回写**（异步，非实时查询）。

## 4. 整体架构

```
┌─────────────── 开发机（Mac / 其他 Win，TS）────────────────┐
│  rebalance-cli                                              │
│    → plan.json                                              │
│    → last_rebalance.json (+ order_id + execution:pending    │
│                            + execution_sequence)            │
│    sync push：复制到 trading-state repo → git commit & push │
└──────────────────────────┬──────────────────────────────────┘
                           │  git（GitHub，天然鉴权+加密）
                           ▼
┌─────────────── Win 云服务器（Python + xtquant）────────────┐
│  executor                                                   │
│    1. git pull                                              │
│    2. 幂等检查：order_id 已执行过 → 跳过                    │
│    3. 冲突仲裁：远端已执行而本地 pending → 放弃 push         │
│    4. 按 execution_sequence 顺序：换算股数+限价 → 下单       │
│    5. 查成交 → 填 execution.fills（filled/partial/failed）  │
│    6. query_stock_positions → 字段级合并回写 holdings.json   │
│    7. git commit & push                                     │
└──────────────────────────┬──────────────────────────────────┘
                           │  git push
                           ▼  开发机 git pull
     holdings.json（真实持仓）+ last_rebalance.execution（成交记录）
     → 下次 rebalancer 用真实持仓决策   ← 闭环
```

**两个文件，各司其职**：

| 文件 | 职责 | 写方 |
|---|---|---|
| `last_rebalance.json` | 订单队列 + anti-churn 状态 | 开发机产出订单（pending）；云服务器执行后回填 execution |
| `holdings.json` | 持仓状态 | 云服务器回写市场字段；开发机/人维护 sector 等本地字段 |

**执行触发**：架构兼容两种模式，第一版先实现手动触发（一次性命令 `executor.py`），守护轮询留作后续。理由：日频调仓不是高频，手动触发天然防误执行；守护轮询的"无人值守"对日频是收益小、风险大的特性。两种模式共用同一套执行器代码，仅入口循环不同。

## 5. 数据契约

### 5.1 `last_rebalance.json`（扩展，向后兼容）

现有字段全部保留，新增 3 个字段：

```jsonc
{
  "date": "2026-06-23",
  "order_id": "2026-06-23-a3f9b2",        // ← 新增：幂等键
  "actions": [                              // 原样（LLM 原始输出，溯源用）
    { "action": "SELL", "ticker": "SZ300319", "weight": 0 },
    { "action": "REDUCE", "ticker": "SH600183", "weight": 0.05 }
  ],
  "execution_sequence": [                   // ← 新增：Mac 算好的下单顺序
    { "step": 1, "action": "SELL", "ticker": "SZ300319", "name": "麦捷科技",
      "weight_delta": -0.10, "est_cash_after": 0.90 },
    { "step": 2, "action": "REDUCE", "ticker": "SH600183", "name": "生益科技",
      "weight_delta": -0.05, "est_cash_after": 0.95 }
  ],
  "recent_sells": { "SZ300319": "2026-06-23" },
  "execution": {                            // ← 新增：状态机
    "status": "pending",                    // pending|executing|filled|partial|failed
    "executed_at": null,                    // ISO timestamp，云服务器回填
    "account_total_asset": null,            // 执行时总资产（元），对账溯源用（下单换算用实时查的值）
    "fills": [],                            // 逐单成交记录，云服务器回填
    "errors": []                            // 失败原因
  }
}
```

**`order_id` 算法**（幂等核心）：
```
order_id = date + "-" + sha256(canonicalize(actions)).slice(0, 6)
// canonicalize：actions 按 ticker 排序，weight 四舍五入到 4 位小数
```
Mac 重跑 rebalancer 若 actions 内容不变 → order_id 不变 → 云服务器识别为"已执行"跳过。actions 变了（哪怕调一个 weight）→ order_id 变 → 视为新订单。

**`execution.status` 状态机**：
```
pending ──(云服务器开始执行)──▶ executing ──┬─ filled   全部成交
                                           ├─ partial  部分成交
                                           └─ failed   全部失败/拒单
```
终态（filled/partial/failed）不可回退。

**`execution.fills[]` 结构**：
```jsonc
{
  "ticker": "SZ300319",
  "action": "SELL",
  "order_sys_id": "20260623000001",   // QMT 委托号，溯源/撤单
  "filled_price": 31.50,
  "filled_volume": 200,               // 实际成交股数
  "intended_volume": 200,             // 计划股数，部分成交时对比
  "status": "filled"                  // filled|partial|rejected|cancelled
}
```

**`execution_sequence` 为什么由 Mac 写**：执行顺序是关键语义（先卖后买释放资金），由现有 TS `buildExecutionPlan` 计算后写入，云服务器 Python 直接读、不重算。避免排序逻辑在 TS/Python 各实现一遍导致漂移。`actions`（LLM 原始输出）保留作溯源。

### 5.2 `holdings.json`（结构不变，字段所有权明确）

现有 `Holdings`/`Position` 接口不动。字段级合并的所有权表：

| 字段 | 开发机(rebalancer) | 云服务器(执行回填) | 人(手工) |
|---|---|---|---|
| `last_rebalance.actions/date/recent_sells/execution_sequence` | ✅ 产出 | ❌ 不改 | ❌ |
| `last_rebalance.execution.*` | ❌（只写 pending 占位） | ✅ 唯一写方 | ❌ |
| `holdings.shares/entry_price/entry_date` | ❌ | ✅ QMT 回填 | ⚠️ 仅初始建仓 |
| `holdings.weight/cash_pct` | ❌ | ✅ 重算 | ❌ |
| `holdings.sector/name` | ✅ | ❌（QMT 无此字段） | ✅ |
| `holdings.updated_at` | ✅ | ✅ | ✅ |

**核心约束**：`holdings` 的市场字段（shares/entry_price/entry_date/weight/cash_pct）**只有云服务器在执行后回填时写**——只有它知道真实成交。开发机跑 rebalancer 时是**读** holdings 决策，不写 holdings 的市场字段。故 holdings 市场字段实际是单写方，无多端冲突。

### 5.3 ticker 格式映射

`holdings` 用 `SZ300319` / `SH600183`，QMT 要 `300319.SZ` / `600183.SH`。映射规则（云服务器端）：

| 现有格式 | QMT 格式 |
|---|---|
| `SZ3xxxxx` / `SZ0xxxxx` / `SZ301xxx` | `xxxxxx.SZ` |
| `SH6xxxxx` / `SH688xxx` | `xxxxxx.SH` |

`weight`（比例）→ 股数换算（云服务器端执行时）：
```
volume = round( (target_weight × total_asset) / current_price / 100 ) × 100   // A 股按 100 股整手
```
`total_asset` 由 `query_stock_asset()` 实时获取，`current_price` 由行情接口获取。`execution.account_total_asset` 记录换算基准，供对账溯源。

## 6. 多端写入与冲突仲裁

写入分三类，频率与风险各异：

| 写入类型 | 谁写 | 频率 | 冲突风险 |
|---|---|---|---|
| A. 新订单 | 任何跑 rebalancer 的开发机 | 日频，每天 ≤1 份 | **中**：两台同日各跑一次 |
| B. 执行回填 | 仅云服务器 | 每次执行 1 次 | **低**：单写方 |
| C. 手工记录 | 人，任意机器 | 偶尔 | **低**：与 A/B 时间错开 |

聚焦 A 类（两份新订单抢 push），两条规则：

**规则 1 — 已执行不可覆盖**：远端 `execution.status ≠ pending`（已真金白银下单）而本地要 push 一份 `pending` → **拒绝 push，让本地 pull**。理由：已执行订单的 `recent_sells` 等 anti-churn 状态不能被未执行的 pending 抹掉。

**规则 2 — 都 pending 则后写胜出**：远端和本地都是 pending（都还没下单）→ 后 push 的胜出（git last-writer-wins）。理由：都是未执行意图，无资金损失；谁更新以谁为准符合直觉。

落到 `safe_push`（云服务器和开发机 sync 脚本都用）：
```python
def safe_push():
    remote = fetch("origin/main")
    if remote.diverged_from(local):
        remote_last, local_last = remote.last_rebalance, local.last_rebalance
        if not is_pending(remote_last.execution.status) and is_pending(local_last.execution.status):
            abort("远端订单已执行，本地 pending 不能覆盖，请 pull")
        else:
            resolve_last_writer_wins()
    push()
```

## 7. 组件设计

### 7.1 开发机端（TS，扩展 openclaw-trading-agents）

新增 4 个文件 + 改 1 个，侵入度可控：

```
src/watchlist/
├── order-id.ts          ← 新增：order_id 计算（纯函数）
├── execution-schema.ts  ← 新增：Execution 类型 + 状态机校验
├── holdings-merge.ts    ← 新增：字段级合并（供测试 + 文档化合并契约）
├── execution-bridge.ts  ← 新增：sync push 封装（复制 + git 操作）
└── rebalance-cli.ts     ← 改：跑完 plan 后产出带 order_id + execution:pending + execution_sequence 的 last_rebalance.json
```

**`order-id.ts`** — 纯函数，无副作用：
```ts
export function computeOrderId(date: string, actions: LastRebalanceAction[]): string
```
规范化（按 ticker 排序、weight 四舍五入到 4 位）保证幂等。

**`execution-schema.ts`** — 状态机类型 + 合法流转校验：
```ts
type ExecStatus = "pending" | "executing" | "filled" | "partial" | "failed";
interface Execution { status, executed_at, account_total_asset, fills: Fill[], errors: string[] }
function isTerminal(status): boolean   // filled/partial/failed
```

**`holdings-merge.ts`** — 合并规则纯函数。虽云服务器实际执行合并，TS 端也要有：文档化契约 + 测试用例直接验证合并规则（mock QMT 数据进，看合并出的 holdings 出）。
```ts
export function mergeHoldings(
  remote: Holdings, qmtPositions: QmtPosition[], qmtAsset: QmtAsset
): Holdings
```

**`rebalance-cli.ts` 改动**（最小侵入，在现有写 last_rebalance.json 处 rebalance-cli.ts:316-323 加 2 步）：
```ts
const newLast: LastRebalance = {
  date,
  order_id: computeOrderId(date, actions),      // ← 加
  actions: ...,
  execution_sequence: result.execution_plan.execution_sequence,  // ← 加（Mac 算好）
  recent_sells: mergedSells,
  execution: {                                   // ← 加
    status: "pending", executed_at: null,
    account_total_asset: null, fills: [], errors: [],
  },
};
```
`rebalancer.ts` 本身不动 —— 产出的 plan 照旧，仅落盘时多包一层 execution 信封。

**`execution-bridge.ts`** — sync push（开发机端专用）：
```ts
export async function syncPush(watchlistDir: string, stateRepoDir: string): Promise<void>
// 复制 holdings.json + last_rebalance.json 到 stateRepoDir → git add/commit/push
```
开发机端的 push 语义比云服务器简单：开发机永远只推 `pending` 订单，故冲突时只需处理一种情况——本地 pending 撞远端非 pending（已执行）。撞了就 abort + 提示 pull，不尝试后写覆盖（开发机不产执行结果，没有"更新"一说）。云服务器的 safe_push 规则 2（都 pending 后写胜出）只对它自己有意义。

### 7.2 云服务器端（Python，独立新建项目）

新建独立项目（建议 `~/qmt-executor/`），不塞进 openclaw-trading-agents：

```
qmt-executor/
├── executor.py          ← 主入口：git pull → 幂等检查 → 下单 → 回填 → git push
├── qmt_client.py        ← xtquant 封装（借鉴 easytrader MiniqmtTrader）
├── merge.py             ← 持仓合并（与 TS holdings-merge.ts 同逻辑的 Python 版）
├── ticker_fmt.py        ← SZ300319 ↔ 300319.SZ
├── git_sync.py          ← pull/push + safe_push 仲裁
└── config.toml          ← mini_qmt_path / account_id / repo 路径 / token
```

**`qmt_client.py`**（接口，实现借鉴 easytrader `miniqmt_trader.py`）：
```python
class QmtClient:
    def connect(self, mini_qmt_path, account_id): ...   # XtQuantTrader + StockAccount + subscribe
    def buy(self, code, price, volume) -> int: ...       # order_stock(STOCK_BUY, FIX_PRICE)
    def sell(self, code, price, volume) -> int: ...      # order_stock(STOCK_SELL, FIX_PRICE)
    def cancel(self, order_sys_id): ...
    def query_positions(self) -> list[QmtPosition]: ...  # query_stock_positions
    def query_asset(self) -> QmtAsset: ...               # query_stock_asset（总资产/现金）
    def query_orders(self) -> list: ...                  # 查委托状态判断成交
```

**`executor.py` 主流程**：
```python
def run():
    git_sync.pull()
    last = load("last_rebalance.json")

    # 幂等：终态跳过
    if is_terminal(last["execution"]["status"]):
        log("order_id 已执行，跳过"); return

    # 冲突仲裁
    if git_sync.remote_has_diverged():
        remote_last = git_sync.fetch_remote_last()
        if not is_pending(remote_last["execution"]["status"]):
            log("远端已执行，放弃 push"); return

    # 标记 executing 并 push（防并发）
    last["execution"]["status"] = "executing"
    save(last); git_sync.safe_push()

    # 按 execution_sequence 下单
    asset = qmt.query_asset()               # 下单前实时查总资产（换算基准）
    fills, errors = [], []
    for step in last["execution_sequence"]:
        price = get_current_price(step["ticker"])
        volume = calc_volume(step, asset.total, price)
        try:
            order_id = qmt.buy_or_sell(step["action"], to_qmt_code(step["ticker"]), price, volume)
            filled = wait_fill_or_timeout(order_id)
            fills.append(filled)
        except Exception as e:
            errors.append({"ticker": step["ticker"], "error": str(e)})

    # 回填 execution
    last["execution"] = {
        "status": summarize(fills),          # filled/partial/failed
        "executed_at": now_iso(),
        "account_total_asset": asset.total,  # 记录换算基准供对账
        "fills": fills, "errors": errors,
    }

    # 字段级合并 holdings
    new_holdings = merge.merge_holdings(
        load("holdings.json"), qmt.query_positions(), qmt.query_asset()
    )

    git_sync.safe_push(last, new_holdings)
```

`executor` 执行崩溃恢复：重启后 git pull 看到 `status: executing` → 查 QMT 各委托状态补全 fills → 推进到终态。

### 7.3 git 同步层

**仓库**：新建 private repo（暂定名 `trading-state`），结构极简：
```
trading-state/
├── holdings.json
├── last_rebalance.json
└── README.md          ← 说明：状态仓库，双端共用，勿手动改市场字段
```

**路径隔离**：`~/.openclaw/watchlist/`（openclaw 运行时路径）与 trading-state repo（git 工作区）用**复制**解耦，不用软链（避开 Win 软链坑）。sync 脚本负责两端搬运。

**认证**：private repo 用 deploy key 或 PAT，两端各自配（git 走 SSH/HTTPS，无需暴露端口）。

**分支**：单 `main` 分支，双端都直接 push（个人状态仓库，不走 PR review）。

## 8. 幂等与故障恢复

| 故障场景 | 恢复策略 |
|---|---|
| 云服务器执行到一半崩溃 | 重启 git pull → `status: executing` → 查 QMT 委托状态补全 fills → 推进终态 |
| 同份订单被读两次 | `order_id` 相同 → 第二次直接跳过 |
| 部分成交后撤单 | `fills[].status: partial`，`execution.status: partial`，人 review 后手动补单或放弃 |
| git push 冲突 | `safe_push` 仲裁：已执行不可覆盖；都 pending 则后写胜出 |
| QMT 未登录 | executor 报错退出，execution 保持 pending，下次重试 |
| 非交易时段 | executor 检查时段，拒单写 error，execution.status: failed，等下一份订单 |

## 9. 测试策略

### 开发机端（TS，Vitest）
- `order-id.ts`：相同 actions → 相同 id；actions 顺序乱 → id 不变（规范化生效）；改任一 weight → id 变
- `execution-schema.ts`：状态流转合法性（pending→executing 合法；filled→pending 非法）
- `holdings-merge.ts`：mock QMT 持仓 + 旧 holdings → 验证合并（新仓位写入、sector 保留、清仓删除、weight 重算）
- `rebalance-cli`：跑完 plan 后 `last_rebalance.json` 含 order_id + execution:pending + execution_sequence
- 全部 mock，无需真实 QMT/网络

### 云服务器端（Python，pytest）
- `ticker_fmt.py`：SZ300319 ↔ 300319.SZ 双向
- `merge.py`：与 TS 版同输入同输出（跨语言一致性测试，固定 fixture）
- `git_sync.safe_push`：mock remote，验证两条仲裁规则
- `executor`：mock `qmt_client`（不下真单），验证状态机流转 pending→executing→filled/partial/failed
- 真实 QMT 连接测试：手动跑、不进 CI（需登录客户端）

## 10. 不做的事（YAGNI）

- **不做实时持仓查询接口** —— 第一版只做下单+回写（异步）。实时查询留待后续（届时 HTTP 方案重新评估）。
- **不做守护轮询常驻** —— 第一版手动触发 `executor.py`。守护模式后续按需加（入口循环不同，执行器代码复用）。
- **不做持仓对账告警** —— 手工 review execution.fills 即可。自动告警（成交价偏离、份额不符）后续。
- **不做多账户** —— 单账户、单券商。
- **不改 rebalancer 决策逻辑** —— execution 信封是纯增量包装，决策链路零改动。

## 11. 验收标准

1. 开发机端：`npm run rebalance` 后，`last_rebalance.json` 含合法 `order_id` + `execution:pending` + `execution_sequence`
2. 开发机端：`syncPush` 能把两文件推到 trading-state repo，冲突时按规则仲裁
3. 云服务器端：mock QMT 下，executor 能跑通 pending→filled 全流程，fills 正确回填
4. 云服务器端：真实 QMT 下，一笔小单（如 REDUCE）能真实成交并回写 holdings
5. 闭环：云服务器执行后，开发机 pull 得到真实 holdings，下次 rebalancer 用真实持仓决策
6. 隔离：Mac 上不安装 xtquant，全程不阻塞、不报错

## 12. 参考实现

| 参考项目 | 借鉴点 | 不采用 |
|---|---|---|
| easytrader (`miniqmt_trader.py`) | `xtquant` 连接/下单/查持仓的最干净实现 → `qmt_client.py` | 进程内直连（不跨平台） |
| aiagents-stock (`smart_monitor_engine.py`) | 决策 JSON → 路由 → 下单的转换思路 | 纯 Python 链路（TS 无法复用） |
| EasyXT (`qka/`) | xtquant→HTTP 桥的跨语言思路 → 验证"中介层"可行 | HTTP 实时桥（改用文件队列） |

## 13. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | git 文件队列而非 HTTP | 跨公网、异步、日频、用户偏好 github 同步 |
| D2 | 扩展 last_rebalance.json 而非新建 orders/ 目录 | 符合"两个文件为主"直觉，职责内聚，实现最简 |
| D3 | 字段级合并而非整文件覆盖 | 保住 sector 等 QMT 查不到的本地字段 |
| D4 | execution_sequence 由 Mac 写 | 单一数据源，避免 TS/Python 排序逻辑漂移 |
| D5 | 新建 private repo | holdings 含真实持仓，现有仓库 public |
| D6 | 单 main 分支 | 个人状态仓库，字段级合并兜底冲突 |
| D7 | 第一版手动触发 | 日频场景手动触发天然防误，守护轮询风险收益不划算 |
| D8 | 下单 + 回写（不含实时查询） | 第一版聚焦闭环，实时查询后续评估 |
