import type { Holdings, Position, Action } from "./rebalance-types";
import type { RebalancePipelineResult } from "./rebalancer";
/** 完整交易记录（一买一卖配对）。 */
export interface TradeRecord {
    ticker: string;
    name: string;
    entryDate: string;
    entryPrice: number;
    exitDate: string | null;
    exitPrice: number | null;
    holdDays: number | null;
    returnPct: number | null;
    exitReason: string | null;
}
/** 每日 NAV 快照。 */
export interface NavSnapshot {
    date: string;
    nav: number;
    dailyReturnPct: number;
    cashPct: number;
    positionCount: number;
    actions: string[];
}
export interface BacktestSummary {
    startDate: string;
    endDate: string;
    totalReturnPct: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winRate: number;
    avgHoldDays: number;
    avgWinPct: number;
    avgLossPct: number;
}
export interface BacktestResults {
    navHistory: NavSnapshot[];
    trades: TradeRecord[];
    openPositions: {
        ticker: string;
        name: string;
        entryDate: string;
        returnPct: number;
    }[];
    summary: BacktestSummary;
}
/** 序列化后的 PositionSimulator 全量状态（跨进程持久化用）。
 *  所有字段都是 JSON 原生：positions 从 Map 转为数组，SimPosition 结构等同 Position。 */
export interface SerializedSimState {
    cash: number;
    recentSells: Record<string, string>;
    lastRebalanceDate: string | null;
    positions: Position[];
    navHistory: NavSnapshot[];
    trades: TradeRecord[];
}
/** 从外部注入的收盘价查询函数（backtest-cli 负责实际拉 K 线 + 缓存）。 */
export type PriceLookup = (ticker: string, date: string) => Promise<number | null>;
export declare class PositionSimulator {
    private positions;
    private cash;
    private recentSells;
    private lastRebalanceDate;
    private navHistory;
    private trades;
    private priceLookup;
    constructor(priceLookup: PriceLookup);
    /** 用 D 日收盘价重算所有持仓的权重 + totalNav。
     *  这是跨日权重漂移的核心：涨了的股权重变大，现金占比相应缩小。
     *  返回当日价格缓存，供后续 getNav/toHoldings/applyPlan 复用（避免重复 priceLookup）。 */
    normalizeWeights(date: string): Promise<Map<string, number>>;
    /** 当前总资产净值（归一化）。传入预查好的价格避免重复 priceLookup。 */
    getNav(date: string, priceMap?: Map<string, number>): Promise<number>;
    /** 输出当前 Holdings（供 rebalancePipeline 消费）。
     *  cash_pct = cash / totalNav（价格漂移后的真实占比）。
     *  priceMap 复用 normalizeWeights 的缓存，避免重复 priceLookup。 */
    toHoldings(date: string, priceMap?: Map<string, number>): Promise<Holdings>;
    /** 构造 LastRebalance（供 rebalancePipeline 的 anti-churn buy lock）。 */
    getLastRebalance(): {
        date: string;
        actions: {
            action: "BUY" | "SELL" | "ADD" | "REDUCE";
            ticker: string;
            weight: number;
        }[];
        recent_sells: Record<string, string>;
    } | null;
    /** 按 rebalance 结果更新持仓。
     *  从 portfolio_after 翻译回 Position[]，处理 BUY/SELL/ADD/REDUCE。
     *  entry_date：新建仓 = date（当日收盘价建仓，与 entryPrice 一致），ADD 保持原 entry_date。
     *  priceMap 复用 normalizeWeights 缓存（SELL/REDUCE 的 exitPrice 从中取，BUY 新股需补查）。 */
    applyPlan(result: RebalancePipelineResult, date: string, reportsByTicker: Map<string, {
        fitness_score: number;
        name: string;
        sector: string;
    }>, priceMap?: Map<string, number>): Promise<void>;
    /** 获取上一个交易日的 NAV（navHistory 最后一条；无历史则返回起点 1.0）。
     *  用于算 dailyReturn——必须用当时真实记录的 NAV，而非用当前持仓重算旧价格。 */
    getPrevNav(): number;
    /** 记录当日 NAV 快照（在 applyPlan 之后调用，反映当日收盘后的组合状态）。
     *  prevNav 直接用 navHistory 最后一条的 nav（D-1 收盘时的真实净值），
     *  而非重新算 getNav(prevDate)——后者会用当前已变的持仓在旧价格下算，结果不准。 */
    recordNav(date: string, actions: Action[], prevNav: number, priceMap?: Map<string, number>): Promise<void>;
    /** 回测期末：把仍持有的仓位记为未平仓交易。 */
    closeOpenPositions(endDate: string, priceMap?: Map<string, number>): Promise<void>;
    /** 获取完整回测结果。 */
    getResults(): BacktestResults;
    /** 导出全量状态供持久化（跨进程续跑）。
     *  所有 private 字段都是 JSON 原生：positions 的 Map → Array 转换。 */
    serialize(): SerializedSimState;
    /** 从序列化状态恢复（跨进程续跑）。
     *  priceLookup 是注入依赖，每次新建进程时由调用方重新注入。 */
    static fromSerialized(state: SerializedSimState, priceLookup: PriceLookup): PositionSimulator;
    /** 当前持仓快照（浮动盈亏）：供增量模式每日展示当前持仓状态。
     *  与 closeOpenPositions 不同——它不把持仓记入 trades（否则会把仍持有的记成未平仓交易）。
     *  weight 用 normalizeWeights 漂移后的值（调用方应先调 normalizeWeights）。 */
    currentHoldingsSnapshot(date: string, priceMap?: Map<string, number>): Promise<{
        ticker: string;
        name: string;
        entryDate: string;
        weight: number;
        returnPct: number;
    }[]>;
    private calcHoldDays;
}
//# sourceMappingURL=backtest-simulator.d.ts.map