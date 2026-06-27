"use strict";
// src/watchlist/rebalance-types.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REBALANCE_CONFIG = void 0;
// 趋势模式默认配置：分散（8-12 只 / 单仓≤10%）+ 低现金（5%）+ 高换手容忍
exports.DEFAULT_REBALANCE_CONFIG = {
    top_n: 10,
    constraints: {
        single_name: 0.10, // 单仓上限 10%（分散要求，对应 fitness 线性映射上限 8%）
        single_sector: 0.25, // 单行业 25%（分散）
        daily_turnover: 0.40, // 日换手 40%（趋势策略需灵活调仓）
        cash_reserve: 0.05, // 现金下限 5%（趋势模式要在场，少留现金）
    },
    anti_churn_days: 7,
    max_revise_retries: 2,
    run_optional_scripts: false,
    shallow_concurrency: 2,
};
//# sourceMappingURL=rebalance-types.js.map