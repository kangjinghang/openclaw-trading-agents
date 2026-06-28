"use strict";
// src/watchlist/rebalance-types.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REBALANCE_CONFIG = void 0;
// 趋势模式默认配置：集中（3-5 只 / 单仓≤22%）+ 低现金（3%）+ 高换手容忍
// 20 万小账户定位：3-5 只集中（÷4=5万/只，覆盖100元以下标的能买整手），fit8 单票≈1.9万
//
// 参数置信度（✅回测验证 / ⚠️猜测待验证 / ❓未知），调参前看 docs/backtest-params.md：
//   single_name 0.22          ✅ 回测验证（集中定位，让 fit10 不截断）
//   single_sector 0.25         ⚠️ 当前仓位下未触发（一级聚合后电子 18.5% < 25%），本金变大才会真正考验
//   cash_reserve 0.03          ✅ 回测验证（趋势要在场）
//   initial_stop_drawdown 0.07 ✅ 国瓷 -8.3% 能触发，香农正常波动 <5% 不误伤
//   initial_stop_days 3        ❓ 生益第6天破位未触发，可能偏短，待 A/B 对比 3/5/7 天
//   max_positions 5            ✅ 落实"3-5 只"定位（之前是 prompt 软引导，LLM 无视买到 7-8 只）
//   take_profit_threshold 0.15 ✅ 止盈豁免（浮盈≥15% 可突破锁，豫光 +7.6% 想止盈被挡的 case）
//   daily_turnover 0.50        ✅ 单向算法（max(买,卖)）+ 放宽 0.40→0.50，修满仓换仓死亡螺旋
//   max_revise_retries 3       ✅ 2→3，多一次收敛机会（换手/持仓数违规时需要 LLM 砍动作）
//   anti_churn_days 7          ⚠️ 经验值（防 churn vs 灵活调仓的平衡点，未压力测试）
exports.DEFAULT_REBALANCE_CONFIG = {
    top_n: 15, // 候选数 15（max_positions=5 的 3 倍，给跨行业选股 + 备选留空间；太小→非电子强标的进不来）
    constraints: {
        single_name: 0.22, // 单仓上限 22%（集中定位，对应 fit10 baseWeight 22% 不被截断）
        single_sector: 0.25, // 单行业 25%（分散，一级聚合）
        daily_turnover: 0.50, // 日换手上限 50%（单向 max(买入,卖出)；满仓换 3 只≈30%，留余量）
        cash_reserve: 0.03, // 现金下限 3%（趋势模式要在场，少留现金）
        initial_stop_drawdown: 0.07, // 建仓回撤止损 7%（国瓷 -8.3% 能触发，香农正常波动 <5% 不误伤）
        initial_stop_days: 3, // 建仓后 3 天内回撤超阈值 → 强制清仓；超过靠技术信号
        max_positions: 5, // 持仓数上限 5（落实"3-5 只"集中定位，上限非必须达到）
        take_profit_threshold: 0.15, // 止盈豁免 15%（浮盈≥15% 可突破 anti-churn 锁卖出，落袋为安不是 churn）
    },
    anti_churn_days: 7,
    max_revise_retries: 3,
    run_optional_scripts: false,
    shallow_concurrency: 2,
};
//# sourceMappingURL=rebalance-types.js.map