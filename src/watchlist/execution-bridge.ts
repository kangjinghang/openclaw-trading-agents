// src/watchlist/execution-bridge.ts
//
// syncPush：开发机跑完 rebalancer 后，把 holdings.json + last_rebalance.json
// 推到 trading-state private repo。
//
// 开发机端 push 语义：永远只推 pending 订单。冲突时分两种：
//   1. 本地 pending 撞远端非 pending（已执行）→ abort + 提示 pull（已执行不可覆盖）
//   2. 本地 pending 撞远端 pending（都未执行）→ 后写胜出（覆盖远端）
// 后写胜出的实现：把本地工作区对齐到 origin/main（reset --hard），再覆盖我们要推的
// 两文件 → commit → push 必 fast-forward。注意 reset 必须在 copyFileSync 之前，
// 否则会吞掉刚复制的文件。
// 云服务器 safe_push 规则 2 同语义（它也产出 filled，但只对自己的 pending/远端 pending 仲裁）。

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { LastRebalance } from "./rebalance-types";
import { isPending } from "./execution-schema";

/** 本地 pending 撞远端已执行（非 pending）→ 拒绝 push。 */
export class ConflictAbortedError extends Error {
  constructor(remoteOrderId: string, remoteStatus: string) {
    super(`远端订单 ${remoteOrderId} 已执行（status=${remoteStatus}），本地 pending 不能覆盖，请 git pull`);
    this.name = "ConflictAbortedError";
  }
}

/** 运行一条 git 命令，返回 stdout（trim）。失败时把 stderr 一起拼进报错便于诊断。 */
function git(repoDir: string, cmd: string): string {
  try {
    return execSync(`git -C ${repoDir} ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    const stderr = (e as { stderr?: unknown }).stderr;
    const detail = stderr ? ` stderr: ${String(stderr).trim()}` : "";
    throw new Error(`git 命令失败: git ${cmd} — ${e instanceof Error ? e.message : e}${detail}`);
  }
}

/** 读远端 main 的 last_rebalance.json（需先 fetch）。 */
function readRemoteLastRebalance(repoDir: string): LastRebalance {
  const raw = git(repoDir, "show origin/main:last_rebalance.json");
  return JSON.parse(raw) as LastRebalance;
}

/** 读取要推送的本地 last_rebalance.json（从 watchlistDir 源文件，非 repo 工作区）。 */
function readLocalLastRebalance(watchlistDir: string): LastRebalance {
  const raw = fs.readFileSync(path.join(watchlistDir, "last_rebalance.json"), "utf-8");
  return JSON.parse(raw) as LastRebalance;
}

/**
 * 把 watchlist 目录的两文件推到 trading-state repo。
 * @param watchlistDir ~/.openclaw/watchlist 路径
 * @param stateRepoDir trading-state repo 本地路径
 * @throws ConflictAbortedError 本地 pending 撞远端已执行
 */
export async function syncPush(watchlistDir: string, stateRepoDir: string): Promise<void> {
  if (!fs.existsSync(stateRepoDir)) {
    throw new Error(`trading-state repo 不存在: ${stateRepoDir}，请先 clone`);
  }

  // 1. fetch + 冲突仲裁 + 对齐远端（全部在复制文件之前）
  git(stateRepoDir, "fetch origin main");
  const remoteAheadCount = parseInt(git(stateRepoDir, "rev-list --count main..origin/main"), 10);
  if (remoteAheadCount > 0) {
    // 远端有本地没有的提交 → 可能冲突，先仲裁
    const remoteLast = readRemoteLastRebalance(stateRepoDir);
    const localLast = readLocalLastRebalance(watchlistDir);
    // 规则 1：本地 pending 撞远端非 pending（已执行）→ 拒绝
    if (localLast.execution && isPending(localLast.execution.status) &&
        remoteLast.execution && !isPending(remoteLast.execution.status)) {
      throw new ConflictAbortedError(
        remoteLast.order_id ?? "(无)",
        remoteLast.execution.status,
      );
    }
    // 规则 2：其余情况（都 pending，或本地非 pending）→ 后写胜出
    // 对齐到远端 HEAD；因还没复制我们的文件，reset 不丢数据
    git(stateRepoDir, "reset --hard origin/main");
  }

  // 2. 复制两文件到 repo（此时工作区已与远端一致，我们的内容覆盖上去）
  for (const f of ["holdings.json", "last_rebalance.json"]) {
    const src = path.join(watchlistDir, f);
    const dst = path.join(stateRepoDir, f);
    if (!fs.existsSync(src)) {
      throw new Error(`源文件不存在: ${src}`);
    }
    fs.copyFileSync(src, dst);
  }

  // 3. commit + push（push 必 fast-forward，不会被 non-fast-forward 拒）
  git(stateRepoDir, "add holdings.json last_rebalance.json");
  git(stateRepoDir, 'commit -m "chore(state): sync from rebalancer"');
  git(stateRepoDir, "push origin main");
}
