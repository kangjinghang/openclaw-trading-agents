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
  /** 建仓时 LLM 评的 fitness（0-10），null = 旧持仓/缺数据。用于校准评分预测力。 */
  entryFitness: number | null;
  /** 该笔交易（一买一卖）累计扣除的交易成本（元）。仅 SELL 平仓时填入（建仓成本+平仓成本之和）。
   *  null/undefined = 未启用手续费建模（旧 state 兼容）或未平仓。 */
  cost?: number | null;
}

/** A 股交易成本模型：佣金（双向，最低 5 元）+ 印花税（仅卖出）+ 过户费（双向）。
 *  仅用于 backtest-simulator 成交扣成本，让回测收益真实化——不进 LLM 决策层。
 *  所有费率均为小数比例（如万一 = 0.0001），commissionMin 单位为元。
 *
 *  当前默认值（2026-06）：佣金万一（用户实盘费率）、印花税万五（2023.8.28 降税后）、
 *  过户费万零点一（2022 起沪深统一）。20 万账户 7 天回测成本约 150 元，占利润 5.4%。
 *  完整费率依据见 docs/backtest-params.md「交易成本」小节。 */
export interface TradingFees {
  /** 佣金费率（双向）。万一 = 0.0001。 */
  commissionRate: number;
  /** 单笔最低佣金（元）。A 股普遍 5 元。小账户单笔金额小常触发此下限。 */
  commissionMin: number;
  /** 印花税费率（仅卖出）。2023.8.28 起 万五 = 0.00005。 */
  stampTaxRate: number;
  /** 过户费费率（双向）。万零点一 = 0.00001。2022 起沪深统一按成交额征收。 */
  transferFeeRate: number;
}

/** 默认交易成本（A 股标准 + 用户实盘佣金费率万一）。 */
export const DEFAULT_TRADING_FEES: TradingFees = {
  commissionRate: 0.0001,    // 万一
  commissionMin: 5,          // 最低 5 元/笔
  stampTaxRate: 0.00005,     // 万五（仅卖出）
  transferFeeRate: 0.00001,  // 万零点一（双向）
};

/** 单笔交易成本明细（元），由 computeFees 输出。 */
interface FeeBreakdown {
  commission: number;   // 佣金（含最低 5 元下限）
  stampTax: number;     // 印花税（仅卖出，买入为 0）
  transferFee: number;  // 过户费
  total: number;        // 三项合计
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

/** 序列化后的 PositionSimulator 全量状态（跨进程持久化用）。
 *  所有字段都是 JSON 原生：positions 从 Map 转为数组，SimPosition 结构等同 Position。
 *
 *  realCapital / lotSize 为可选：缺失 = 未启用手数取整（旧 state v1 兼容；
 *  v2 起由 backtest-cli 写入，增量续跑保持同一本金口径）。 */
export interface SerializedSimState {
  cash: number;                          // 归一化现金绝对值（非占比）
  recentSells: Record<string, string>;   // ticker → 最后卖出日，14 天 TTL 反复 churn 锁
  lastRebalanceDate: string | null;
  positions: Position[];                 // 持仓数组（含 shares 等全部字段）
  navHistory: NavSnapshot[];
  trades: TradeRecord[];
  realCapital?: number;                  // 真实本金（如 200000）；>0 启用手数取整
  lotSize?: number;                      // 最小手数（A 股主板 100，科创板 200）
  fees?: TradingFees;                    // 交易成本模型（缺失 = 未启用，旧 state 兼容）
}

/** applyPlan 取整跳过记录：回测真实反映"买不起 1 手"的标的。 */
export interface SkippedBuy {
  ticker: string;
  name: string;
  reason: string;                        // 如"0.08 仓位 × 20万 / 245元 = 65 股 < 1 手(100)"
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
  // 手数取整配置：realCapital>0 且 lotSize>0 启用。缺失走旧逻辑（浮点份额，向后兼容）。
  private readonly realCapital?: number;
  private readonly lotSize?: number;
  // 交易成本模型：传入即启用成交扣成本。缺失 = 不扣（旧 state / 纯测试兼容）。
  private readonly fees?: TradingFees;
  // 建仓成本记账（归一化）：ticker → 建仓时扣的佣金+过户费（归一化）。
  // 平仓时取出，加到 TradeRecord.cost 里（建仓成本 + 平仓成本之和），供审计。
  private entryCostByTicker = new Map<string, number>();

