"use strict";
// src/watchlist/fitness-history-store.ts
//
// Fitness 回测数据采集存储（cross-run）。
// 为 1-3 个月后的 fitness 预测力回测铺路：每次 rebalance 采集"决策快照"
// （fitness/action/当时价格），下次 rebalance 启动时由 backfiller 懒结算
// 事后收益（7/14/30 天涨跌幅）。
//
// 范式照搬 src/source-health-store.ts：单文件环形 buffer + append/run +
// read 永不抛 + tmp/rename 原子写。fitness 历史是"锦上添花"，绝不能让
// 采集失败阻塞 rebalance 主流程（所有写操作吞错只 stderr）。
//
// 文件路径：<watchlistDir>/fitness-history.json（默认 ~/.openclaw/watchlist/）
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
exports.FitnessHistoryStore = exports.BUFFER_SIZE = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * 环形 buffer 上限。每次 rebalance 追加约 10-20 条（持仓+候选），1 run/天
 * 约 1+ 年覆盖。FIFO 淘汰最老记录（同 source-health-store 范式）。
 * 2000 条 × ~250 bytes ≈ 500KB，可接受。
 */
exports.BUFFER_SIZE = 2000;
const SCHEMA_VERSION = 1;
/**
 * 持久化的跨 run fitness 历史。一个实例对应一次 rebalance 运行；读写单个
 * JSON 文件 <watchlistDir>/fitness-history.json。
 *
 * 设计不变式（同 source-health-store）：
 * 1. read() 永不抛——缺/坏文件返回空 state。采集失败绝不阻塞 pipeline。
 * 2. appendDecisions 是唯一的"加记录"入口；settleRecord 是唯一的"改状态"入口。
 * 3. 环形 buffer 上限 BUFFER_SIZE（FIFO 淘汰）。
 * 4. 去重：同 (decision_date, ticker) 不重复追加（同一天重复跑 rebalance）。
 */
class FitnessHistoryStore {
    constructor(watchlistDir) {
        this.filePath = path.join(watchlistDir, "fitness-history.json");
    }
    /** 读取历史文件。缺/坏文件返回空 state，永不抛。 */
    read() {
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed?.version === SCHEMA_VERSION && Array.isArray(parsed.records)) {
                return parsed;
            }
        }
        catch {
            // 缺/坏文件 → 空 state
        }
        return { version: SCHEMA_VERSION, updated_at: "", records: [] };
    }
    /** 取所有 status=open 的记录（供 backfiller 懒结算）。 */
    getOpenRecords() {
        return this.read().records.filter(r => r.status === "open");
    }
    /**
     * 追加一批决策快照记录。跳过空数组；去重（同 decision_date+ticker 不重复）。
     * 写错吞掉只 stderr，绝不抛。
     */
    appendDecisions(records) {
        if (records.length === 0)
            return;
        const state = this.read();
        // 去重：已存在的 (decision_date, ticker) 跳过
        const existing = new Set(state.records.map(r => `${r.decision_date}|${r.ticker}`));
        for (const rec of records) {
            const key = `${rec.decision_date}|${rec.ticker}`;
            if (existing.has(key))
                continue;
            state.records.push(rec);
            existing.add(key);
        }
        // 环形 buffer：保留最近 BUFFER_SIZE 条
        if (state.records.length > exports.BUFFER_SIZE) {
            state.records = state.records.slice(-exports.BUFFER_SIZE);
        }
        state.updated_at = new Date().toISOString();
        this.write(state);
    }
    /**
     * 结算一条记录：写 return_* + 标 settled。
     * returns 含哪些窗口就写哪些（部分结算，拉不到价的窗口留 undefined）。
     * 幂等：已 settled 的不再改。
     */
    settleRecord(decision_date, ticker, returns) {
        const state = this.read();
        const rec = state.records.find(r => r.decision_date === decision_date && r.ticker === ticker && r.status === "open");
        if (!rec)
            return; // 不存在或已 settled → 幂等跳过
        if (returns.return_7d !== undefined)
            rec.return_7d = returns.return_7d;
        if (returns.return_14d !== undefined)
            rec.return_14d = returns.return_14d;
        if (returns.return_30d !== undefined)
            rec.return_30d = returns.return_30d;
        rec.status = "settled";
        rec.settled_at = new Date().toISOString();
        state.updated_at = rec.settled_at;
        this.write(state);
    }
    /** 原子写（tmp + rename，同 report-store/source-health-store 范式）。失败只 stderr。 */
    write(state) {
        const tmp = this.filePath + ".tmp";
        try {
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
            fs.renameSync(tmp, this.filePath);
        }
        catch (err) {
            console.error(`[fitness-history] write failed: ${err instanceof Error ? err.message : err}`);
        }
    }
}
exports.FitnessHistoryStore = FitnessHistoryStore;
//# sourceMappingURL=fitness-history-store.js.map