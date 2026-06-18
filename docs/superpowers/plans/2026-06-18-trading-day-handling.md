# 交易日处理（data_date 驱动）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 watchlist 管道按雪球数据的实际交易日（`data_date`）驱动，而非自然日，解决节假日/盘中跑出错数据的问题。

**Architecture:** 全扫后从数据现算 `data_date = max(reason.timestamp ∪ range.end)`，用它命名 raw 文件、做 diff 锚点、做幂等判定。raw 永不重跑（不可变事实），diff/derived 从 raw 重跑（可替换解读）。无交易日历、无盘后时间判定、无抽样探测。

**Tech Stack:** TypeScript（diff/derived 加工层，vitest）+ Python（snapshot 采集层，pytest）。dist 进 git，改 src 后需 `npm run build`。

**Spec:** [`../specs/2026-06-18-trading-day-handling-design.md`](../specs/2026-06-18-trading-day-handling-design.md)

---

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `src/watchlist/diff.ts` | computeDiff + data_date 计算 | **改**：todayStartMs 从数据现算；新增 `computeDataDateMs` |
| `tests/ts/watchlist/diff.test.ts` | computeDiff 测试 | **改**：新增 data_date 现算测试 |
| `skills/watchlist/scripts/snapshot.py` | 雪球全扫 | **改**：新增 `compute_data_date`；main 改 data_date 命名 + 幂等 + 元信息基于 data_date |
| `tests/scripts/test_snapshot.py` | snapshot 测试 | **改**：新增 `compute_data_date` 测试 + 幂等 integration test |
| `src/diff-cli.ts` | diff CLI | **改**：`--date` 默认最新快照；抽出 `findLatestSnapshot` |
| `src/candidates-cli.ts` | candidates CLI | **改**：`--date` 默认最新 diff；抽出 `findLatestDiff` |
| `src/scan-all-cli.ts` | 一键串跑 | **改**：diff/candidates 不带 `--date` |
| `src/watchlist/candidates.ts` | buildCandidates | **不改** |
| `src/watchlist/types.ts` | 类型 | **不改**（data_date 不持久化，无新字段） |
| `~/.openclaw/watchlist/raw/*` | 原始快照 | **不动**（不可变） |
| `~/.openclaw/watchlist/diff/*`、`derived/*` | 衍生产物 | **迁移**：用新逻辑重跑 |

> **关于 spec §5 的细化**：spec 说 `candidates-cli.ts` 不改，但 `--date` 默认值（当前是"今天自然日"）必须改成"最新 diff 文件"，否则 scan-all 跑 candidates 时找不到文件（diff 文件名是 data_date，可能 ≠ 自然日）。`buildCandidates` 逻辑确实不改，本计划 Task 4 只改 CLI 默认值。

---

## Task 1: computeDiff 的 todayStartMs 改为从数据现算

**Files:**
- Modify: `src/watchlist/diff.ts`
- Test: `tests/ts/watchlist/diff.test.ts`

这是本次修复的核心：diff 锚点从"文件名日期"改为"数据实际最新日"，节假日/盘中抓的快照才能正确匹配异动。

- [ ] **Step 1: 写失败测试——数据日期 < end_date 时锚点跟随数据**

在 `tests/ts/watchlist/diff.test.ts` 的 `describe("computeDiff", ...)` 块内，末尾（`it("A 类独立于 B 类...")` 之后）追加：