  constructor(priceLookup: PriceLookup, options?: { realCapital?: number; lotSize?: number; fees?: TradingFees }) {
    this.priceLookup = priceLookup;
    if (options && (options.realCapital ?? 0) > 0 && (options.lotSize ?? 0) > 0) {
      this.realCapital = options.realCapital;
      this.lotSize = options.lotSize;
    }
    this.fees = options?.fees;
  }

  /** 是否启用手数取整。 */
  private get lotRoundingEnabled(): boolean {
    return this.realCapital !== undefined && this.lotSize !== undefined;
  }

  /** 是否启用交易成本建模。仅在 lotRoundingEnabled（有 realCapital 换算）时才有意义——
   *  成本以"元"计算，需要 realCapital 把归一化金额换算成真实金额。 */
  private get feesEnabled(): boolean {
    return this.lotRoundingEnabled && this.fees !== undefined;
  }

  /** 算单笔交易成本（元）。value 为真实成交金额（元），isSell 决定是否收印花税。
   *  佣金：max(value × commissionRate, commissionMin) —— 小账户单笔常触发最低 5 元。
   *  印花税：仅卖出收（value × stampTaxRate），买入为 0。
   *  过户费：双向收（value × transferFeeRate）。
   *  未启用 fees 时返回全 0（向后兼容）。 */
  private computeFees(value: number, isSell: boolean): FeeBreakdown {
    if (!this.fees) {
      return { commission: 0, stampTax: 0, transferFee: 0, total: 0 };
    }
    const commission = Math.max(value * this.fees.commissionRate, this.fees.commissionMin);
    const stampTax = isSell ? value * this.fees.stampTaxRate : 0;
    const transferFee = value * this.fees.transferFeeRate;
    return { commission, stampTax, transferFee, total: commission + stampTax + transferFee };
  }

  /** 把真实金额（元）的成本转成归一化成本（除以 realCapital）。
   *  simulator 全程在归一化空间操作 cash，所以扣成本也要归一化。 */
  private feesToNorm(feeYuan: number): number {
    return this.realCapital ? feeYuan / this.realCapital : 0;
  }

