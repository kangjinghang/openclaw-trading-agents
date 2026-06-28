import { type RebalancePipelineResult } from "./watchlist/rebalancer";
import type { Action, Holdings } from "./watchlist/rebalance-types";
/** 把一天的完整调仓决策落盘到 backtest/days/<date>/rebalance.json。
 *
 *  这是回测可审计性的关键：LLM 写的 evaluations（每股评估）、每个 action 的 reason、
 *  组合 summary、约束 revise 过程、每股 fitness/risk/thesis（reason 的"依据"）全部归档。
 *  state.json 只管持仓模拟（精简），调仓"为什么"归这里——两者职责分离。
 *
 *  status 非 ok（被约束否决 / 解析失败）也照存，反而更要看：为什么那天没调成仓。
 *  导出供测试覆盖（CLI 入口默认不导出符号，这里显式导出纯函数）。 */
export declare function archiveDayRebalance(backtestDir: string, date: string, holdings: Holdings, result: RebalancePipelineResult): void;
/** days/<date>/rebalance.json 的最小读取类型（archiveDayRebalance 的产出）。
 *  字段大多可选：历史归档可能由更早版本写入，缺字段时优雅降级而非崩。 */
export interface DayRebalanceArchive {
    date: string;
    written_at?: string;
    status: string;
    portfolio_before?: {
        cash_pct: number;
        positions: Array<{
            ticker: string;
            name: string;
            sector: string;
            weight: number;
            entry_price: number;
            entry_date: string;
        }>;
    };
    rebalancer_output?: {
        evaluations?: Array<{
            ticker: string;
            judgment: string;
            brief: string;
        }>;
        actions?: Action[];
        summary?: string;
    };
    constraint_check?: {
        revise_count?: number;
        violations?: Array<string | {
            rule?: string;
            detail?: string;
        }>;
    };
}
/** 渲染一天的归档调仓决策到终端。
 *  这是"为什么那天这么调"的人类可读视图：评估表 + 动作理由 + 组合总结 + 约束博弈。
 *  数据源是 archiveDayRebalance 写的 days/<date>/rebalance.json。
 *  导出供测试覆盖渲染契约（用户依赖此输出读调仓计划）。 */
export declare function renderDayRebalance(archive: DayRebalanceArchive): string;
//# sourceMappingURL=backtest-cli.d.ts.map