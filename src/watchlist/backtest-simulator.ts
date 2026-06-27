// src/watchlist/backtest-simulator.ts
//
// 回测持仓模拟器：跨日持仓状态管理 + 权重漂移 + 交易记录。
//
// 核心解决代码库的缺口：真实系统靠 QMT 执行器按 shares × price 重算权重，
// 回测必须自己建模价格导致的权重漂移（涨了的股权重变大）。
//
// 设计：以"份额(shares)"为底层真实状态，权重是份额×价格的导出量。
// 初始总资产归一化为 1.0，cash + Σ(shares×price) = 1.0。

import type { Holdings, Position, Action } from "./rebalance-types";
import type { RebalancePipelineResult } from "./rebalancer";

// ── 类型 ──────────────────────────────────────────────────────────────

/** 内部持仓：Position + 份额（用于价格漂移计算）。 */
interface SimPosition extends Position {
  shares: number;  // 持有份额（归一化总资产下的份数）
}

/** 完整交易记录（一买一卖配对）。 */
export interface TradeRecord {
  ticker: string;
  name: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;       // null = 仍持有（回测期末未平仓）
  exitPrice: number | null;
  holdDays: number | null;
  returnPct: number | null;      // 收益率（exit vs entry）
  exitReason: string | null;     // SELL reason
}

/** 每日 NAV 快照。 */
export interface NavSnapshot {
  date: string;
  nav: number;                   // 归一化净值（起点 1.0）
  dailyReturnPct: number;        // 当日涨跌（vs 前一日）
  cashPct: number;               // 现金占净值比例
  positionCount: number;
  actions: string[];             // 当日动作摘要（如 "BUY 香农芯创"）
}

export interface BacktestSummary {
  startDate: string;
  endDate: string;
  totalReturnPct: number;        // 总收益
  maxDrawdownPct: number;        // 最大回撤
  tradeCount: number;            // 已平仓交易数
  winRate: number;               // 胜率（盈利交易 / 已平仓交易）
  avgHoldDays: number;           // 平均持仓天数
  avgWinPct: number;             // 平均盈利（仅盈利交易）
  avgLossPct: number;            // 平均亏损（仅亏损交易）
}

export interface BacktestResults {
  navHistory: NavSnapshot[];
  trades: TradeRecord[];         // 含未平仓的（exitDate=null）
  openPositions: { ticker: string; name: string; entryDate: string; returnPct: number }[];
  summary: BacktestSummary;
}

// ── K 线取数 ──────────────────────────────────────────────────────────

interface KlineBar { date: string; close: number; }

/** 从外部注入的收盘价查询函数（backtest-cli 负责实际拉 K 线 + 缓存）。 */
export type PriceLookup = (ticker: string, date: string) => Promise<number | null>;

// ── PositionSimulator ─────────────────────────────────────────────────

export class PositionSimulator {
  private positions = new Map<string, SimPosition>();
  private cash = 1.0;  // 归一化，起点 100% 现金
  private recentSells: Record<string, string> = {};
  private lastRebalanceDate: string | null = null;
  private navHistory: NavSnapshot[] = [];
  private trades: TradeRecord[] = [];
  private priceLookup: PriceLookup;

  constructor(priceLookup: PriceLookup) {
    this.priceLookup = priceLookup;
  }

