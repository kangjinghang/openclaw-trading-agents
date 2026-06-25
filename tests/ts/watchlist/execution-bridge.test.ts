import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { syncPush, ConflictAbortedError } from "../../../src/watchlist/execution-bridge";
import type { LastRebalance } from "../../../src/watchlist/rebalance-types";

// mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
// mock child_process（git 操作）。execFileSync 签名：(file, args, options)
const execMock = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => execMock(...args),
}));

const fsMock = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  copyFileSync: ReturnType<typeof vi.fn>;
};

const pendingLast = (): LastRebalance => ({
  date: "2026-06-23",
  order_id: "2026-06-23-abc123",
  actions: [{ action: "SELL", ticker: "SZ300319", weight: 0 }],
  execution: { status: "pending", executed_at: null, account_total_asset: null, fills: [], errors: [] },
});

/** 把 execMock 调用记录收集成 git 子命令字符串列表（去掉 "-C <repo>" 前缀），便于断言。 */
function gitCallArgs(): string[] {
  return execMock.mock.calls.map(c => (c[1] as string[]).slice(2).join(" "));
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.existsSync.mockReturnValue(true);
  // 默认：远端无分叉（rev-list count=0）；暂存区有变更（diff --cached --quiet 抛 status=1 = exit 1）
  execMock.mockImplementation((_file: string, args: string[]) => {
    const cmd = args.join(" ");
    if (cmd.includes("rev-list --count")) return "0";
    if (cmd.includes("diff --cached --quiet")) {
      const e = new Error("exit status 1");
      (e as { status?: number }).status = 1;
      throw e;
    }
    return "";
  });
});

describe("syncPush — 正常流程", () => {
  it("复制两文件 + git add/commit/push", async () => {
    await syncPush("/watchlist", "/state-repo");
    // path.join 在 Win 产出反斜杠，用 path 拼接断言保证跨平台一致
    expect(fsMock.copyFileSync).toHaveBeenCalledWith(
      path.join("/watchlist", "holdings.json"),
      path.join("/state-repo", "holdings.json"),
    );
    expect(fsMock.copyFileSync).toHaveBeenCalledWith(
      path.join("/watchlist", "last_rebalance.json"),
      path.join("/state-repo", "last_rebalance.json"),
    );
    const calls = gitCallArgs();
    expect(calls).toContain("add holdings.json last_rebalance.json");
    expect(calls).toContain("commit -m chore(state): sync from rebalancer");
    expect(calls).toContain("push origin main");
  });

  it("无变更（重跑同一天 actions 一致）→ 跳过 commit/push，不抛错", async () => {
    // 暂存区无差异：diff --cached --quiet exit 0（不抛错）
    execMock.mockImplementation((_file: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("rev-list --count")) return "0";
      return "";
    });

    await expect(syncPush("/watchlist", "/state-repo")).resolves.toBeUndefined();

    const calls = gitCallArgs();
    expect(calls).toContain("add holdings.json last_rebalance.json");
    expect(calls).not.toContain("commit -m chore(state): sync from rebalancer");
    expect(calls).not.toContain("push origin main");
  });
});

// 注意：本文件 mock 了 fs + child_process，只验证 syncPush 的控制流
// （复制顺序、abort 时机、git 命令序列、无变更跳过）。它**不能**验证真实 git 的
// fast-forward/push/diff 行为——"后写胜出"与"无变更跳过"在真实 git 下是否如预期
// 由 execution-bridge-git.test.ts（真实临时 git repo）覆盖。
describe("syncPush — 冲突仲裁", () => {
  it("本地 pending 撞远端 filled → 抛 ConflictAbortedError", async () => {
    const remoteFilled = JSON.stringify({
      ...pendingLast(),
      execution: { status: "filled", executed_at: "2026-06-23T15:00:00Z", account_total_asset: 100000, fills: [], errors: [] },
    });
    const localPending = JSON.stringify(pendingLast());
    // 远端有分叉
    execMock.mockImplementation((_file: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("rev-list --count")) return "1";
      if (cmd.includes("show origin/main:last_rebalance.json")) return remoteFilled;
      return "";
    });
    // 复制后 readFileSync 读到本地 pending 版本
    fsMock.readFileSync.mockReturnValue(localPending);

    await expect(syncPush("/watchlist", "/state-repo")).rejects.toThrow(ConflictAbortedError);
  });

  it("本地 pending 撞远端 pending → 后写胜出（不抛错，正常 push）", async () => {
    const remotePending = JSON.stringify(pendingLast());
    const localPending = JSON.stringify(pendingLast());
    execMock.mockImplementation((_file: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("rev-list --count")) return "1";
      if (cmd.includes("show origin/main:last_rebalance.json")) return remotePending;
      if (cmd.includes("diff --cached --quiet")) {
        const e = new Error("exit status 1");
        (e as { status?: number }).status = 1;
        throw e;
      }
      return "";
    });
    fsMock.readFileSync.mockReturnValue(localPending);

    await expect(syncPush("/watchlist", "/state-repo")).resolves.toBeUndefined();
    const calls = gitCallArgs();
    expect(calls).toContain("push origin main");
  });
});
