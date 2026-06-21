"use strict";
// src/watchlist/rebalance-types.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REBALANCE_CONFIG = void 0;
exports.DEFAULT_REBALANCE_CONFIG = {
    top_n: 10,
    constraints: {
        single_name: 0.15,
        single_sector: 0.30,
        daily_turnover: 0.30,
        cash_reserve: 0.10,
    },
    anti_churn_days: 7,
    max_revise_retries: 2,
    run_optional_scripts: false,
};
//# sourceMappingURL=rebalance-types.js.map