  /** 用 D 日收盘价重算所有持仓的权重 + totalNav。
   *  这是跨日权重漂移的核心：涨了的股权重变大，现金占比相应缩小。
   *  返回当日价格缓存，供后续 getNav/toHoldings/applyPlan 复用（避免重复 priceLookup）。 */
  async normalizeWeights(date: string): Promise<Map<string, number>> {
    if (this.positions.size === 0) {
      return new Map();  // 空仓无价格
    }
    const prices = new Map<string, number>();
    let positionsValue = 0;
    for (const [ticker, pos] of this.positions) {
      const price = await this.priceLookup(ticker, date);
      if (price === null) {
        // 取不到价：用 entry_price 兜底（保守，不臆测涨跌）
        prices.set(ticker, pos.entry_price);
        positionsValue += pos.shares * pos.entry_price;
      } else {
        prices.set(ticker, price);
        positionsValue += pos.shares * price;
      }
    }
    const totalNav = this.cash + positionsValue;
    // 重算每个持仓的 weight
    for (const [ticker, pos] of this.positions) {
      const price = prices.get(ticker)!;
      pos.weight = (pos.shares * price) / totalNav;
    }
    // cash 占比也重算
    // 注：cash 的绝对值不变（没买卖），但占 totalNav 的比例变了
    // 不改 this.cash 绝对值——它是"现金金额"，不是"现金占比"
    // toHoldings() 时会算 cash_pct = cash / totalNav
    return prices;
  }

  /** 当前总资产净值（归一化）。传入预查好的价格避免重复 priceLookup。 */
  async getNav(date: string, priceMap?: Map<string, number>): Promise<number> {
    if (this.positions.size === 0) return this.cash;
    let positionsValue = 0;
    for (const [ticker, pos] of this.positions) {
      const price = priceMap?.get(ticker) ?? await this.priceLookup(ticker, date) ?? pos.entry_price;
      positionsValue += pos.shares * price;
    }
    return this.cash + positionsValue;
  }

  /** 输出当前 Holdings（供 rebalancePipeline 消费）。
   *  cash_pct = cash / totalNav（价格漂移后的真实占比）。
   *  priceMap 复用 normalizeWeights 的缓存，避免重复 priceLookup。 */
  async toHoldings(date: string, priceMap?: Map<string, number>): Promise<Holdings> {
    const totalNav = await this.getNav(date, priceMap);
    const positions: Position[] = [];
    for (const [, pos] of this.positions) {
      positions.push({
        ticker: pos.ticker, name: pos.name, weight: pos.weight,
        entry_price: pos.entry_price, entry_date: pos.entry_date,
        shares: pos.shares, sector: pos.sector,
      });
    }
    return {
      updated_at: date + "T00:00:00+08:00",
      cash_pct: totalNav > 0 ? this.cash / totalNav : 1.0,
      positions,
    };
  }

  /** 构造 LastRebalance（供 rebalancePipeline 的 anti-churn buy lock）。 */
  getLastRebalance(): { date: string; actions: { action: "BUY"|"SELL"|"ADD"|"REDUCE"; ticker: string; weight: number }[]; recent_sells: Record<string, string> } | null {
    if (this.lastRebalanceDate === null) return null;
    // 构造 actions（简化版，只保留 recent_sells 语义）
    const sellActions = Object.entries(this.recentSells).map(([ticker, d]) => ({
      action: "SELL" as const, ticker, weight: 0,
    }));
    return {
      date: this.lastRebalanceDate,
      actions: sellActions,
      recent_sells: { ...this.recentSells },
    };
  }

