// 真实 git 集成测试：用临时 git repo（git init --bare 作 origin）验证 syncPush
// 在真实 git 下的 push/冲突行为。这是 I1 修复的验收核心——mock 测试无法抓到
// 真实的 non-fast-forward 拒绝，这里覆盖"后写胜出"在真实 git 下确实能 push 成功。
//
// 跳过条件：环境无 git → 整个 describe skip（CI 有 git，正常跑）。

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { syncPush, ConflictAbortedError } from "../../../src/watchlist/execution-bridge";
import type { Holdings, LastRebalance } from "../../../src/watchlist/rebalance-types";

const HAS_GIT = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

// 模拟 A 股 holdings + pending last_rebalance 基线
const baseHoldings: Holdings = {
  updated_at: "2026-06-20T20:00:00+08:00",
  cash_pct: 0.90,
  positions: [
    { ticker: "SZ300319", name: "麦捷科技", weight: 0.10, entry_price: 25, entry_date: "2026-06-15", shares: 200, sector: "电子" },
  ],
};

const pendingLast = (orderId: string): LastRebalance => ({
  date: "2026-06-23",
  order_id: orderId,
  actions: [{ action: "SELL", ticker: "SZ300319", weight: 0 }],
  execution: { status: "pending", executed_at: null, account_total_asset: null, fills: [], errors: [] },
});

const filledLast = (orderId: string): LastRebalance => ({
  date: "2026-06-23",
  order_id: orderId,
  actions: [{ action: "SELL", ticker: "SZ300319", weight: 0 }],
  execution: {
    status: "filled", executed_at: "2026-06-23T15:00:00+08:00",
    account_total_asset: 100000, fills: [], errors: [],
  },
});

/** 在 dir 跑一条 git 命令（cwd=dir），失败抛错。 */
function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** 写两文件并 commit + push 到 origin main。 */
function writeAndCommit(dir: string, holdings: Holdings, last: LastRebalance, msg: string): void {
  fs.writeFileSync(path.join(dir, "holdings.json"), JSON.stringify(holdings, null, 2));
  fs.writeFileSync(path.join(dir, "last_rebalance.json"), JSON.stringify(last, null, 2));
  gitIn(dir, ["add", "holdings.json", "last_rebalance.json"]);
  gitIn(dir, ["commit", "-m", msg]);
  gitIn(dir, ["push", "origin", "main"]);
}

/** 读 origin main 的 last_rebalance.json。 */
function readOriginLast(originDir: string): LastRebalance {
  const raw = gitIn(originDir, ["show", "main:last_rebalance.json"]);
  return JSON.parse(raw) as LastRebalance;
}

// CI 环境的 git 可能默认无 user.email/name，commit 会失败。统一设个本地身份。
function setupFixture(): { watchlistDir: string; workRepo: string; originDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ebgit-"));
  const originDir = path.join(root, "origin.git");
  const workRepo = path.join(root, "work");
  const watchlistDir = path.join(root, "watchlist");
  fs.mkdirSync(watchlistDir);

  // bare origin + work clone
  gitIn(root, ["init", "--bare", originDir]);
  gitIn(root, ["clone", originDir, workRepo]);
  // 配身份（clone 后在 work repo 设；CI 环境可能无全局 user.email/name）
  gitIn(workRepo, ["config", "user.email", "test@example.com"]);
  gitIn(workRepo, ["config", "user.name", "test"]);

  // 基线提交：work repo 写初始两文件 → push 到 origin
  writeAndCommit(workRepo, baseHoldings, pendingLast("2026-06-23-base000"), "baseline");

  return { watchlistDir, workRepo, originDir };
}

describe.skipIf(!HAS_GIT)("syncPush — 真实 git 集成", () => {
  let root: string;
  let watchlistDir: string;
  let workRepo: string;
  let originDir: string;

  beforeEach(() => {
    const fx = setupFixture();
    root = path.dirname(fx.originDir);
    watchlistDir = fx.watchlistDir;
    workRepo = fx.workRepo;
    originDir = fx.originDir;
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("无分叉 → push 成功，origin/main 更新为本地内容", async () => {
    // watchlistDir 写一份新 pending，syncPush 推上去（work repo 已与 origin 一致）
    const mine = pendingLast("2026-06-23-mine000");
    fs.writeFileSync(path.join(watchlistDir, "holdings.json"), JSON.stringify({ ...baseHoldings, cash_pct: 0.80 }, null, 2));
    fs.writeFileSync(path.join(watchlistDir, "last_rebalance.json"), JSON.stringify(mine, null, 2));

    await syncPush(watchlistDir, workRepo);

    const originLast = readOriginLast(originDir);
    expect(originLast.order_id).toBe("2026-06-23-mine000");
    expect(originLast.execution!.status).toBe("pending");
  });

  it("后写胜出：A 机先 push pending，B 机（落后）syncPush 自己的 pending → 成功 push（I1 核心）", async () => {
    // 模拟 A 机：在 work repo 直接写 A 的 pending 并 push（work 现在与 origin 一致，可 push）
    writeAndCommit(workRepo, baseHoldings, pendingLast("2026-06-23-AAAAAA"), "A 机订单");

    // 此时 workRepo 已是最新（A 的）。为模拟 B 机落后，我们需要让 workRepo 回到分叉前状态。
    // 但 syncPush 用 workRepo 当 repo——这里我们把 workRepo 当 B 机：它本地 main 落后 origin。
    // 实际上 A 刚从 work push，work=origin。为造出"B 落后"，reset work 到 A 之前。
    gitIn(workRepo, ["reset", "--hard", "HEAD~1"]);  // work 退回 baseline，origin 留着 A 的提交

    // B 机（=watchlistDir 源 + workRepo）要推自己的 pending（不同于 A）
    const bOrder = pendingLast("2026-06-23-BBBBBB");
    fs.writeFileSync(path.join(watchlistDir, "holdings.json"), JSON.stringify(baseHoldings, null, 2));
    fs.writeFileSync(path.join(watchlistDir, "last_rebalance.json"), JSON.stringify(bOrder, null, 2));

    // 旧实现（直接 commit+push）：work 落后 origin → push non-fast-forward 被拒 → 抛错。
    // 新实现：仲裁判定都 pending → reset --hard origin/main（对齐 A）→ 复制 B → push 成功。
    await syncPush(watchlistDir, workRepo);

    const originLast = readOriginLast(originDir);
    expect(originLast.order_id).toBe("2026-06-23-BBBBBB");  // 后写 B 胜出
  });

  it("本地 pending 撞远端 filled → 抛 ConflictAbortedError，origin 不变", async () => {
    // A 机：work repo 推一份 filled（模拟云服务器已执行回填）
    writeAndCommit(workRepo, baseHoldings, filledLast("2026-06-23-executed"), "已执行");
    // 让 work 落后 origin（模拟 B 机本地旧状态）
    gitIn(workRepo, ["reset", "--hard", "HEAD~1"]);

    // B 机：watchlistDir 写一份新的 pending 要推
    fs.writeFileSync(path.join(watchlistDir, "holdings.json"), JSON.stringify(baseHoldings, null, 2));
    fs.writeFileSync(path.join(watchlistDir, "last_rebalance.json"),
      JSON.stringify(pendingLast("2026-06-23-newpending"), null, 2));

    await expect(syncPush(watchlistDir, workRepo)).rejects.toThrow(ConflictAbortedError);

    // origin 仍是 A 的 filled，未被 B 覆盖
    const originLast = readOriginLast(originDir);
    expect(originLast.execution!.status).toBe("filled");
    expect(originLast.order_id).toBe("2026-06-23-executed");
  });
});
