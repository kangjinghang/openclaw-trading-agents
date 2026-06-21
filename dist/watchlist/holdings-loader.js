"use strict";
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
exports.validateHoldings = validateHoldings;
exports.computeLocked = computeLocked;
exports.loadHoldings = loadHoldings;
// src/watchlist/holdings-loader.ts
const fs = __importStar(require("fs"));
/** 校验 holdings schema + 权重和。 */
function validateHoldings(h) {
    if (!Array.isArray(h.positions))
        return { ok: false, error: "positions 必须是数组" };
    if (typeof h.cash_pct !== "number" || h.cash_pct < 0 || h.cash_pct > 1) {
        return { ok: false, error: `cash_pct ${h.cash_pct} 不在 [0,1]` };
    }
    for (const p of h.positions) {
        if (!p.sector || !p.sector.trim()) {
            return { ok: false, error: `${p.ticker} 缺 sector 字段` };
        }
        if (!p.entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(p.entry_date)) {
            return { ok: false, error: `${p.ticker} entry_date 格式错误: ${p.entry_date}` };
        }
    }
    const sum = h.positions.reduce((s, p) => s + p.weight, 0) + h.cash_pct;
    if (Math.abs(sum - 1.0) > 0.001) {
        return { ok: false, error: `权重和 ${sum.toFixed(3)} 不等于 1.0（positions + cash）` };
    }
    return { ok: true, error: null };
}
/** 计算某 entry_date 在 currentDate 下是否被 anti-churn 锁定。
 *  antiChurnDays=0 表示永不锁定。格式错误也返回 false（防御性）。 */
function computeLocked(entryDate, currentDate, antiChurnDays) {
    if (antiChurnDays <= 0)
        return false;
    const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
    const current = new Date(currentDate + "T00:00:00+08:00").getTime();
    if (isNaN(entry) || isNaN(current))
        return false;
    const daysHeld = Math.floor((current - entry) / (24 * 60 * 60 * 1000));
    return daysHeld < antiChurnDays;
}
/** 读 holdings.json 文件 + 校验。文件不存在或校验失败抛错。 */
function loadHoldings(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`holdings.json 不存在: ${filePath}\n请手动创建，schema 见 rebalance-types.ts:Holdings`);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const v = validateHoldings(raw);
    if (!v.ok)
        throw new Error(`holdings.json 校验失败: ${v.error}`);
    return raw;
}
//# sourceMappingURL=holdings-loader.js.map