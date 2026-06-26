import type { AnalystReport, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";
import type { SourceCall } from "../types";
export type ShallowLlmCaller = (input: {
    role: "analyst" | "risk";
    data: StockData;
    analyst?: AnalystReport;
}) => Promise<string>;
/** 单条新闻。title 必有；content/time/source 可缺（数据源差异或拉取失败）。 */
export interface NewsItem {
    title: string;
    content?: string;
    time?: string;
    source?: string;
}
/** 新闻时间分层数量统计（news.py 的 layer_stats）。
 *  反映个股的市场关注密度 + 突发性，是 shallow 判断"热门/冷门"和"有无突发"的关键信号。
 *  - realtime_6h_count：最近 6 小时新闻数（>0 = 有突发，提权重）
 *  - total_categorized：7 天总条数（低 = 冷门股，流动性风险）
 *  全部 0 或 undefined = 无统计（拉取失败或字段缺失），不阻塞分析。 */
export interface NewsLayerStats {
    realtime_6h_count: number;
    extended_24h_count: number;
    history_7d_count: number;
    total_categorized: number;
}
/** 资金面摘要（来自 hot_money.py 的全局子源，parseHotMoney 预压缩为浅层字段 + 文本片段）。
 *
 *  注：个股 fund_flow（当日主力/超大单/大单净流入）已移除——同花顺"个股资金流"页面只收
 *  深市 ~1400 只活跃股，沪市几乎不收录，覆盖率天花板过低。保留的全局子源不受影响。
 *
 *  - 标量字段（northbound_*）：缺失或拉取失败 → 0/空串
 *  - 文本片段（dragon_tiger_recent / sector_inflow_top / sector_outflow_top / hot_stocks_top）：
 *    缺数据 → undefined，renderHotMoneySummary 据此省略对应分句
 *  - sector_in_industry_tag：标的行业是否落在当日板块流入/流出榜，"主线"|"弱势"|"未上榜"|""
 *  - dragon_tiger_reason：最近一次上榜原因（日涨幅偏离/换手达标等），判断游资炒作 vs 业绩驱动 */
export interface HotMoneyData {
    northbound_yi: number;
    northbound_signal: string;
    dragon_tiger_recent?: string;
    dragon_tiger_reason?: string;
    sector_inflow_top?: string;
    sector_outflow_top?: string;
    sector_in_industry_tag: string;
    hot_stocks_top?: string;
}
/** 最近 4 季度财务趋势（fundamentals.py 的 quarterly_trends 子源，datacenter RPT_LICO_FN_CPD）。
 *  字段对齐 fundamentals.py:243-261 的输出，字段全部可选（脚本按报告披露情况逐字段填）。 */
export interface QuarterlyTrend {
    report_date?: string;
    revenue_yi?: number;
    net_profit_yi?: number;
    eps?: number;
    revenue_yoy?: number;
    net_profit_yoy?: number;
    roe?: number;
    gross_margin?: number;
}
/** 机构一致预期（fundamentals.py 的 consensus_eps 子源，datacenter RPT_WEB_RESPREDICT）。
 *  字段对齐 fundamentals.py:306-355；forward_pe/peg 在脚本侧预计算（fundamentals.py:182-193），
 *  LLM 只引用不算，避免算术错误。很多小盘股无机构覆盖 → 整个对象 undefined。 */
export interface ConsensusEps {
    forecast_years?: {
        year: number;
        type: string;
        eps: number;
    }[];
    consensus_eps_current?: number;
    consensus_eps_next?: number;
    eps_growth_pct?: number;
    forward_pe?: number;
    peg?: number;
    target_price_min?: number;
    target_price_max?: number;
    ratings?: {
        buy?: number;
        overweight?: number;
        neutral?: number;
        underweight?: number;
        sell?: number;
    };
    analyst_count?: number;
}
/** 单条解禁记录（lockup.py 的 lockup_upcoming / lockup_history 元素）。
 *  字段对齐 lockup.py:27-33，shares/ratio 在脚本侧是字符串（FREE_SHARES_NUM/FREE_RATIO），
 *  这里原样保留字符串让 LLM 读，避免 parse 失败丢信息。 */
export interface LockupItem {
    date: string;
    type?: string;
    shares?: string;
    ratio?: string;
}
/** 单条减持记录（lockup.py 的 reduce_holdings 元素，对齐 lockup.py:176-185）。
 *  来自东财 datacenter RPT_REDUCED_HOLDINGS，REDUCE_DATE >= 今天（脚本用 now() 非 --date）。 */
export interface ReduceHolding {
    date: string;
    reducing_shareholder?: string;
    reducing_shares?: string;
    reducing_ratio?: string;
    reduce_reason?: string;
}
/** 解禁与减持摘要（lockup.py 输出的浅层压缩）。
 *  - pressure_rating：脚本按 upcoming 数量给的评级（"无明显压力"/"中等压力"/"重大压力"）
 *  - upcoming：未来 90 天解禁（核心风险，区间 [date, date+90]）
 *  - reduce_holdings：近期已披露减持明细（无计划类/进度类数据，仅已发生明细）
 *  全部字段缺失 → undefined（拉取失败或无数据），risk prompt 据此省略整段。 */
export interface LockupData {
    pressure_rating: string;
    upcoming: LockupItem[];
    reduce_holdings: ReduceHolding[];
}
export interface MacdData {
    dif: number;
    dea: number;
    histogram: number;
    direction: "看多" | "看空" | "中性";
    crossover: "golden" | "death" | "none";
}
export interface StockData {
    ticker: string;
    name: string;
    sector: string;
    kline: {
        pct_5d: number;
        pct_20d: number;
        support: number;
        resistance: number;
        volatility_20d: number;
        volume_ratio_5_20: number;
    };
    /** 个股新闻（最多 5 条，含标题/正文摘要/时间）。
     *  旧实现是 string[]（只有标题），现升级为 NewsItem[] 让 LLM 判断时效性 + 标题党。 */
    news: NewsItem[];
    hot_money: HotMoneyData;
    fundamentals: {
        pe: number;
        pb: number;
        rev_q1: number;
        np_q1: number;
        industry: string;
        quarterly_trends?: QuarterlyTrend[];
        consensus_eps?: ConsensusEps;
        pe_percentile?: number;
        pb_percentile?: number;
        capability_scores?: Record<string, {
            score: number;
            label: string;
        }>;
    };
    ranker_thesis?: string;
    /** kline.py 预计算的 VPA 量价分析文本（纯事实：价量变动%、交叉事件，无方向性结论）。
     *  undefined = 无 VPA 数据（非 kline 脚本或拉取失败）。 */
    vpa_text?: string;
    /** kline.py 预计算的 MACD 结构化数据（DIF/DEA/histogram/方向/金叉死叉）。
     *  undefined = 数据不足或拉取失败。 */
    macd?: MacdData;
    /** 新闻时间分层数量（news.py layer_stats）。undefined = 无统计，不阻塞分析。
     *  shallow 用它判断热门/冷门 + 有无突发，是一行文本的成本换密度信号。 */
    news_layer_stats?: NewsLayerStats;
    /** 4 个 Python 脚本的子源级调用记录（success/failure/duration_ms）。
     *  用于跨 run 聚合数据源健康统计。undefined = 无记录（老版本兼容）。 */
    calls?: SourceCall[];
    /** 解禁与减持（lockup.py）。undefined = 无数据，risk prompt 据此省略解禁段。
     *  rebalancer 是中期组合（7天+ anti-churn），未来 90 天大额解禁是硬风险，
     *  填补之前"fitness=8 但踩解禁洪峰"的盲区。 */
    lockup?: LockupData;
}
export declare function renderHotMoneySummary(h: HotMoneyData): string;
/** 把 4 季度财务趋势压成一行（对齐 renderHotMoneySummary 范式）。
 *
 *  格式：「营收 285/1200/880/560亿(同比+10.5/+8.2/+7.1/+6.0%) | 净利 32/130/95/60亿(同比...) | ROE 4.2/15.6/11.5/7.8%」
 *  - 按报告期降序（最近在前，对齐 fundamentals.py quarterly_trends 的排序）
 *  - 每段只在该段有数据时输出；缺同比 → 省略括号；无任何数据 → 空串（prompt 该行省略）
 *  - 负同比带负号（业绩下滑是风险信号，LLM 需识别）
 *  季度顺序由 fundamentals.py 的 sortColumns=REPORTDATE desc 保证，这里原样按数组顺序渲染。 */
export declare function renderQuarterlyTrends(trends?: QuarterlyTrend[]): string;
/** 把机构一致预期压成一行（对齐 renderHotMoneySummary 范式）。
 *
 *  格式：「26家覆盖 | EPS 45→52(+15.6%) | 目标价 1800-2000 | 评级 买18/增5/中性3 | 远期PE 34.6 | PEG 2.2」
 *  - 每段只在该字段有值时输出；无任何数据 → 空串（很多小盘股无机构覆盖，prompt 该行省略）
 *  - 负增速带负号（预期下滑是风险信号）
 *  - PEG 仅当脚本预计算给出时输出（fundamentals.py 仅正增长时算 PEG，故缺 PEG 不代表数据错）
 *  - 评级分布只列非零项，避免「买0/增0/中性0」噪音
 *  forward_pe/peg 由 fundamentals.py 预计算，LLM 只引用不算（避免算术错误）。 */
export declare function renderConsensus(c?: ConsensusEps): string;
/** 把解禁+减持压成一行（对齐 renderHotMoneySummary/renderQuarterlyTrends 范式）。
 *
 *  格式：「解禁压力：重大压力 | 未来90天2笔(最近 07-15 定增 0.4%；09-20 首发 1.2%) | 近期减持1笔(大股东 2.1%，个人资金需求)」
 *  - 压力评级（lockup.py pressure_rating，按 upcoming 数量给的档）
 *  - upcoming 取最近 3 笔（脚本已按日期升序），每笔：MM-DD 类型 ratio
 *  - reduce_holdings 取最近 2 笔（脚本按日期倒序），每笔：股东 ratio 原因
 *  每段只在该段有数据时输出；无 upcoming 且无减持 → 只输出压力评级行（让 LLM 知道无压力）。
 *  ratio 字段是字符串（如"0.4%"），原样透传让 LLM 读，避免 parse 失败丢信息。 */
export declare function renderLockup(l: LockupData): string;
/** 渲染 MACD 动量信号为一行文本。无数据 → 空串（prompt 该行省略）。
 *  格式：「DIF=0.523 DEA=0.481 柱状图=0.042 多头｜金叉」
 *  让 LLM 识别动量方向 + 交叉信号（金叉=看多加速，死叉=看空加速）。 */
export declare function renderMacd(m?: MacdData): string;
/** 渲染 PE/PB 历史分位标注（如「[近5年15%分位]」），无数据 → 空串（向后兼容）。
 *  分位含义：0-100，表示当前值在近5年序列里的位置——低分位=相对便宜，高分位=相对贵。
 *  让 LLM 据此判断"PE=18 在该股历史上贵不贵"，治绝对值盲区。 */
export declare function renderPercentileLabel(percentile: number | undefined): string;
/** 渲染 PE 值为 prompt 友好的文本，归一化无意义的负值/零值。
 *
 *  亏损股 PE = 市值/负净利 < 0，数学上无意义，投资语义 = "亏损"。
 *  裸注入 `-3033.67` 会让 LLM 误判为"天价 PE → 估值严重偏高"（实测误判）。
 *  归一化规则：
 *  - 负值（净利为负/亏损）→ "N/A（亏损）"，让 LLM 识别为亏损而非高估值
 *  - 0（未拉取到/字段缺失）→ "N/A"
 *  - 正常正值 → 保留 2 位小数
 *  注意：fundamentals.pe 保留原始数值不变，此函数只影响 prompt 文本呈现。 */
export declare function renderPe(pe: number): string;
export declare function formatAnalystPrompt(d: StockData): string;
/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
export declare function parseAnalystReport(content: string): AnalystReport | null;
export declare function formatRiskPrompt(d: StockData, analyst: AnalystReport): string;
export declare function parseRiskReport(content: string): RiskReport | null;
/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。
 *
 *  qualityNotes（可选）：确定性质量门控 applyQualityGate 的产物。传入则落
 *  StockReport.quality_notes，便于复盘"为什么这只股 fitness 从 8 变 6"。
 *  空数组或 undefined → 不写该字段（保持 plan.json 简洁）。 */
export declare function buildStockReport(meta: CandidateMeta, sector: string, analyst: AnalystReport, risk: RiskReport, qualityNotes?: string[]): StockReport;
/** 持仓股 shallow-analyzer 失败时的保守默认 report。
 *
 *  为什么持仓股不能像候选股一样"失败就消失"：
 *  - 候选股失败 = 少一个机会（损失小）
 *  - 持仓股失败 = 漏看一个风险（损失大）—— rebalancer 既不 HOLD 也不 REDUCE，
 *    一个用户实际持有的、可能需要止损的股被静默忽略
 *
 *  默认值设计（逼 rebalancer 面对，但不乱下结论）：
 *  - fitness=5：触发"持仓 fitness≤5 必须 REDUCE/SELL"硬规则，rebalancer 必须提它
 *  - risk=high：数据缺失=未知风险，仓位公式会打折
 *  - deal_breaker=false：无证据不清仓（清仓是重大决策）
 *  - locked 保留：anti-churn 卖锁仍生效，不会乱减锁定股 */
export declare function buildFallbackReport(meta: CandidateMeta, sector: string, reason: string): StockReport;
/** 对所有候选/持仓股跑 analyst + risk 双 call（单股内串行，跨股并发限制）。
 *
 *  失败处理（风控关键）：
 *  - 候选股失败 → 跳过（少一个机会，无伤大雅）
 *  - 持仓股失败 → 保守默认 report（fitness=5, risk=high），不消失
 *    否则 rebalancer 看不到它，一个可能需要止损的持仓股被静默忽略
 *
 *  concurrency 默认 3 —— zhipu glm-5.1 free tier 在并发 ≥5 时触发 429。
 *  跨股 worker pool + 单股内 analyst→risk 串行 = 任意时刻最多 concurrency 个 LLM call。 */
export declare function analyzeAll(metas: CandidateMeta[], dataByTicker: Map<string, StockData>, caller: ShallowLlmCaller, concurrency?: number): Promise<StockReport[]>;
//# sourceMappingURL=shallow-analyzer.d.ts.map