  /** 按 rebalance 结果更新持仓。
   *  从 portfolio_after 翻译回 Position[]，处理 BUY/SELL/ADD/REDUCE。
   *  entry_date：新建仓 = date（当日收盘价建仓，与 entryPrice 一致），ADD 保持原 entry_date。
   *  priceMap 复用 normalizeWeights 缓存（SELL/REDUCE 的 exitPrice 从中取，BUY 新股需补查）。 */
  async applyPlan(
    result: RebalancePipelineResult,
    date: string,
    reportsByTicker: Map<string, { fitness_score: number; name: string; sector: string }>,
    priceMap?: Map<string, number>,
  ): Promise<void> {
    const actions = result.rebalancer_output.actions;
    const totalNav = await this.getNav(date, priceMap);
    const entryDate = date;  // 当日收盘价建仓
    // 价格查询：优先用缓存，缓存没有再查（BUY 新股不在持仓里，缓存可能没有）
    const getPrice = async (ticker: string): Promise<number | null> => {
      const cached = priceMap?.get(ticker);
      if (cached !== undefined) return cached;
      return this.priceLookup(ticker, date);
    };

    // 第一遍：处理 SELL（释放现金 + 记交易）
    for (const a of actions) {
      if (a.action !== "SELL") continue;
      const pos = this.positions.get(a.ticker);
      if (pos) {
        const exitPrice = await getPrice(a.ticker) ?? pos.entry_price;
        const entryPrice = pos.entry_price;
        const returnPct = (exitPrice / entryPrice - 1) * 100;
        const holdDays = this.calcHoldDays(pos.entry_date, date);
        // 记交易（平仓）
        this.trades.push({
          ticker: a.ticker, name: pos.name,
          entryDate: pos.entry_date, entryPrice,
          exitDate: date, exitPrice, holdDays, returnPct,
          exitReason: a.reason,
        });
        // 释放现金：卖出的份额按当日价格变现
        this.cash += pos.shares * exitPrice;
        this.positions.delete(a.ticker);
        this.recentSells[a.ticker] = date;
      }
    }

    // REDUCE：减仓（部分卖出）
    for (const a of actions) {
      if (a.action !== "REDUCE") continue;
      const pos = this.positions.get(a.ticker);
      if (!pos) continue;
      const exitPrice = await getPrice(a.ticker) ?? pos.entry_price;
      // REDUCE 减半：target_weight = current / 2
      const reduceRatio = a.current_weight > 0
        ? Math.max(0, (a.current_weight - a.target_weight) / a.current_weight)
        : 0.5;
      const sharesToSell = pos.shares * reduceRatio;
      this.cash += sharesToSell * exitPrice;
      pos.shares -= sharesToSell;
      // REDUCE 不记 recent_sells（还有剩余仓位）
      // REDUCE 不平仓所以不记完整交易（或记部分？简化：不记）
      if (pos.shares <= 0.0001) {
        // 实际清仓了（position-calculator 会把小仓位 REDUCE 升级为 SELL，但防御性处理）
        this.positions.delete(a.ticker);
      }
    }

    // 第二遍：处理 BUY / ADD（消耗现金）
    for (const a of actions) {
      if (a.action !== "BUY" && a.action !== "ADD") continue;
      const entryPrice = await getPrice(a.ticker);
      if (entryPrice === null) {
        // 取不到价无法建仓——跳过（罕见，K线拉取失败）
        continue;
      }
      const targetValue = a.target_weight * totalNav;  // 目标市值
      const report = reportsByTicker.get(a.ticker);
      const existing = this.positions.get(a.ticker);

      if (existing) {
        // ADD：加仓到 target_weight
        const currentSharesValue = existing.shares * entryPrice;
        const sharesToAdd = Math.max(0, (targetValue - currentSharesValue) / entryPrice);
        existing.shares += sharesToAdd;
        existing.weight = a.target_weight;
        // ADD 保持 entry_date（anti-churn 锁连续）
        // 消耗现金
        this.cash = Math.max(0, this.cash - sharesToAdd * entryPrice);
      } else {
        // BUY：新建仓
        const shares = targetValue / entryPrice;
        this.positions.set(a.ticker, {
          ticker: a.ticker,
          name: a.name,
          weight: a.target_weight,
          entry_price: entryPrice,
          entry_date: entryDate,
          shares,
          sector: report?.sector ?? "未分类",
        });
        this.cash = Math.max(0, this.cash - targetValue);
      }
    }

    // HOLD 的持仓不动（权重已在 normalizeWeights 里漂移）

    // recent_sells 14 天过期清除
    const cutoffMs = new Date(date + "T00:00:00+08:00").getTime() - 14 * 86_400_000;
    for (const [tick, d] of Object.entries(this.recentSells)) {
      if (new Date(d + "T00:00:00+08:00").getTime() < cutoffMs) {
        delete this.recentSells[tick];
      }
    }

    this.lastRebalanceDate = date;
  }

