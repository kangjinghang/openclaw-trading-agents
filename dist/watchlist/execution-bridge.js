"use strict";
// src/watchlist/execution-bridge.ts
//
// syncPush：开发机跑完 rebalancer 后，把 holdings.json + last_rebalance.json
// 推到 trading-state private repo。
//
// 开发机端 push 语义：永远只推 pending 订单。冲突时只处理一种情况——
// 本地 pending 撞远端非 pending（已执行）。撞了就 abort + 提示 pull，
// 不尝试后写覆盖（开发机不产执行结果，没有"更新"一说）。
// 云服务器的 safe_push 规则 2（都 pending 后写胜出）只对它自己有意义。
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
function git(repoDir, cmd) {
    try {
        return (0, child_process_1.execSync)(`git -C ${repoDir} ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    }
    catch (e) {
        throw new Error(`git 命令失败: git ${cmd} — ${e instanceof Error ? e.message : e}`);
    }
}
/** 检查远端 main 是否领先本地（origin/main 有本地没有的提交）。 */
function remoteHasNewCommits(repoDir) {
    git(repoDir, "fetch origin main");
    const count = git(repoDir, "rev-list --count main..origin/main");
    return parseInt(count, 10) > 0;
}
/** 读远端 main 的 last_rebalance.json。 */
function readRemoteLastRebalance(repoDir) {
    const raw = git(repoDir, "show origin/main:last_rebalance.json");
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
        const localLast = JSON.parse(fs.readFileSync(path.join(stateRepoDir, "last_rebalance.json"), "utf-8"));
        // 本地 pending 撞远端非 pending → 拒绝（已执行不可覆盖）
        if (localLast.execution && (0, execution_schema_1.isPending)(localLast.execution.status) &&
            remoteLast.execution && !(0, execution_schema_1.isPending)(remoteLast.execution.status)) {
            throw new ConflictAbortedError(remoteLast.order_id ?? "(无)", remoteLast.execution.status);
        }
        // 都 pending 或本地非 pending：后写胜出，正常 push
    }
    // push
    git(stateRepoDir, "add holdings.json last_rebalance.json");
    git(stateRepoDir, 'commit -m "chore(state): sync from rebalancer" --allow-empty');
    git(stateRepoDir, "push origin main");
}
//# sourceMappingURL=execution-bridge.js.map