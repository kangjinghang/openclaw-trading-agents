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
// mock child_process（git 操作）
const execMock = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => execMock(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.existsSync.mockReturnValue(true);
  // 默认：git 命令成功；远端无分叉（rev-list count = 0）
  execMock.mockImplementation((cmd: string) => {
    if (cmd.includes("rev-list --count")) return "0";
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
    const gitCalls = execMock.mock.calls.map(c => c[0] as string).join(" ");
    expect(gitCalls).toContain(" add holdings.json last_rebalance.json");
    expect(gitCalls).toContain(' commit -m "chore(state): sync from rebalancer"');
    expect(gitCalls).toContain(" push origin main");
  });
});

describe("syncPush — 冲突仲裁", () => {
  it("本地 pending 撞远端 filled → 抛 ConflictAbortedError", async () => {
    const remoteFilled = JSON.stringify({
      ...pendingLast(),
      execution: { status: "filled", executed_at: "2026-06-23T15:00:00Z", account_total_asset: 100000, fills: [], errors: [] },
    });
    const localPending = JSON.stringify(pendingLast());
    // 远端有分叉
    execMock.mockImplementation((cmd: string) => {
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
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list --count")) return "1";
      if (cmd.includes("show origin/main:last_rebalance.json")) return remotePending;
      return "";
    });
    fsMock.readFileSync.mockReturnValue(localPending);

    await expect(syncPush("/watchlist", "/state-repo")).resolves.toBeUndefined();
    const gitCalls = execMock.mock.calls.map(c => c[0] as string).join(" ");
    expect(gitCalls).toContain(" push origin main");
  });
});