  /** 获取上一个交易日的 NAV（navHistory 最后一条；无历史则返回起点 1.0）。
   *  用于算 dailyReturn——必须用当时真实记录的 NAV，而非用当前持仓重算旧价格。 */
  getPrevNav(): number {
    return this.navHistory.length > 0
      ? this.navHistory[this.navHistory.length - 1].nav
      : 1.0;
  }

  /** 记录当日 NAV 快照（在 applyPlan 之后调用，反映当日收盘后的组合状态）。
   *  prevNav 直接用 navHistory 最后一条的 nav（D-1 收盘时的真实净值），
   *  而非重新算 getNav(prevDate)——后者会用当前已变的持仓在旧价格下算，结果不准。 */
  async recordNav(date: string, actions: Action[], prevNav: number, priceMap?: Map<string, number>): Promise<void> {
    const nav = await this.getNav(date, priceMap);
    const dailyReturn = prevNav > 0 ? (nav / prevNav - 1) * 100 : 0;
    const actionSummaries = actions
      .filter(a => a.action !== "HOLD")
      .map(a => `${a.action} ${a.name}`);
    this.navHistory.push({
      date,
      nav,
      dailyReturnPct: dailyReturn,
      cashPct: this.positions.size === 0 ? 1.0 : this.cash / nav,
      positionCount: this.positions.size,
      actions: actionSummaries,
    });
  }

  /** 回测期末：把仍持有的仓位记为未平仓交易。 */
  async closeOpenPositions(endDate: string, priceMap?: Map<string, number>): Promise<void> {
    for (const [ticker, pos] of this.positions) {
      const exitPrice = priceMap?.get(ticker) ?? await this.priceLookup(ticker, endDate) ?? pos.entry_price;
      this.trades.push({
        ticker, name: pos.name,
        entryDate: pos.entry_date, entryPrice: pos.entry_price,
        exitDate: null, exitPrice: null,
        holdDays: this.calcHoldDays(pos.entry_date, endDate),
        returnPct: (exitPrice / pos.entry_price - 1) * 100,
        exitReason: null,
      });
    }
  }

  /** 获取完整回测结果。 */
  getResults(): BacktestResults {
    const closedTrades = this.trades.filter(t => t.exitDate !== null);
    const wins = closedTrades.filter(t => (t.returnPct ?? 0) > 0);
    const losses = closedTrades.filter(t => (t.returnPct ?? 0) <= 0);

    // 最大回撤
    let peak = 0;
    let maxDrawdown = 0;
    for (const snap of this.navHistory) {
      if (snap.nav > peak) peak = snap.nav;
      const drawdown = peak > 0 ? (snap.nav / peak - 1) * 100 : 0;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
    const lastNav = this.navHistory.length > 0 ? this.navHistory[this.navHistory.length - 1].nav : 1.0;

    const openPositions = this.trades
      .filter(t => t.exitDate === null)
      .map(t => ({ ticker: t.ticker, name: t.name, entryDate: t.entryDate, returnPct: t.returnPct ?? 0 }));

    return {
      navHistory: this.navHistory,
      trades: this.trades,
      openPositions,
      summary: {
        startDate: this.navHistory[0]?.date ?? "",
        endDate: this.navHistory[this.navHistory.length - 1]?.date ?? "",
        totalReturnPct: (lastNav - 1) * 100,
        maxDrawdownPct: maxDrawdown,
        tradeCount: closedTrades.length,
        winRate: closedTrades.length > 0 ? wins.length / closedTrades.length : 0,
        avgHoldDays: avg(closedTrades.map(t => t.holdDays ?? 0)),
        avgWinPct: avg(wins.map(t => t.returnPct ?? 0)),
        avgLossPct: avg(losses.map(t => t.returnPct ?? 0)),
      },
    };
  }

  private calcHoldDays(entryDate: string, exitDate: string): number {
    const ms = new Date(exitDate + "T00:00:00+08:00").getTime()
             - new Date(entryDate + "T00:00:00+08:00").getTime();
    return Math.floor(ms / 86_400_000);
  }
}
