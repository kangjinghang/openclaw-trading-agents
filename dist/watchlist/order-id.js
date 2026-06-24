"use strict";
// src/watchlist/order-id.ts
//
// order_id 幂等键：让云服务器能识别"这份订单执行过了，跳过"。
// 算法：date + "-" + sha256(canonicalize(actions)).slice(0,6)
// 规范化（按 ticker 排序 + weight 四舍五入到 4 位）保证：
//   - Mac 重跑 rebalancer 若 actions 内容不变 → id 不变 → 跳过
//   - actions 顺序乱 → id 不变（规范化生效）
//   - 改任一 weight（超 4 位精度）→ id 变 → 视为新订单
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
exports.canonicalizeActions = canonicalizeActions;
exports.computeOrderId = computeOrderId;
const crypto = __importStar(require("crypto"));
/** 规范化 actions 到稳定字符串：按 ticker 排序，weight 四舍五入到 4 位。 */
function canonicalizeActions(actions) {
    const sorted = [...actions].sort((a, b) => a.ticker.localeCompare(b.ticker));
    return JSON.stringify(sorted.map(a => ({
        action: a.action,
        ticker: a.ticker,
        weight: Number(a.weight.toFixed(4)),
    })));
}
/** 计算幂等 order_id："YYYY-MM-DD-<6位hex>"。 */
function computeOrderId(date, actions) {
    const hash = crypto.createHash("sha256").update(canonicalizeActions(actions)).digest("hex");
    return `${date}-${hash.slice(0, 6)}`;
}
//# sourceMappingURL=order-id.js.map