```ts
  it("todayStartMs 取自数据而非 end_date：数据日期 < end_date 时锚点跟随数据", () => {
    // 模拟节假日/盘中：文件名 end_date=06-18，但雪球数据最新只到 06-17
    // 旧逻辑(读 end_date)会因数据没 06-18 而 changes=[]（错）；新逻辑锚点=06-17 → B2 入选
    const baseline = makeSnapshot("2026-06-16", {});
    const today = makeSnapshot(TODAY, {  // TODAY="2026-06-18"，但数据里没有 06-18
      "SH688146": { name: "x", range_reason_list: [
        { begin: 200, end: YESTERDAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].new_ranges).toEqual([
      { begin: 200, end: YESTERDAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
    ]);
  });

  it("computeDataDateMs: 取所有 reason.timestamp ∪ range.end 的最大值", () => {
    const snap = makeSnapshot(TODAY, {
      "A": { name: "x", reason_list: [{ timestamp: 1000 }], range_reason_list: [{ end: 2000 }] },
      "B": { name: "y", reason_list: [{ timestamp: 5000 }], range_reason_list: [] },
      "C": { name: "z", scan_error: "timeout" },  // 失败股跳过
    });
    // {computeDataDateMs} import 见 Step 3
    expect(computeDataDateMs(snap)).toBe(5000);
  });

  it("computeDataDateMs: 全空数据返回 0", () => {
    const snap = makeSnapshot(TODAY, {
      "A": { name: "x" },
      "B": { name: "y", scan_error: "timeout" },
    });
    expect(computeDataDateMs(snap)).toBe(0);
  });
```

并在文件顶部 import 行追加 `computeDataDateMs`：

```ts
import { computeDiff, computeDataDateMs } from "../../../src/watchlist/diff";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ts/watchlist/diff.test.ts`
Expected: FAIL —— `computeDataDateMs` 未导出；第一个测试 changes 为 0（旧逻辑用 end_date=06-18 找不到数据）。

- [ ] **Step 3: 实现 computeDataDateMs + 改 computeDiff**

在 `src/watchlist/diff.ts` 顶部（`latestRange` 之后）新增：

```ts
/** 从 raw 快照的数据现算「雪球最新交易日」的毫秒时间戳（某天 00:00 北京时间）。
 *  = max(所有 reason.timestamp ∪ 所有 range.end)，跳过 scan_error 的失败股。
 *  取自数据而非文件名/元信息：节假日或盘中抓的快照，数据最新日可能 < 文件名日期，
 *  锚点必须跟随实际数据，diff 才不会漏掉真实异动。全空数据返回 0。 */
export function computeDataDateMs(raw: RawSnapshotFile): number {
  let maxTs = 0;
  for (const entry of Object.values(raw.stocks)) {
    if (entry.scan_error) continue;
    for (const r of entry.reason_list ?? []) {
      if (r.timestamp > maxTs) maxTs = r.timestamp;
    }
    for (const rg of entry.range_reason_list ?? []) {
      if (rg.end > maxTs) maxTs = rg.end;
    }
  }
  return maxTs;
}
```

改 `computeDiff`——把第一行 `const todayStartMs = Date.parse(today.end_date + "T00:00:00+08:00");` 替换为：

```ts
  const todayStartMs = computeDataDateMs(today);
```

并删除函数上方注释里"用 `=== todayStartMs` 精确比较即可"前关于 end_date 的描述（保留精度说明）。computeDiff 其余逻辑（A/B1/B2 判定）不变。

- [ ] **Step 4: 跑全部测试确认通过**

Run: `npx vitest run tests/ts/watchlist/diff.test.ts`
Expected: PASS（含新 3 个测试 + 全部原有测试）。

> 验证点：原有测试里 `TODAY_MS` 都是数据中的最大值，现算结果 = `TODAY_MS`，故原有测试行为不变。

- [ ] **Step 5: build + commit**

