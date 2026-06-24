// src/watchlist/execution-bridge.ts
//
// syncPush：开发机跑完 rebalancer 后，把 holdings.json + last_rebalance.json
// 推到 trading-state private repo。
//
// 开发机端 push 语义：永远只推 pending 订单。冲突时只处理一种情况——
// 本地 pending 撞远端非 pending（已执行）。撞了就 abort + 提示 pull，
// 不尝试后写覆盖（开发机不产执行结果，没有"更新"一说）。
// 云服务器的 safe_push 规则 2（都 pending 后写胜出）只对它自己有意义。

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

function git(repoDir: string, cmd: string): string {
  try {
    return execSync(`git -C ${repoDir} ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(`git 命令失败: git ${cmd} — ${e instanceof Error ? e.message : e}`);
  }
}

/** 检查远端 main 是否领先本地（origin/main 有本地没有的提交）。 */
function remoteHasNewCommits(repoDir: string): boolean {
  git(repoDir, "fetch origin main");
  const count = git(repoDir, "rev-list --count main..origin/main");
  return parseInt(count, 10) > 0;
}

/** 读远端 main 的 last_rebalance.json。 */
function readRemoteLastRebalance(repoDir: string): LastRebalance {
  const raw = git(repoDir, "show origin/main:last_rebalance.json");
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

  // 复制两文件到 repo
  for (const f of ["holdings.json", "last_rebalance.json"]) {
    const src = path.join(watchlistDir, f);
    const dst = path.join(stateRepoDir, f);
    if (!fs.existsSync(src)) {
      throw new Error(`源文件不存在: ${src}`);
    }
    fs.copyFileSync(src, dst);
  }

  // 冲突仲裁：远端有新提交时检查
  if (remoteHasNewCommits(stateRepoDir)) {
    const remoteLast = readRemoteLastRebalance(stateRepoDir);
    const localLast = JSON.parse(
      fs.readFileSync(path.join(stateRepoDir, "last_rebalance.json"), "utf-8"),
    ) as LastRebalance;
    // 本地 pending 撞远端非 pending → 拒绝（已执行不可覆盖）
    if (localLast.execution && isPending(localLast.execution.status) &&
        remoteLast.execution && !isPending(remoteLast.execution.status)) {
      throw new ConflictAbortedError(
        remoteLast.order_id ?? "(无)",
        remoteLast.execution.status,
      );
    }
    // 都 pending 或本地非 pending：后写胜出，正常 push
  }

  // push
  git(stateRepoDir, "add holdings.json last_rebalance.json");
  git(stateRepoDir, 'commit -m "chore(state): sync from rebalancer" --allow-empty');
  git(stateRepoDir, "push origin main");
}
