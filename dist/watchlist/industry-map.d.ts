export declare const SW_L1_INDUSTRIES: Set<string>;
/** 把行业标签映射到申万一级。
 *
 *  解析顺序：
 *  1. 空串/未分类 → 原样返回（让规则 3 单独累计，不混入任何一级）
 *  2. 已是一级名 → 原样返回（东财偶尔直接返回一级名，如"电子"）
 *  3. 二级→一级映射表命中 → 返回对应一级
 *  4. 都不命中 → 原样返回（兜底：未知标签不强行归类，避免误合并）
 *
 *  幂等性：mapIndustryToL1(mapIndustryToL1(x)) === mapIndustryToL1(x)
 *  （一级名再映射仍是自己，保证可重复调用安全）。 */
export declare function mapIndustryToL1(industry: string | undefined | null): string;
//# sourceMappingURL=industry-map.d.ts.map