```bash
npm run build
git add src/watchlist/diff.ts tests/ts/watchlist/diff.test.ts dist/watchlist/diff.js dist/watchlist/diff.js.map dist/watchlist/diff.d.ts dist/watchlist/diff.d.ts.map
git commit -m "fix(watchlist): diff 锚点改为从数据现算 data_date，节假日/盘中不再丢异动" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: snapshot.py — compute_data_date + 幂等 + data_date 命名

**Files:**
- Modify: `skills/watchlist/scripts/snapshot.py`
- Test: `tests/scripts/test_snapshot.py`

snapshot 全扫后算 `data_date`，用它命名文件、做幂等检查；raw 元信息（scan_date/end_date/begin）全部基于 `data_date`。查询窗口仍用 `scan_target`（--date 或今天）。

- [ ] **Step 1: 写失败测试——compute_data_date**

在 `tests/scripts/test_snapshot.py` 顶部 import 行追加 `compute_data_date`：

```python
from snapshot import compute_window, parse_xueqiu_response, compute_data_date  # noqa: E402
```

在文件末尾追加：

```python
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
```

并在文件顶部 import 区追加（若未有）：

```python
from datetime import datetime, timezone, timedelta
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest tests/scripts/test_snapshot.py -v`
Expected: FAIL —— `compute_data_date` 未定义（ImportError）。

- [ ] **Step 3: 实现 compute_data_date**

在 `skills/watchlist/scripts/snapshot.py` 的 `parse_xueqiu_response` 之后新增：

```python
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pytest tests/scripts/test_snapshot.py::test_compute_data_date_max_of_timestamps_and_ends tests/scripts/test_snapshot.py::test_compute_data_date_skips_scan_error tests/scripts/test_snapshot.py::test_compute_data_date_returns_none_when_empty tests/scripts/test_snapshot.py::test_compute_data_date_picks_range_end_when_larger -v`
Expected: PASS。

- [ ] **Step 5: 写失败测试——幂等（已有 data_date 快照则跳过，不写文件）**

在 `tests/scripts/test_snapshot.py` 末尾追加 integration test（mock 网络 + 真实文件系统）：

```python
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
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pytest tests/scripts/test_snapshot.py::test_main_idempotent_skips_when_data_date_exists tests/scripts/test_snapshot.py::test_main_writes_data_date_named_file_when_new -v`
Expected: FAIL —— 当前 main 用 scan_target 命名文件（写 06-18.json），且无幂等检查。

- [ ] **Step 7: 改 main——查询窗口用 scan_target，存储用 data_date + 幂等**

替换 `skills/watchlist/scripts/snapshot.py` 的 `main()` 函数（从 `watchlist_dir = args.watchlist_dir or ...` 到函数末尾）为：

```python
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

    total = len(stocks_list)
    # 查询窗口（传雪球）：基于 scan_target
    q_begin_ms, q_end_ms, _, _ = compute_window(scan_target)
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
```

- [ ] **Step 8: 跑全部 snapshot 测试确认通过**

Run: `pytest tests/scripts/test_snapshot.py -v`
Expected: PASS（含原有 compute_window/parse 测试 + 新 compute_data_date + 2 个幂等 integration 测试）。

- [ ] **Step 9: commit**

```bash
git add skills/watchlist/scripts/snapshot.py tests/scripts/test_snapshot.py
git commit -m "feat(watchlist): snapshot 改 data_date 命名 + 幂等，元信息基于数据日期" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: diff-cli — `--date` 默认最新快照

**Files:**
- Modify: `src/diff-cli.ts`
- Test: `tests/ts/diff-cli.test.ts`（新建）

- [ ] **Step 1: 写失败测试——findLatestSnapshot**

新建 `tests/ts/diff-cli.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findLatestSnapshot } from "../../src/diff-cli";

describe("findLatestSnapshot", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("返回 raw 目录里日期最大的快照", () => {
    const raw = path.join(tmp, "raw");
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(raw, "2026-06-16.json"), "{}");
    fs.writeFileSync(path.join(raw, "2026-06-18.json"), "{}");
    fs.writeFileSync(path.join(raw, "2026-06-17.json"), "{}");
    expect(findLatestSnapshot(tmp)).toBe("2026-06-18");
  });

  it("raw 目录不存在返回 null", () => {
    expect(findLatestSnapshot(tmp)).toBeNull();
  });

  it("raw 目录空返回 null", () => {
    fs.mkdirSync(path.join(tmp, "raw"));
    expect(findLatestSnapshot(tmp)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ts/diff-cli.test.ts`
Expected: FAIL —— `findLatestSnapshot` 未导出。

- [ ] **Step 3: 抽出 findLatestSnapshot + 改 main 默认 --date**

在 `src/diff-cli.ts` 的 `findLatestBaseline` 之后新增（并 `export`）：

```ts
/** raw 目录里日期最大的快照（= 最新 data_date）。目录不存在或空返回 null。 */
export function findLatestSnapshot(dir: string): string | null {
  const rawDir = path.join(dir, "raw");
  if (!fs.existsSync(rawDir)) return null;
  const dates = fs.readdirSync(rawDir)
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}
```

