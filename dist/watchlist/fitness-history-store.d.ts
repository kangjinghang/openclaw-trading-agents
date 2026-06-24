import type { ActionType } from "./rebalance-types";
/** 单条 fitness 历史记录：一次 rebalance 里某只股的一个决策 + 事后收益。 */
export interface FitnessRecord {
    /** 决策日 YYYY-MM-DD（rebalance 的 scan_date）。 */
    decision_date: string;
    /** 股票代码（SZ300319 格式，和 plan.json 一致）。 */
    ticker: string;
    name: string;
    /** 调仓方向。HOLD/REDUCE/SELL 也记——验证"没买/减仓的"事后是否真该避开。 */
    action: ActionType;
    /** 质量门控钳制后的 fitness（实际进仓位公式的值）。 */
    fitness: number;
    /** LLM 原始 fitness（若被质量门控钳制，溯源用；未钳制则省略）。 */
    fitness_raw?: number;
    /** shallow-analyzer 的 overall_risk。 */
    overall_risk: "low" | "medium" | "high";
    /** 仓位公式算出的目标仓位（0-1）。 */
    target_weight: number;
    /** 决策日收盘价（事后收益的基准；拉不到则 0，该记录无法结算）。 */
    entry_price: number;
    /** 质量门控标注（钳制原因等，溯源用）。 */
    quality_notes?: string[];
    /** rebalance 的 run_id（审计关联）。 */
    run_id: string;
    /** open=待结算 / settled=已结算（写了 return_*）。 */
    status: "open" | "settled";
    /** 结算日 YYYY-MM-DD（settled 时写）。 */
    settled_at?: string;
    /** 决策后 7 天涨跌幅 %（相对 entry_price）。undefined=未到该窗口或拉不到价。 */
    return_7d?: number;
    /** 决策后 14 天涨跌幅 %。 */
    return_14d?: number;
    /** 决策后 30 天涨跌幅 %。 */
    return_30d?: number;
}
export interface FitnessHistoryFile {
    version: number;
    updated_at: string;
    records: FitnessRecord[];
}
/**
 * 环形 buffer 上限。每次 rebalance 追加约 10-20 条（持仓+候选），1 run/天
 * 约 1+ 年覆盖。FIFO 淘汰最老记录（同 source-health-store 范式）。
 * 2000 条 × ~250 bytes ≈ 500KB，可接受。
 */
export declare const BUFFER_SIZE = 2000;
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
export declare class FitnessHistoryStore {
    private readonly filePath;
    constructor(watchlistDir: string);
    /** 读取历史文件。缺/坏文件返回空 state，永不抛。 */
    read(): FitnessHistoryFile;
    /** 取所有 status=open 的记录（供 backfiller 懒结算）。 */
    getOpenRecords(): FitnessRecord[];
    /**
     * 追加一批决策快照记录。跳过空数组。
     * 同 (decision_date, ticker) 已存在时 update-in-place：
     *   覆盖 fitness/action/overall_risk/target_weight/fitness_raw/quality_notes；
     *   不改 status/return_*（保留 open/settled 和事后收益）。
     * 写错吞掉只 stderr，绝不抛。
     */
    appendDecisions(records: FitnessRecord[]): void;
    /**
     * 结算一条记录：写 return_* + 标 settled。
     * returns 含哪些窗口就写哪些（部分结算，拉不到价的窗口留 undefined）。
     * 幂等：已 settled 的不再改。
     */
    settleRecord(decision_date: string, ticker: string, returns: {
        return_7d?: number;
        return_14d?: number;
        return_30d?: number;
    }): void;
    /** 原子写（tmp + rename，同 report-store/source-health-store 范式）。失败只 stderr。 */
    private write;
}
//# sourceMappingURL=fitness-history-store.d.ts.map