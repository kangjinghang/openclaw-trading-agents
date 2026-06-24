"use strict";
// src/watchlist/execution-schema.ts
//
// Execution 状态机校验纯函数。状态流转：
//   pending ──(云服务器开始执行)──▶ executing ──┬─ filled   全部成交
//                                              ├─ partial  部分成交
//                                              └─ failed   全部失败/拒单
// 终态（filled/partial/failed）不可回退。
// 这些函数同时被开发机（syncPush 仲裁）和测试使用，云服务器 Python 端
// 有等价实现（见 merge.py / git_sync.py）。
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTerminal = isTerminal;
exports.isPending = isPending;
exports.makePendingExecution = makePendingExecution;
/** 终态：filled/partial/failed。终态订单不可被 pending 覆盖。 */
function isTerminal(status) {
    return status === "filled" || status === "partial" || status === "failed";
}
/** 待执行：仅 pending。 */
function isPending(status) {
    return status === "pending";
}
/** 开发机产出订单时的标准 pending 占位。每次返回新对象避免共享引用。 */
function makePendingExecution() {
    return {
        status: "pending",
        executed_at: null,
        account_total_asset: null,
        fills: [],
        errors: [],
    };
}
//# sourceMappingURL=execution-schema.js.map