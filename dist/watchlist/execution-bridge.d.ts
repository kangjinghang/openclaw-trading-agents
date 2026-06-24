/** 本地 pending 撞远端已执行（非 pending）→ 拒绝 push。 */
export declare class ConflictAbortedError extends Error {
    constructor(remoteOrderId: string, remoteStatus: string);
}
/**
 * 把 watchlist 目录的两文件推到 trading-state repo。
 * @param watchlistDir ~/.openclaw/watchlist 路径
 * @param stateRepoDir trading-state repo 本地路径
 * @throws ConflictAbortedError 本地 pending 撞远端已执行
 */
export declare function syncPush(watchlistDir: string, stateRepoDir: string): Promise<void>;
//# sourceMappingURL=execution-bridge.d.ts.map