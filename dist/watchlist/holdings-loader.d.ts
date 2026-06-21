import type { Holdings } from "./rebalance-types";
export interface ValidationResult {
    ok: boolean;
    error: string | null;
}
/** 校验 holdings schema + 权重和。 */
export declare function validateHoldings(h: Holdings): ValidationResult;
/** 计算某 entry_date 在 currentDate 下是否被 anti-churn 锁定。
 *  antiChurnDays=0 表示永不锁定。格式错误也返回 false（防御性）。 */
export declare function computeLocked(entryDate: string, currentDate: string, antiChurnDays: number): boolean;
/** 读 holdings.json 文件 + 校验。文件不存在或校验失败抛错。 */
export declare function loadHoldings(filePath: string): Holdings;
//# sourceMappingURL=holdings-loader.d.ts.map