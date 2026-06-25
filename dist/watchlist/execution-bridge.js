"use strict";
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
// commit 前先查暂存区：重跑同一天时两文件字节级一致（order_id 是 actions 的纯函数，
// holdings 源文件在 rebalance 期间不被改写）→ nothing to commit 会让 git commit
// exit 1，故无差异时跳过 commit/push。
// 云服务器 safe_push 规则 2 同语义（它也产出 filled，但只对自己的 pending/远端 pending 仲裁）。
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConflictAbortedError = void 0;
exports.syncPush = syncPush;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const execution_schema_1 = require("./execution-schema");
/** 本地 pending 撞远端已执行（非 pending）→ 拒绝 push。 */
class ConflictAbortedError extends Error {
    constructor(remoteOrderId, remoteStatus) {
        super(`远端订单 ${remoteOrderId} 已执行（status=${remoteStatus}），本地 pending 不能覆盖，请 git pull`);
        this.name = "ConflictAbortedError";
    }
}
exports.ConflictAbortedError = ConflictAbortedError;
/** 运行一条 git 命令，返回 stdout（trim）。失败时把 stderr 一起拼进报错便于诊断。
 *
 *  用 execFileSync（数组参数）而非 execSync（拼字符串）：repoDir 来自用户输入
 *  （--sync / TRADING_STATE_REPO env），数组形式杜绝路径里的空格/分号被 shell 解释；
 *  timeout 防止 fetch/push 在网络挂起或交互式认证时永久阻塞 rebalance 进程。 */
function git(repoDir, args) {
    try {
        return (0, child_process_1.execFileSync)("git", ["-C", repoDir, ...args], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 60000,
        }).trim();
    }
    catch (e) {
        const stderr = e.stderr;
        const detail = stderr ? ` stderr: ${String(stderr).trim()}` : "";
        throw new Error(`git 命令失败: git ${args.join(" ")} — ${e instanceof Error ? e.message : e}${detail}`);
    }
}
/** 暂存区是否有变更。git diff --cached --quiet：无差异 exit 0，有差异 exit 1。
 *  单独封装是因为 exit 1 在这里是"预期信号"，git() 会把它当错误抛出。 */
function hasStagedChanges(repoDir) {
    try {
        (0, child_process_1.execFileSync)("git", ["-C", repoDir, "diff", "--cached", "--quiet"], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 30000,
        });
        return false;
    }
    catch (e) {
        // exit 1 = 有差异（预期）；timeout（signal=SIGTERM）或其他退出码才是真错误
        if (e.status === 1)
            return true;
        throw new Error(`git diff 失败: ${e instanceof Error ? e.message : e}`);
    }
}
/** 读远端 main 的 last_rebalance.json（需先 fetch）。 */
function readRemoteLastRebalance(repoDir) {
    const raw = git(repoDir, ["show", "origin/main:last_rebalance.json"]);
    return JSON.parse(raw);
}
/** 读取要推送的本地 last_rebalance.json（从 watchlistDir 源文件，非 repo 工作区）。 */
function readLocalLastRebalance(watchlistDir) {
    const raw = fs.readFileSync(path.join(watchlistDir, "last_rebalance.json"), "utf-8");
    return JSON.parse(raw);
}
/**
 * 把 watchlist 目录的两文件推到 trading-state repo。
 * @param watchlistDir ~/.openclaw/watchlist 路径
 * @param stateRepoDir trading-state repo 本地路径
 * @throws ConflictAbortedError 本地 pending 撞远端已执行
 */
async function syncPush(watchlistDir, stateRepoDir) {
    if (!fs.existsSync(stateRepoDir)) {
        throw new Error(`trading-state repo 不存在: ${stateRepoDir}，请先 clone`);
    }
    // 1. fetch + 冲突仲裁 + 对齐远端（全部在复制文件之前）
    git(stateRepoDir, ["fetch", "origin", "main"]);
    const remoteAheadCount = parseInt(git(stateRepoDir, ["rev-list", "--count", "main..origin/main"]), 10);
    if (remoteAheadCount > 0) {
        // 远端有本地没有的提交 → 可能冲突，先仲裁
        const remoteLast = readRemoteLastRebalance(stateRepoDir);
        const localLast = readLocalLastRebalance(watchlistDir);
        // 规则 1：本地 pending 撞远端非 pending（已执行）→ 拒绝
        if (localLast.execution && (0, execution_schema_1.isPending)(localLast.execution.status) &&
            remoteLast.execution && !(0, execution_schema_1.isPending)(remoteLast.execution.status)) {
            throw new ConflictAbortedError(remoteLast.order_id ?? "(无)", remoteLast.execution.status);
        }
        // 规则 2：其余情况（都 pending，或本地非 pending）→ 后写胜出
        // 对齐到远端 HEAD；因还没复制我们的文件，reset 不丢数据
        git(stateRepoDir, ["reset", "--hard", "origin/main"]);
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
    // 3. commit + push。push 必 fast-forward（工作区已对齐 origin）。
    // 暂存区无差异（重跑同一天两文件不变）时跳过：git commit nothing-to-commit 会 exit 1。
    git(stateRepoDir, ["add", "holdings.json", "last_rebalance.json"]);
    if (!hasStagedChanges(stateRepoDir))
        return;
    git(stateRepoDir, ["commit", "-m", "chore(state): sync from rebalancer"]);
    git(stateRepoDir, ["push", "origin", "main"]);
}
//# sourceMappingURL=execution-bridge.js.map