  /** 把归一化目标市值转成取整后的真实手数。
   *  返回 lotShares（lotSize 的倍数，0 = 不足 1 手）。仅在 lotRoundingEnabled 时有意义。 */
  private roundToLot(normValue: number, price: number): number {
    const cap = this.realCapital!;
    const lot = this.lotSize!;
    const rawShares = (normValue * cap) / price;  // 真实股数
    return Math.floor(rawShares / lot) * lot;
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
   *  priceMap 复用 normalizeWeights 缓存（SELL/REDUCE 的 exitPrice 从中取，BUY 新股需补查）。
   *
   *  手数取整（lotRoundingEnabled 时）：BUY/ADD/REDUCE 的成交股数取整到 lotSize 的倍数，
   *  不足 1 手的 BUY 记入 skippedBuys（回测真实反映"买不起 1 手"的高价股）。
   *  返回 { skippedBuys }；未启用取整时恒为空数组。
   *
   *  为什么取整在成交层而不在候选池过滤？因为候选池阶段（candidates.json / scan.json）
   *  没有价格数据——价格 last_close 要到 rebalancer 拉完 K 线才有。而且固定价格阈值粗糙，
   *  "买不买得起一手"取决于动态仓位（fitness×系数），不该在候选池用固定阈值判断。
   *  完整推理见 docs/backtest-evolution.md 决策A。 */
  async applyPlan(
    result: RebalancePipelineResult,
    date: string,
    reportsByTicker: Map<string, { fitness_score: number; name: string; sector: string }>,
    priceMap?: Map<string, number>,
  ): Promise<{ skippedBuys: SkippedBuy[] }> {
    const actions = result.rebalancer_output.actions;
    const totalNav = await this.getNav(date, priceMap);
    const entryDate = date;  // 当日收盘价建仓
    const skippedBuys: SkippedBuy[] = [];
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
        // 卖出成本：佣金 + 印花税（仅卖出）+ 过户费（双向）
        const sellValueYuan = pos.shares * exitPrice * (this.realCapital ?? 0);
        const sellFees = this.computeFees(sellValueYuan, true);
        // 建仓成本（建仓时记的归一化值 → 转回元）+ 平仓成本 = 该笔交易累计成本
        const entryCostNorm = this.entryCostByTicker.get(a.ticker) ?? 0;
        const entryCostYuan = entryCostNorm * (this.realCapital ?? 0);
        const totalTradeCost = this.feesEnabled ? entryCostYuan + sellFees.total : null;
        // 记交易（平仓）+ 记录建仓时 fitness（校准评分预测力用）
        this.trades.push({
          ticker: a.ticker, name: pos.name,
          entryDate: pos.entry_date, entryPrice,
          exitDate: date, exitPrice, holdDays, returnPct,
          exitReason: a.reason,
          entryFitness: pos.entry_fitness ?? null,
          ...(totalTradeCost !== null ? { cost: totalTradeCost } : {}),
        });
        // 释放现金：卖出的份额按当日价格变现，扣卖出成本（归一化）
        const sellProceedsNorm = pos.shares * exitPrice;
        const sellFeesNorm = this.feesToNorm(sellFees.total);
        this.cash += sellProceedsNorm - sellFeesNorm;
        this.positions.delete(a.ticker);
        this.entryCostByTicker.delete(a.ticker);
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
      let sharesToSellNorm = pos.shares * reduceRatio;  // 归一化份额

      // 手数取整：把归一化份额换算成真实股数 → 取整到 lotSize → 不足 1 手不卖
      if (this.lotRoundingEnabled) {
        const rawShares = sharesToSellNorm * this.realCapital!;  // 真实股数
        const lotShares = Math.floor(rawShares / this.lotSize!) * this.lotSize!;
        if (lotShares <= 0) continue;  // 减仓不足 1 手，跳过
        sharesToSellNorm = lotShares / this.realCapital!;  // 取整后回归一化
      }

      this.cash += sharesToSellNorm * exitPrice - this.feesToNorm(
        this.computeFees(sharesToSellNorm * exitPrice * (this.realCapital ?? 0), true).total
      );
      pos.shares -= sharesToSellNorm;
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
      const targetValue = a.target_weight * totalNav;  // 目标市值（归一化）
      const report = reportsByTicker.get(a.ticker);
      const existing = this.positions.get(a.ticker);

      if (existing) {
        // ADD：加仓到 target_weight
        const currentSharesValue = existing.shares * entryPrice;
        const addValueNorm = Math.max(0, targetValue - currentSharesValue);  // 归一化增量市值
        let sharesToAdd = addValueNorm / entryPrice;  // 归一化份额

        // 手数取整：加仓增量不足 1 手 → 不加（保持原仓）
        if (this.lotRoundingEnabled) {
          const lotShares = this.roundToLot(addValueNorm, entryPrice);
          if (lotShares <= 0) continue;  // 增量不足 1 手
          sharesToAdd = lotShares / this.realCapital!;  // 取整后回归一化
          // ADD 的成交市值用实际取整后的份额算（而非 targetValue），保证 cash 精确
          // 买入成本：佣金 + 过户费（无印花税）
          const addValueYuan = sharesToAdd * entryPrice * this.realCapital!;
          const addFeesNorm = this.feesToNorm(this.computeFees(addValueYuan, false).total);
          this.cash = Math.max(0, this.cash - sharesToAdd * entryPrice - addFeesNorm);
          existing.shares += sharesToAdd;
          existing.weight = a.target_weight;
          continue;
        }

        existing.shares += sharesToAdd;
        existing.weight = a.target_weight;
        // ADD 保持 entry_date（anti-churn 锁连续）
        // 消耗现金 + 买入成本（佣金 + 过户费，无印花税）
        const addFallbackValueYuan = sharesToAdd * entryPrice * (this.realCapital ?? 0);
        const addFallbackFeesNorm = this.feesToNorm(this.computeFees(addFallbackValueYuan, false).total);
        this.cash = Math.max(0, this.cash - sharesToAdd * entryPrice - addFallbackFeesNorm);
        if (this.feesEnabled) {
          this.entryCostByTicker.set(a.ticker, (this.entryCostByTicker.get(a.ticker) ?? 0) + addFallbackFeesNorm);
        }
      } else {
        // BUY：新建仓
        let shares = targetValue / entryPrice;
        let filledValue = targetValue;  // 实际消耗的归一化现金

        // 手数取整：买不起 1 手 → 跳过并记录
        if (this.lotRoundingEnabled) {
          const lotShares = this.roundToLot(targetValue, entryPrice);
          if (lotShares <= 0) {
            const rawShares = (targetValue * this.realCapital!) / entryPrice;
            skippedBuys.push({
              ticker: a.ticker,
              name: a.name,
              reason: `${(a.target_weight * 100).toFixed(1)}% 仓位 × ${this.realCapital} / ${entryPrice.toFixed(2)}元 = ${rawShares.toFixed(0)} 股 < 1 手(${this.lotSize})`,
            });
            continue;
          }
          shares = lotShares / this.realCapital!;  // 取整后回归一化
          filledValue = shares * entryPrice;       // 实际成交市值（≤ targetValue）
        }

        // 买入成本：佣金 + 过户费（无印花税）。无论是否取整都按实际成交额算。
        const buyValueYuan = filledValue * (this.realCapital ?? 0);
        const buyFeesNorm = this.feesToNorm(this.computeFees(buyValueYuan, false).total);

        this.positions.set(a.ticker, {
          ticker: a.ticker,
          name: a.name,
          weight: a.target_weight,
          entry_price: entryPrice,
          entry_date: entryDate,
          shares,
          sector: report?.sector ?? "未分类",
          // 记录建仓时 LLM 评分，供平仓后校准"评分 vs 实际收益"预测力
          entry_fitness: report?.fitness_score,
        });
        this.cash = Math.max(0, this.cash - filledValue - buyFeesNorm);
        // 记建仓成本（归一化），平仓时取出加进 TradeRecord.cost
        if (this.feesEnabled) {
          this.entryCostByTicker.set(a.ticker, (this.entryCostByTicker.get(a.ticker) ?? 0) + buyFeesNorm);
        }
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
    return { skippedBuys };
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
        entryFitness: pos.entry_fitness ?? null,
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

  /** 导出全量状态供持久化（跨进程续跑）。
   *  所有 private 字段都是 JSON 原生：positions 的 Map → Array 转换。 */
  serialize(): SerializedSimState {
    return {
      cash: this.cash,
      recentSells: { ...this.recentSells },
      lastRebalanceDate: this.lastRebalanceDate,
      positions: Array.from(this.positions.values()).map(p => ({
        ticker: p.ticker, name: p.name, weight: p.weight,
        entry_price: p.entry_price, entry_date: p.entry_date,
        shares: p.shares, sector: p.sector,
        ...(p.entry_fitness !== undefined ? { entry_fitness: p.entry_fitness } : {}),
      })),
      navHistory: this.navHistory.map(s => ({ ...s, actions: [...s.actions] })),
      trades: this.trades.map(t => ({ ...t })),
      ...(this.realCapital !== undefined ? { realCapital: this.realCapital } : {}),
      ...(this.lotSize !== undefined ? { lotSize: this.lotSize } : {}),
      ...(this.fees !== undefined ? { fees: this.fees } : {}),
    };
  }

  /** 从序列化状态恢复（跨进程续跑）。
   *  priceLookup 是注入依赖，每次新建进程时由调用方重新注入。
   *  options 可显式覆盖 state 里的 realCapital/lotSize/fees（CLI 传 --capital/--no-fees 时优先）。 */
  static fromSerialized(
    state: SerializedSimState,
    priceLookup: PriceLookup,
    options?: { realCapital?: number; lotSize?: number; fees?: TradingFees },
  ): PositionSimulator {
    // 选项优先级：显式 options > state 记录 > 缺省
    // fees 特殊：options.fees 显式传入（含 null/undefined 占位）时以 options 为准，
    // 否则回退 state.fees（续跑保持上一轮的成本口径）。
    const realCapital = options?.realCapital ?? state.realCapital;
    const lotSize = options?.lotSize ?? state.lotSize;
    const opts: { realCapital?: number; lotSize?: number; fees?: TradingFees } = {};
    if (realCapital !== undefined && lotSize !== undefined) {
      opts.realCapital = realCapital;
      opts.lotSize = lotSize;
    }
    // options 带 fees 键（含 undefined）→ 以 options 为准；否则回退 state.fees
    if (options && "fees" in options) {
      if (options.fees) opts.fees = options.fees;
    } else if (state.fees) {
      opts.fees = state.fees;
    }
    const sim = new PositionSimulator(priceLookup, Object.keys(opts).length > 0 ? opts : undefined);
    sim.cash = state.cash;
    sim.recentSells = { ...state.recentSells };
    sim.lastRebalanceDate = state.lastRebalanceDate;
    sim.positions = new Map(state.positions.map(p => [p.ticker, {
      ticker: p.ticker, name: p.name, weight: p.weight,
      entry_price: p.entry_price, entry_date: p.entry_date,
      shares: p.shares, sector: p.sector,
      ...(p.entry_fitness !== undefined ? { entry_fitness: p.entry_fitness } : {}),
    }]));
    sim.navHistory = state.navHistory.map(s => ({ ...s, actions: [...s.actions] }));
    sim.trades = state.trades.map(t => ({ ...t }));
    return sim;
  }

  /** 当前持仓快照（浮动盈亏）：供增量模式每日展示当前持仓状态。
   *  与 closeOpenPositions 不同——它不把持仓记入 trades（否则会把仍持有的记成未平仓交易）。
   *  weight 用 normalizeWeights 漂移后的值（调用方应先调 normalizeWeights）。 */
  async currentHoldingsSnapshot(
    date: string,
    priceMap?: Map<string, number>,
  ): Promise<{ ticker: string; name: string; entryDate: string; weight: number; returnPct: number }[]> {
    const out: { ticker: string; name: string; entryDate: string; weight: number; returnPct: number }[] = [];
    for (const [, pos] of this.positions) {
      const price = priceMap?.get(pos.ticker) ?? await this.priceLookup(pos.ticker, date) ?? pos.entry_price;
      out.push({
        ticker: pos.ticker,
        name: pos.name,
        entryDate: pos.entry_date,
        weight: pos.weight,
        returnPct: (price / pos.entry_price - 1) * 100,
      });
    }
    // 按权重降序
    return out.sort((a, b) => b.weight - a.weight);
  }

  private calcHoldDays(entryDate: string, exitDate: string): number {
    const ms = new Date(exitDate + "T00:00:00+08:00").getTime()
             - new Date(entryDate + "T00:00:00+08:00").getTime();
    return Math.floor(ms / 86_400_000);
  }
}
