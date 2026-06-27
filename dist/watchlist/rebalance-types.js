"use strict";
// src/watchlist/rebalance-types.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REBALANCE_CONFIG = void 0;
// 趋势模式默认配置：适度集中（5-8 只 / 单仓≤15%）+ 低现金（5%）+ 高换手容忍
// 20 万小账户定位：5-8 只满仓（95%÷5=19%、÷8=12%），fit8 单票≈1.9万，手续费可控
exports.DEFAULT_REBALANCE_CONFIG = {
    top_n: 10,
    constraints: {
        single_name: 0.15, // 单仓上限 15%（适度集中，对应 fit8 baseWeight 9.6% 不被截断）
        single_sector: 0.25, // 单行业 25%（分散）
        daily_turnover: 0.40, // 日换手 40%（趋势策略需灵活调仓）
        cash_reserve: 0.05, // 现金下限 5%（趋势模式要在场，少留现金）
        initial_stop_drawdown: 0.07, // 建仓回撤止损 7%（国瓷 -8.3% 能触发，香农正常波动 <5% 不误伤）
        initial_stop_days: 3, // 建仓后 3 天内回撤超阈值 → 强制清仓；超过靠技术信号
    },
    anti_churn_days: 7,
    max_revise_retries: 2,
    run_optional_scripts: false,
    shallow_concurrency: 2,
};
//# sourceMappingURL=rebalance-types.js.map