改 `main()` 里的 `date` 解析（把 `?? new Date().toISOString().split("T")[0]` 换成 `?? findLatestSnapshot(watchlistDir)`）：

```ts
  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : findLatestSnapshot(watchlistDir);
```

并在 `today = readRaw(...)` 前加空判断：

```ts
  if (!date) {
    console.error(`error: 没有任何快照，请先运行 npm run snapshot`);
    process.exit(1);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ts/diff-cli.test.ts`
Expected: PASS。

- [ ] **Step 5: build + commit**

```bash
npm run build
git add src/diff-cli.ts tests/ts/diff-cli.test.ts dist/diff-cli.js dist/diff-cli.js.map dist/diff-cli.d.ts dist/diff-cli.d.ts.map
git commit -m "feat(watchlist): diff-cli --date 默认最新快照(data_date)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: candidates-cli — `--date` 默认最新 diff

**Files:**
- Modify: `src/candidates-cli.ts`
- Test: `tests/ts/candidates-cli.test.ts`（新建）

- [ ] **Step 1: 写失败测试——findLatestDiff**

新建 `tests/ts/candidates-cli.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findLatestDiff } from "../../src/candidates-cli";

describe("findLatestDiff", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("返回 diff 目录里日期最大的文件", () => {
    const diff = path.join(tmp, "diff");
    fs.mkdirSync(diff);
    fs.writeFileSync(path.join(diff, "2026-06-16.json"), "{}");
    fs.writeFileSync(path.join(diff, "2026-06-17.json"), "{}");
    expect(findLatestDiff(tmp)).toBe("2026-06-17");
  });

  it("diff 目录不存在返回 null", () => {
    expect(findLatestDiff(tmp)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ts/candidates-cli.test.ts`
Expected: FAIL —— `findLatestDiff` 未导出。

- [ ] **Step 3: 抽出 findLatestDiff + 改 main 默认 --date**

在 `src/candidates-cli.ts` 的 `readJson` 之后新增（并 `export`）：

```ts
/** diff 目录里日期最大的文件（= 最新 data_date 的 diff）。不存在返回 null。 */
export function findLatestDiff(dir: string): string | null {
  const diffDir = path.join(dir, "diff");
  if (!fs.existsSync(diffDir)) return null;
  const dates = fs.readdirSync(diffDir)
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}
```

改 `main()` 里的 `date` 解析：

```ts
  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : findLatestDiff(watchlistDir);
```

并在读 diff 前加空判断：

```ts
  if (!date) {
    console.error(`error: 没有任何 diff，请先运行 npm run diff`);
    process.exit(1);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ts/candidates-cli.test.ts`
Expected: PASS。

- [ ] **Step 5: build + commit**

```bash
npm run build
git add src/candidates-cli.ts tests/ts/candidates-cli.test.ts dist/candidates-cli.js dist/candidates-cli.js.map dist/candidates-cli.d.ts dist/candidates-cli.d.ts.map
git commit -m "feat(watchlist): candidates-cli --date 默认最新 diff(data_date)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: scan-all — diff/candidates 不带 `--date`

**Files:**
- Modify: `src/scan-all-cli.ts`

snapshot 自带幂等 + data_date 命名，diff/candidates 的 `--date` 默认已是"最新"，scan-all 只需把 `--date` 透传给 snapshot 当查询上限。

- [ ] **Step 1: 改 scan-all，diff/candidates 不传 --date**

`src/scan-all-cli.ts` 的 `main()` 里，把：

```ts
  runPython("scan_universe.py", [], watchlistDir);
  runPython("snapshot.py", ["--date", date, "--concurrency", concurrency], watchlistDir);
  runNode("diff-cli.js", ["--date", date], watchlistDir);
  runNode("candidates-cli.js", ["--date", date], watchlistDir);
```

改为：

```ts
  runPython("scan_universe.py", [], watchlistDir);
  runPython("snapshot.py", ["--date", date, "--concurrency", concurrency], watchlistDir);
  runNode("diff-cli.js", [], watchlistDir);          // 默认最新快照
  runNode("candidates-cli.js", [], watchlistDir);    // 默认最新 diff
```

（`date` 仍只用于 snapshot 的查询上限，逻辑不变。）

- [ ] **Step 2: 跑全部测试确认无回归**

Run: `npm test && pytest tests/scripts/ -v`
Expected: PASS（全部 TS + Python 测试）。

- [ ] **Step 3: build + commit**

```bash
npm run build
git add src/scan-all-cli.ts dist/scan-all-cli.js dist/scan-all-cli.js.map dist/scan-all-cli.d.ts dist/scan-all-cli.d.ts.map
git commit -m "refactor(watchlist): scan-all 的 diff/candidates 用默认最新(data_date)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 迁移现有 06-16 / 06-17 产物

**Files:**
- 不动：`~/.openclaw/watchlist/raw/2026-06-16.json`、`raw/2026-06-17.json`（不可变事实）
- 重跑覆盖：`~/.openclaw/watchlist/diff/*`、`derived/*`

raw 不重跑（06-16 的雪球数据已抓不回）。用新逻辑从现有 raw 重算 diff + derived。

- [ ] **Step 1: 确认 build 是最新**

Run: `npm run build`
Expected: 编译成功。

- [ ] **Step 2: 重跑 06-16 的 diff + candidates**

```bash
node dist/diff-cli.js --date 2026-06-16
node dist/candidates-cli.js --date 2026-06-16
```
Expected: diff-cli 输出"变更股票数"（06-16 是首次扫描 baseline 空，应只剩当日异动，不再 37M）；candidates 输出"上涨候选"（不再全 null）。

- [ ] **Step 3: 重跑 06-17 的 diff + candidates**

```bash
node dist/diff-cli.js --date 2026-06-17
node dist/candidates-cli.js --date 2026-06-17
```
Expected: 正常生成，diff 用新 computeDiff（todayStartMs 现算）。

- [ ] **Step 4: 验证产物自洽**

```bash
ls -lh ~/.openclaw/watchlist/diff/
jq -c '{scan_date, baseline, changes: (.changes|length)}' ~/.openclaw/watchlist/diff/2026-06-16.json
jq -c '.up[0]' ~/.openclaw/watchlist/derived/2026-06-16-candidates.json
```
Expected:
- `diff/2026-06-16.json` 不再是 37M（合理大小，几 MB 以内）
- 06-16 diff 的 changes 有合理数量（首次扫描 baseline=""，当日异动）
- 06-16 candidates 的 `up[0]` 不再是 `range_kind: null`，有完整 range/days

- [ ] **Step 5: 验证 raw 未被动**

```bash
ls -lh ~/.openclaw/watchlist/raw/
```
Expected: `raw/2026-06-16.json`、`raw/2026-06-17.json` 仍是原 32M，修改时间未变（未被重写）。

> 注：产物在 `~/.openclaw/watchlist/`（git 之外），不需 commit。此任务验证完成后即结束。

---

## Self-Review（plan 作者已执行）

**Spec 覆盖**：
- §4.1 data_date 概念 → Task 1 (TS computeDataDateMs) + Task 2 (Python compute_data_date)
- §4.2 snapshot 流程（全扫→算 data_date→幂等→data_date 命名→元信息基于 data_date）→ Task 2
- §4.3 diff 流程（todayStartMs 现算 + baseline 上一快照）→ Task 1 + Task 3
- §5 各文件改造 → Task 1-5（candidates.ts/types.ts 确实不改）
- §6 CLI 参数（无新增）→ Task 3/4 改默认值，Task 5 scan-all 适配
- §7 迁移（raw 不动，diff/derived 重跑）→ Task 6
- §8 测试（computeDataDate/computeDiff/幂等）→ Task 1/2 测试

**Placeholder 扫描**：无 TBD/TODO，每个代码步骤都有完整代码。

**类型一致**：`computeDataDateMs`（TS）/ `compute_data_date`（Python）名称跨任务一致；`findLatestSnapshot` / `findLatestDiff` 命名一致；data_date 在 snapshot 命名、diff 现算、CLI 默认三处语义统一。
