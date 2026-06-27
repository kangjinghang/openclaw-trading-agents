import type { AnalystReport, RiskFlag, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";
import type { SourceCall } from "../types";
import { applyQualityGate } from "./quality-gate";

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
  northbound_yi: number;         // 全市场北向净流入（亿元）
  northbound_signal: string;     // "inflow"|"outflow"|""（无北向数据则空串）
  dragon_tiger_recent?: string;  // 近 30 天龙虎榜预压缩文本（最近 2 条：日期+净买+换手）
  dragon_tiger_reason?: string;  // 最近一次上榜原因（东财 EXPLANATION，截 20 字）
  sector_inflow_top?: string;    // 当日行业板块流入 top3 名称（"/" 分隔）
  sector_outflow_top?: string;   // 当日行业板块流出 top3 名称（"/" 分隔）
  sector_in_industry_tag: string;// 标的行业归属："主线"|"弱势"|"未上榜"|""
  hot_stocks_top?: string;       // 当日热门股 top3 预压缩文本
}

/** 最近 4 季度财务趋势（fundamentals.py 的 quarterly_trends 子源，datacenter RPT_LICO_FN_CPD）。
 *  字段对齐 fundamentals.py:243-261 的输出，字段全部可选（脚本按报告披露情况逐字段填）。 */
export interface QuarterlyTrend {
  report_date?: string;       // 报告期 YYYY-MM-DD
  revenue_yi?: number;        // 营收（亿元）
  net_profit_yi?: number;     // 净利润（亿元）
  eps?: number;               // 每股收益
  revenue_yoy?: number;       // 营收同比 %
  net_profit_yoy?: number;    // 净利同比 %
  roe?: number;               // 加权 ROE %
  gross_margin?: number;      // 毛利率 %
}

/** 机构一致预期（fundamentals.py 的 consensus_eps 子源，datacenter RPT_WEB_RESPREDICT）。
 *  字段对齐 fundamentals.py:306-355；forward_pe/peg 在脚本侧预计算（fundamentals.py:182-193），
 *  LLM 只引用不算，避免算术错误。很多小盘股无机构覆盖 → 整个对象 undefined。 */
export interface ConsensusEps {
  forecast_years?: { year: number; type: string; eps: number }[]; // 4 年 EPS（A=实际/E=预测）
  consensus_eps_current?: number;  // 当期一致 EPS
  consensus_eps_next?: number;     // 次年一致 EPS
  eps_growth_pct?: number;         // 预期增速 %
  forward_pe?: number;             // 远期 PE = 现价 / 次年 EPS（脚本预计算）
  peg?: number;                    // PE_TTM / 预期增速（仅正增长时给，脚本预计算）
  target_price_min?: number;       // 目标价下限
  target_price_max?: number;       // 目标价上限
  ratings?: { buy?: number; overweight?: number; neutral?: number; underweight?: number; sell?: number };
  analyst_count?: number;          // 覆盖机构数
}

/** 单条解禁记录（lockup.py 的 lockup_upcoming / lockup_history 元素）。
 *  字段对齐 lockup.py:27-33，shares/ratio 在脚本侧是字符串（FREE_SHARES_NUM/FREE_RATIO），
 *  这里原样保留字符串让 LLM 读，避免 parse 失败丢信息。 */
export interface LockupItem {
  date: string;       // 解禁日 YYYY-MM-DD
  type?: string;      // 限售股类型（"定增限售"/"首发原股东限售" 等）
  shares?: string;    // 解禁股数（字符串）
  ratio?: string;     // 解禁比例（如 "0.4%"，字符串）
}

/** 单条减持记录（lockup.py 的 reduce_holdings 元素，对齐 lockup.py:176-185）。
 *  来自东财 datacenter RPT_REDUCED_HOLDINGS，REDUCE_DATE >= 今天（脚本用 now() 非 --date）。 */
export interface ReduceHolding {
  date: string;                // 减持日 YYYY-MM-DD
  reducing_shareholder?: string; // 减持股东
  reducing_shares?: string;      // 减持股数（字符串）
  reducing_ratio?: string;       // 减持比例（字符串）
  reduce_reason?: string;        // 减持原因（个人资金需求 等）
}

/** 解禁与减持摘要（lockup.py 输出的浅层压缩）。
 *  - pressure_rating：脚本按 upcoming 数量给的评级（"无明显压力"/"中等压力"/"重大压力"）
 *  - upcoming：未来 90 天解禁（核心风险，区间 [date, date+90]）
 *  - reduce_holdings：近期已披露减持明细（无计划类/进度类数据，仅已发生明细）
 *  全部字段缺失 → undefined（拉取失败或无数据），risk prompt 据此省略整段。 */
export interface LockupData {
  pressure_rating: string;          // lockup.py 的压力评级
  upcoming: LockupItem[];           // 未来 90 天解禁
  reduce_holdings: ReduceHolding[]; // 近期减持
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
  kline: { pct_5d: number; pct_20d: number; support: number; resistance: number; volatility_20d: number; volume_ratio_5_20: number; last_close: number };
  /** 个股新闻（最多 5 条，含标题/正文摘要/时间）。
   *  旧实现是 string[]（只有标题），现升级为 NewsItem[] 让 LLM 判断时效性 + 标题党。 */
  news: NewsItem[];
  hot_money: HotMoneyData;
  fundamentals: { pe: number; pb: number; rev_q1: number; np_q1: number; industry: string; quarterly_trends?: QuarterlyTrend[]; consensus_eps?: ConsensusEps; pe_percentile?: number; pb_percentile?: number; capability_scores?: Record<string, { score: number; label: string }> };
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

const ANALYST_PROMPT_TEMPLATE = `# 角色
你是 A 股趋势跟随分析师，评估单只异动股的驱动逻辑强度与趋势健康度。

# 任务
基于以下数据，输出 thesis + fitness + 关键信号。核心问题：**这轮异动背后有没有真实、
可延续的驱动逻辑？趋势是否健康（量价配合、资金认可）？** 要求 thesis 含具体词
（产品/客户/数据/业务节点），禁止模糊词（共振/资金追捧/活跃/爆发力强）。

# 评分标准（fitness_score = 驱动逻辑强度 + 趋势验证，必须严格对齐，不要凭感觉）

| 分数 | 含义 | 典型特征 |
|------|------|---------|
| 9-10 | 顶级 | 驱动逻辑真实且强力（已落地订单/产能释放/政策直接受益）+ 有具体数据（订单金额/客户名/产能吨数）+ 趋势健康（量价配合、资金流入） |
| 7-8 | 好 | 驱动逻辑清晰，**且趋势正在验证中**（量价齐升/MACD金叉/资金流入/OBV上升/放量突破任一即可，不强制要求已落地订单）。订单在谈/产能在建/技术突破待量产也算 |
| 5-6 | 中 | 有可识别的驱动逻辑（蹭概念但有真实业务关联/逻辑链不完整），趋势有延续迹象但不强 |
| 3-4 | 弱 | 驱动逻辑极弱（纯资金轮动/无实质催化），趋势可能已透支 |
| ≤2 | 差 | 无实质逻辑（纯资金炒作/零信息），或 deal_breaker 灾难性风险 |

评分原则：
- fitness 评的是**驱动逻辑强度 + 趋势验证**，不是估值高低。A 股异动股 PE 普遍高，这是常态不是否决理由
- **趋势策略买的是动量延续**：趋势本身就是驱动的一部分。量价齐升/资金流入/MACD金叉等趋势确认信号
  可独立支撑 7-8 分（即使订单/产能未完全落地），只要驱动逻辑清晰、趋势在延续
- 有具体数据支撑（订单金额/产能吨数/客户名）可冲 9-10 分，但 7-8 分不要求必须有具体数据
- 趋势健康度是重要参考：量价齐升/MACD 金叉/OBV 上升/放量突破 → 趋势确认，可加分；
  缩量上涨/量价背离/MACD 死叉 → 趋势存疑，应在 thesis 标注并酌情压低 fitness
- 基本面是交叉参考（非评分主轴）：业绩连续增长 = 驱动逻辑有基本面支撑（加分）；
  业绩恶化/连亏 = 驱动逻辑可能证伪（压低 fitness 但不否决）
- 传闻/未经证实信息应在 data_gaps 标注，但仍可评分（趋势模式可做传闻驱动的动量）

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，支撑 {support} / 压力 {resistance}，量比 {volume_ratio}）
## 新闻（近 60 天个股相关 top，含时间与正文摘要）
{news_density}{news_bullets}
（注意时效：最近 1-2 天的突发新闻权重高于一月前的旧闻；标题党风险——标题与正文矛盾时以正文为准）
## 资金流向
{hot_money_summary}
## 基本面（PE {pe}{pe_label} / PB {pb}{pb_label} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）
## 季度业绩趋势（近 4 季度营收/净利/ROE + 同比，判断业绩是否支撑驱动逻辑）
{quarterly_trends}
{consensus_eps}
{capability_scores}
{vpa_text}
{macd_text}
{ranker_section}

# 输出格式（严格 JSON）
{
  "thesis": "...",
  "fitness_score": 0-10,
  "data_freshness": "YYYY-MM-DD",
  "key_signals": ["...", "..."],
  "data_gaps": ["..."]
}`;

/** 把 HotMoneyData 渲染成 prompt 里的一行紧凑资金面摘要。
 *
 *  范式对齐 newsDensity（news_layer_stats）：有则一行管道分隔，无则兜底标注。
 *  把全局子源压成一句：
 *  "北向 +2.3亿(inflow) | 龙虎榜近30天2次(最近+1.2亿) | 所在行业未在当日主线 | 今日热门:半导体/军工/锂电"
 *
 *  兜底：所有标量全 0 且无任何文本片段 → "(资金数据拉取失败或全空)"，
 *  让 LLM 知道资金面维度无数据（诚实标注缺失，不编造）。 */
function signPrefix(n: number): string {
  return n > 0 ? "+" : "";
}

export function renderHotMoneySummary(h: HotMoneyData): string {
  const parts: string[] = [];

  // 龙虎榜（游资/机构席位动向）+ 上榜原因（区分游资炒作 vs 业务驱动）
  // 个股级信号，有价值——但多数股票不上榜，"缺失"措辞有歧义（正常 vs 故障）
  if (h.dragon_tiger_recent) {
    const reason = h.dragon_tiger_reason ? `，原因:${h.dragon_tiger_reason}` : "";
    parts.push(`龙虎榜近30天:${h.dragon_tiger_recent}${reason}`);
  } else {
    parts.push(`龙虎榜近30天:未上榜`);
  }

  // 板块轮动（标的行业是否当日主线）—— 个股级信号，有价值
  if (h.sector_in_industry_tag) {
    const tag = h.sector_in_industry_tag === "主线" ? "所在行业在当日流入主线"
      : h.sector_in_industry_tag === "弱势" ? "所在行业在当日流出弱势区"
      : "所在行业未上当日板块榜";
    const inflow = h.sector_inflow_top ? `(流入top:${h.sector_inflow_top})` : "";
    const outflow = h.sector_outflow_top ? `(流出top:${h.sector_outflow_top})` : "";
    parts.push(`${tag}${inflow}${outflow}`);
  }

  // 注：北向资金和热门题材已移除——它们是市场级信号，已在 rebalancer macro_section 注入一次

  if (parts.length === 0) {
    return "(资金数据拉取失败或全空)";
  }
  return parts.join(" | ");
}

/** 把 4 季度财务趋势压成一行（对齐 renderHotMoneySummary 范式）。
 *
 *  格式：「营收 285/1200/880/560亿(同比+10.5/+8.2/+7.1/+6.0%) | 净利 32/130/95/60亿(同比...) | ROE 4.2/15.6/11.5/7.8%」
 *  - 按报告期降序（最近在前，对齐 fundamentals.py quarterly_trends 的排序）
 *  - 每段只在该段有数据时输出；缺同比 → 省略括号；无任何数据 → 空串（prompt 该行省略）
 *  - 负同比带负号（业绩下滑是风险信号，LLM 需识别）
 *  季度顺序由 fundamentals.py 的 sortColumns=REPORTDATE desc 保证，这里原样按数组顺序渲染。 */
export function renderQuarterlyTrends(trends?: QuarterlyTrend[]): string {
  if (!trends || trends.length === 0) return "";
  const sign = (n: number): string => n > 0 ? `+${n}` : `${n}`;
  // 营收段：有 revenue_yi 的季度才进；同比仅当该季度有 revenue_yoy 时拼
  const revVals: string[] = [];
  const revYoy: string[] = [];
  trends.forEach(t => {
    if (typeof t.revenue_yi === "number") revVals.push(`${t.revenue_yi}亿`);
    if (typeof t.revenue_yoy === "number") revYoy.push(`${sign(t.revenue_yoy)}%`);
  });
  const npVals: string[] = [];
  const npYoy: string[] = [];
  trends.forEach(t => {
    if (typeof t.net_profit_yi === "number") npVals.push(`${t.net_profit_yi}亿`);
    if (typeof t.net_profit_yoy === "number") npYoy.push(`${sign(t.net_profit_yoy)}%`);
  });
  const roeVals: string[] = trends
    .filter(t => typeof t.roe === "number")
    .map(t => `${t.roe}%`);

  const segs: string[] = [];
  if (revVals.length) {
    const yoy = revYoy.length ? `(同比${revYoy.join("/")})` : "";
    segs.push(`营收 ${revVals.join("/")}${yoy}`);
  }
  if (npVals.length) {
    const yoy = npYoy.length ? `(同比${npYoy.join("/")})` : "";
    segs.push(`净利 ${npVals.join("/")}${yoy}`);
  }
  if (roeVals.length) segs.push(`ROE ${roeVals.join("/")}`);
  return segs.join(" | ");
}

/** 把机构一致预期压成一行（对齐 renderHotMoneySummary 范式）。
 *
 *  格式：「26家覆盖 | EPS 45→52(+15.6%) | 目标价 1800-2000 | 评级 买18/增5/中性3 | 远期PE 34.6 | PEG 2.2」
 *  - 每段只在该字段有值时输出；无任何数据 → 空串（很多小盘股无机构覆盖，prompt 该行省略）
 *  - 负增速带负号（预期下滑是风险信号）
 *  - PEG 仅当脚本预计算给出时输出（fundamentals.py 仅正增长时算 PEG，故缺 PEG 不代表数据错）
 *  - 评级分布只列非零项，避免「买0/增0/中性0」噪音
 *  forward_pe/peg 由 fundamentals.py 预计算，LLM 只引用不算（避免算术错误）。 */
export function renderConsensus(c?: ConsensusEps): string {
  if (!c) return "";
  const sign = (n: number): string => n > 0 ? `+${n}` : `${n}`;
  const segs: string[] = [];

  if (typeof c.analyst_count === "number" && c.analyst_count > 0) {
    segs.push(`${c.analyst_count}家覆盖`);
  }
  // EPS 趋势：current → next，有增速则带括号
  if (typeof c.consensus_eps_current === "number" || typeof c.consensus_eps_next === "number") {
    const cur = typeof c.consensus_eps_current === "number" ? c.consensus_eps_current : "?";
    const nxt = typeof c.consensus_eps_next === "number" ? c.consensus_eps_next : "?";
    const growth = typeof c.eps_growth_pct === "number" ? `(${sign(c.eps_growth_pct)}%)` : "";
    segs.push(`EPS ${cur}→${nxt}${growth}`);
  }
  if (typeof c.target_price_min === "number" && typeof c.target_price_max === "number"
    && c.target_price_min > 0 && c.target_price_max > 0) {
    segs.push(`目标价 ${c.target_price_min}-${c.target_price_max}`);
  }
  if (c.ratings) {
    const r = c.ratings;
    const label: Array<[string, number | undefined]> = [
      ["买", r.buy], ["增", r.overweight], ["中性", r.neutral], ["减", r.underweight], ["卖", r.sell],
    ];
    const parts = label.filter(([, n]) => typeof n === "number" && n > 0)
      .map(([lab, n]) => `${lab}${n}`);
    if (parts.length) segs.push(`评级 ${parts.join("/")}`);
  }
  if (typeof c.forward_pe === "number" && c.forward_pe > 0) segs.push(`远期PE ${c.forward_pe}`);
  if (typeof c.peg === "number" && c.peg > 0) segs.push(`PEG ${c.peg}`);

  return segs.join(" | ");
}

/** 渲染同花顺 8 维能力评分为一行摘要。 */
function renderCapabilityScores(scores?: Record<string, { score: number; label: string }>): string {
  if (!scores || Object.keys(scores).length === 0) return "";
  const entries = Object.entries(scores)
    .filter(([, v]) => typeof v?.score === "number")
    .map(([k, v]) => `${v.label || k} ${v.score.toFixed(1)}`);
  return entries.join(" | ") || "";
}

/** 把解禁+减持压成一行（对齐 renderHotMoneySummary/renderQuarterlyTrends 范式）。
 *
 *  格式：「解禁压力：重大压力 | 未来90天2笔(最近 07-15 定增 0.4%；09-20 首发 1.2%) | 近期减持1笔(大股东 2.1%，个人资金需求)」
 *  - 压力评级（lockup.py pressure_rating，按 upcoming 数量给的档）
 *  - upcoming 取最近 3 笔（脚本已按日期升序），每笔：MM-DD 类型 ratio
 *  - reduce_holdings 取最近 2 笔（脚本按日期倒序），每笔：股东 ratio 原因
 *  每段只在该段有数据时输出；无 upcoming 且无减持 → 只输出压力评级行（让 LLM 知道无压力）。
 *  ratio 字段是字符串（如"0.4%"），原样透传让 LLM 读，避免 parse 失败丢信息。 */
export function renderLockup(l: LockupData): string {
  const segs: string[] = [];

  // 压力评级（lockup.py 按 upcoming 数量分档，重大压力 = ≥3 笔）
  segs.push(`解禁压力：${l.pressure_rating || "未知"}`);

  // 未来解禁：取前 3 笔（最近在前，upcoming 已按日期升序）
  if (l.upcoming && l.upcoming.length > 0) {
    const items = l.upcoming.slice(0, 3).map(it => {
      const d = it.date ? it.date.slice(5) : "?";   // MM-DD
      const t = it.type || "解禁";
      const r = it.ratio ? ` ${it.ratio}` : "";
      return `${d} ${t}${r}`;
    });
    segs.push(`未来90天${l.upcoming.length}笔(${items.join("；")})`);
  }

  // 近期减持：取前 2 笔（已按日期倒序）
  if (l.reduce_holdings && l.reduce_holdings.length > 0) {
    const items = l.reduce_holdings.slice(0, 2).map(rd => {
      const who = rd.reducing_shareholder ? rd.reducing_shareholder.slice(0, 8) : "股东";
      const r = rd.reducing_ratio ? ` ${rd.reducing_ratio}` : "";
      const reason = rd.reduce_reason ? `，${rd.reduce_reason.slice(0, 12)}` : "";
      return `${who}${r}${reason}`;
    });
    segs.push(`近期减持${l.reduce_holdings.length}笔(${items.join("；")})`);
  }

  return segs.join(" | ");
}

/** 渲染 MACD 动量信号为一行文本。无数据 → 空串（prompt 该行省略）。
 *  格式：「DIF=0.523 DEA=0.481 柱状图=0.042 多头｜金叉」
 *  让 LLM 识别动量方向 + 交叉信号（金叉=看多加速，死叉=看空加速）。 */
export function renderMacd(m?: MacdData): string {
  if (!m) return "";
  const parts = [`DIF=${m.dif}`, `DEA=${m.dea}`, `柱状图=${m.histogram}`];
  parts.push(m.direction);
  if (m.crossover === "golden") parts.push("金叉");
  else if (m.crossover === "death") parts.push("死叉");
  return parts.join(" | ");
}

/** 渲染 PE/PB 历史分位标注（如「[近5年15%分位]」），无数据 → 空串（向后兼容）。
 *  分位含义：0-100，表示当前值在近5年序列里的位置——低分位=相对便宜，高分位=相对贵。
 *  让 LLM 据此判断"PE=18 在该股历史上贵不贵"，治绝对值盲区。 */
export function renderPercentileLabel(percentile: number | undefined): string {
  if (typeof percentile !== "number" || !Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    return "";
  }
  return `[近5年${percentile}%分位]`;
}

/** 渲染 PE 值为 prompt 友好的文本，归一化无意义的负值/零值。
 *
 *  亏损股 PE = 市值/负净利 < 0，数学上无意义，投资语义 = "亏损"。
 *  裸注入 `-3033.67` 会让 LLM 误判为"天价 PE → 估值严重偏高"（实测误判）。
 *  归一化规则：
 *  - 负值（净利为负/亏损）→ "N/A（亏损）"，让 LLM 识别为亏损而非高估值
 *  - 0（未拉取到/字段缺失）→ "N/A"
 *  - 正常正值 → 保留 2 位小数
 *  注意：fundamentals.pe 保留原始数值不变，此函数只影响 prompt 文本呈现。 */
export function renderPe(pe: number): string {
  if (typeof pe !== "number" || !Number.isFinite(pe) || pe === 0) return "N/A";
  if (pe < 0) return "N/A（亏损）";
  return pe.toFixed(2);
}

export function formatAnalystPrompt(d: StockData): string {
  const newsBullets = d.news.map(n => {
    const time = n.time ? `[${n.time}] ` : "";
    const content = n.content ? `：${n.content}` : "";
    return `- ${time}${n.title}${content}`;
  }).join("\n") || "- (无)";
  // 新闻密度统计：news.py layer_stats 的一行渲染。无统计 → 空串（该行省略）。
  // 让 LLM 判断热门/冷门（total 低=流动性风险）+ 有无突发（realtime_6h>0=提权重）。
  const newsDensity = d.news_layer_stats
    ? `新闻密度：6h 内 ${d.news_layer_stats.realtime_6h_count} 条突发 / 24h 内 ${d.news_layer_stats.extended_24h_count} 条 / 7 天共 ${d.news_layer_stats.total_categorized} 条\n`
    : "";
  // 趋势模式：ranker 的动量判断是有价值的输入（异动筛选+趋势排序的结论），
  // 不再刻意去锚定——它是驱动逻辑判断的重要参考之一。
  const rankerSection = d.ranker_thesis
    ? `## ranker 动量判断（来自异动筛选，是你的重要输入之一）\n${d.ranker_thesis}\n（以上是 ranker 基于雪球异动+趋势排序的判断，反映了市场对这只股的动量共识。请结合你的驱动逻辑分析交叉验证：若你的逻辑判断与 ranker 方向一致，可增强信心；若矛盾，需说明分歧理由。）`
    : "";
  return ANALYST_PROMPT_TEMPLATE
    .replace("{ticker}", d.ticker)
    .replace("{name}", d.name)
    .replace("{sector}", d.sector)
    .replace("{pct_5d}", d.kline.pct_5d.toFixed(2))
    .replace("{pct_20d}", d.kline.pct_20d.toFixed(2))
    .replace("{support}", d.kline.support.toFixed(2))
    .replace("{resistance}", d.kline.resistance.toFixed(2))
    .replace("{volume_ratio}", d.kline.volume_ratio_5_20.toFixed(2))
    .replace("{news_density}", newsDensity)
    .replace("{news_bullets}", newsBullets)
    .replace("{hot_money_summary}", renderHotMoneySummary(d.hot_money))
    .replace("{pe}", renderPe(d.fundamentals.pe))
    // 亏损股（PE<0）无分位意义，省略标注；正常股才显示历史分位
    .replace("{pe_label}", d.fundamentals.pe < 0 ? "" : renderPercentileLabel(d.fundamentals.pe_percentile))
    .replace("{pb}", String(d.fundamentals.pb))
    .replace("{pb_label}", renderPercentileLabel(d.fundamentals.pb_percentile))
    .replace("{rev_q1}", d.fundamentals.rev_q1 > 0 ? `${(d.fundamentals.rev_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.rev_q1))
    .replace("{np_q1}", d.fundamentals.np_q1 > 0 ? `${(d.fundamentals.np_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.np_q1))
    // 季度趋势：恒定标题（始终有意义）；机构预期/能力评分：有数据才拼标题，无数据 → 空串省略整块（不留空标题占注意力）
    .replace("{quarterly_trends}", renderQuarterlyTrends(d.fundamentals.quarterly_trends) || "(无季度趋势数据)")
    .replace("{consensus_eps}", (() => {
      const r = renderConsensus(d.fundamentals.consensus_eps);
      return r ? `## 机构一致预期（卖方覆盖数 / EPS 预期 / 目标价 / 评级）\n${r}` : "";
    })())
    .replace("{capability_scores}", (() => {
      const r = renderCapabilityScores(d.fundamentals.capability_scores);
      return r ? `## 同花顺能力评分（8维度，0-10分，仅作参考）\n${r}` : "";
    })())
    // 趋势模式：VPA/MACD 注入 analyst prompt（评驱动逻辑强度需看趋势健康度）
    // vpa_text 自带标题，缺数据 → 空串省略整块（与 formatRiskPrompt 同逻辑）
    .replace("{vpa_text}", d.vpa_text || "")
    .replace("{macd_text}", d.macd ? `## MACD 动量信号\n${renderMacd(d.macd)}` : "")
    .replace("{ranker_section}", rankerSection);
}

/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
export function parseAnalystReport(content: string): AnalystReport | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  return {
    thesis: typeof o.thesis === "string" ? o.thesis : "",
    fitness_score: typeof o.fitness_score === "number" ? o.fitness_score : 0,
    data_freshness: typeof o.data_freshness === "string" ? o.data_freshness : "",
    key_signals: Array.isArray(o.key_signals) ? (o.key_signals as string[]).filter(s => typeof s === "string") : [],
    data_gaps: Array.isArray(o.data_gaps) ? (o.data_gaps as string[]).filter(s => typeof s === "string") : [],
  };
}

/** 从 LLM 输出抽 JSON（先 ```json 代码块，再找平衡花括号）。 */
function extractJson(content: string): unknown | null {
  if (!content) return null;
  const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }
  const start = content.indexOf("{");
  if (start === -1) return null;
  let depth = 0, endIdx = -1, inStr = false, escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  try { return JSON.parse(content.slice(start, endIdx + 1)); } catch { return null; }
}

const RISK_PROMPT_TEMPLATE = `# 角色
你是 A 股趋势策略风险分析师，识别单只股票的退出信号与硬风险。

# 任务
基于以下数据 + analyst 给的 thesis，输出风险清单。趋势模式下你的核心职责是**识别退出信号**
（技术位破位）和**硬风险**（造假/退市/解禁），不是评估估值高低。

## ⚠️ 退出信号识别规则（趋势策略的核心刹车）
趋势策略的退出靠技术位，不靠估值。若以下任一成立，必须输出对应 risk_flag 且 overall_risk=high：
- **MACD 死叉**（crossover=death）→ 趋势可能反转，应输出"MACD死叉"flag，overall_risk=high
- VPA 数据出现"价量背离"（价格上涨但成交量显著递减，>10%）→ 见顶信号，overall_risk=high
- VPA 数据出现"缩量下跌"（价格下跌且成交量递减）→ 流动性枯竭，overall_risk=high
- 5 日涨幅较大（>10%）但量比 volume_ratio_5_20 < 0.8（缩量上涨，资金不认可）→ overall_risk=high
- **跌破支撑位**（最新收盘价 < 支撑位）→ 技术破位，overall_risk=high

这些是趋势策略的退出依据。出现退出信号不代表公司不好，只代表趋势可能结束——该止盈/止损了。

## 解禁与减持识别规则（供给端硬风险）
若以下任一成立，应输出对应 risk_flag 并提升 overall_risk（重大解禁→high）：
- 解禁压力评级为"重大压力"（未来 90 天 ≥3 笔解禁）
- 未来 90 天有单笔解禁比例 ≥5%（流通市值，供给冲击大）
- 近期有大股东减持记录（减持动力强，后续可能持续减持）
这些是供给端压力，与公司好坏无关——业绩再好，解禁抛压也是风险。

## 注意：估值高不是风险
A 股异动股 PE 普遍处于 90%+ 分位，这是趋势行情的常态，**不要因 PE 高就提升 risk**。
估值泡沫仅在业绩连续恶化 + 估值极端（PE 分位 99%+ 且净利下滑）同时出现时才作为辅助 risk_flag。

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，支撑 {support} / 压力 {resistance}，量比 {volume_ratio_5_20}）
- 量比 < 0.8 = 缩量；> 1.2 = 放量；0.8-1.2 = 正常
- 跌破支撑 = 技术破位退出信号；突破压力 = 趋势延续确认
## 资金流向
{hot_money_summary}
## 基本面（PE {pe}{pe_label} / PB {pb}{pb_label} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）
## 季度业绩趋势（营收/净利同比连续下滑 = 业绩拐点，辅助判断驱动逻辑是否证伪）
{quarterly_trends}

{vpa_text}

{macd_text}

## 解禁与减持（未来 90 天解禁 + 近期减持；未来大额解禁或减持 = 供给压力）
{lockup_summary}

# Analyst thesis
{analyst_thesis}

# 输出格式（严格 JSON）
{
  "risk_flags": [
    { "flag": "...", "severity": "低|中|高", "detail": "..." }
  ],
  "overall_risk": "low|medium|high",
  "deal_breaker": false
}

deal_breaker=true 仅限：财务造假、退市风险、重大违规、产品/客户重大断裂等灾难性情况。
退出信号（MACD死叉/量价背离/跌破支撑）用 overall_risk=high 表达，不要用 deal_breaker。`;

export function formatRiskPrompt(d: StockData, analyst: AnalystReport): string {
  return RISK_PROMPT_TEMPLATE
    .replace("{ticker}", d.ticker)
    .replace("{name}", d.name)
    .replace("{sector}", d.sector)
    .replace("{pct_5d}", d.kline.pct_5d.toFixed(2))
    .replace("{pct_20d}", d.kline.pct_20d.toFixed(2))
    .replace("{support}", d.kline.support.toFixed(2))
    .replace("{resistance}", d.kline.resistance.toFixed(2))
    .replace("{volume_ratio_5_20}", d.kline.volume_ratio_5_20.toFixed(2))
    .replace("{hot_money_summary}", renderHotMoneySummary(d.hot_money))
    .replace("{pe}", renderPe(d.fundamentals.pe))
    .replace("{pe_label}", d.fundamentals.pe < 0 ? "" : renderPercentileLabel(d.fundamentals.pe_percentile))
    .replace("{pb}", String(d.fundamentals.pb))
    .replace("{pb_label}", renderPercentileLabel(d.fundamentals.pb_percentile))
    .replace("{rev_q1}", d.fundamentals.rev_q1 > 0 ? `${(d.fundamentals.rev_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.rev_q1))
    .replace("{np_q1}", d.fundamentals.np_q1 > 0 ? `${(d.fundamentals.np_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.np_q1))
    .replace("{quarterly_trends}", renderQuarterlyTrends(d.fundamentals.quarterly_trends) || "(无季度趋势数据)")
    // vpa_text 自带标题（## VPA 量价预计算指标），缺数据 → 空串省略整块（不留空标题）
    .replace("{vpa_text}", d.vpa_text || "")
    // MACD：有数据才拼标题，无数据 → 空串省略整块
    .replace("{macd_text}", d.macd ? `## MACD 动量信号\n${renderMacd(d.macd)}` : "")
    .replace("{lockup_summary}", d.lockup ? renderLockup(d.lockup) : "(无解禁数据)")
    .replace("{analyst_thesis}", `${analyst.thesis}（fitness ${analyst.fitness_score}）`);
}

export function parseRiskReport(content: string): RiskReport | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const flags = Array.isArray(o.risk_flags) ? (o.risk_flags as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(x => ({
      flag: typeof x.flag === "string" ? x.flag : "",
      severity: (["低", "中", "高"].includes(x.severity as string) ? x.severity : "低") as "低" | "中" | "高",
      detail: typeof x.detail === "string" ? x.detail : "",
    })) : [];
  const risk = ["low", "medium", "high"].includes(o.overall_risk as string) ? o.overall_risk as "low" | "medium" | "high" : "low";
  return {
    risk_flags: flags,
    overall_risk: risk,
    deal_breaker: o.deal_breaker === true,
  };
}

/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。
 *
 *  qualityNotes（可选）：确定性质量门控 applyQualityGate 的产物。传入则落
 *  StockReport.quality_notes，便于复盘"为什么这只股 fitness 从 8 变 6"。
 *  空数组或 undefined → 不写该字段（保持 plan.json 简洁）。 */
export function buildStockReport(
  meta: CandidateMeta,
  sector: string,
  analyst: AnalystReport,
  risk: RiskReport,
  qualityNotes?: string[],
): StockReport {
  const report: StockReport = {
    ticker: meta.ticker,
    name: meta.name,
    sector,
    thesis: analyst.thesis,
    fitness_score: analyst.fitness_score,
    key_signals: analyst.key_signals,
    data_gaps: analyst.data_gaps,
    risk_flags: risk.risk_flags,
    overall_risk: risk.overall_risk,
    deal_breaker: risk.deal_breaker,
    is_held: meta.is_held,
    current_weight: meta.current_weight,
    days_held: meta.days_held,
    locked: meta.locked,
    ranker_score: meta.ranker_score,
  };
  if (qualityNotes && qualityNotes.length > 0) {
    report.quality_notes = qualityNotes;
  }
  return report;
}

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
export function buildFallbackReport(
  meta: CandidateMeta,
  sector: string,
  reason: string,
): StockReport {
  return {
    ticker: meta.ticker,
    name: meta.name,
    sector,
    thesis: `⚠️ shallow-analyzer 失败，无法评估（${reason}）`,
    fitness_score: 5,
    key_signals: [],
    data_gaps: [`shallow-analyzer 失败：${reason}`],
    risk_flags: [{ flag: "分析失败", severity: "高", detail: reason }],
    overall_risk: "high",
    deal_breaker: false,
    is_held: meta.is_held,
    current_weight: meta.current_weight,
    days_held: meta.days_held,
    locked: meta.locked,
    ranker_score: meta.ranker_score,
  };
}

/** 对所有候选/持仓股跑 analyst + risk 双 call（单股内串行，跨股并发限制）。
 *
 *  失败处理（风控关键）：
 *  - 候选股失败 → 跳过（少一个机会，无伤大雅）
 *  - 持仓股失败 → 保守默认 report（fitness=5, risk=high），不消失
 *    否则 rebalancer 看不到它，一个可能需要止损的持仓股被静默忽略
 *
 *  concurrency 默认 3 —— zhipu glm-5.1 free tier 在并发 ≥5 时触发 429。
 *  跨股 worker pool + 单股内 analyst→risk 串行 = 任意时刻最多 concurrency 个 LLM call。 */
export async function analyzeAll(
  metas: CandidateMeta[],
  dataByTicker: Map<string, StockData>,
  caller: ShallowLlmCaller,
  concurrency: number = 3,
): Promise<StockReport[]> {
  const queue = [...metas];
  const results: Array<StockReport | null> = [];
  const workers: Promise<void>[] = [];
  let done = 0;
  const total = metas.length;
  const t0 = Date.now();
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const meta = queue.shift()!;
        const data = dataByTicker.get(meta.ticker);
        if (!data) {
          // 持仓股无数据 → fallback（候选股跳过）
          results.push(meta.is_held ? buildFallbackReport(meta, "未分类", "数据拉取失败（dataByTicker 无此股）") : null);
          done++;
          console.error(`  [llm] ${done}/${total} ${meta.name} 跳过（无数据，累计 ${(Date.now() - t0) / 1000 | 0}s）`);
          continue;
        }
        const stockT0 = Date.now();
        try {
          const analystContent = await caller({ role: "analyst", data });
          const analyst = parseAnalystReport(analystContent);
          if (!analyst) {
            results.push(meta.is_held ? buildFallbackReport(meta, data.sector, "analyst-role 返回非 JSON") : null);
            done++;
            console.error(`  [llm] ${done}/${total} ${meta.name} ✗ analyst 非 JSON（${(Date.now() - stockT0) / 1000 | 0}s）`);
            continue;
          }
          const riskContent = await caller({ role: "risk", data, analyst });
          const risk = parseRiskReport(riskContent);
          if (!risk) {
            results.push(meta.is_held ? buildFallbackReport(meta, data.sector, "risk-role 返回非 JSON") : null);
            done++;
            console.error(`  [llm] ${done}/${total} ${meta.name} ✗ risk 非 JSON（${(Date.now() - stockT0) / 1000 | 0}s）`);
            continue;
          }
          // 确定性质量门控（内联守卫，非新阶段）：钳制 fitness/risk + 标注 issue（含解禁兜底）。
          // 必须在 buildStockReport 前，让 clamp 后的值进 position-calculator 公式。
          const gated = applyQualityGate(analyst, risk, data);
          results.push(buildStockReport(meta, data.sector, gated.analyst, gated.risk, gated.issues));
          done++;
          console.error(`  [llm] ${done}/${total} ${meta.name} ✓ fitness ${gated.analyst.fitness_score}（${(Date.now() - stockT0) / 1000 | 0}s）`);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          results.push(meta.is_held ? buildFallbackReport(meta, data.sector, `LLM 调用异常：${reason}`) : null);
          done++;
          console.error(`  [llm] ${done}/${total} ${meta.name} ✗ 异常：${reason.slice(0, 40)}`);
        }
      }
    })());
  }
  await Promise.all(workers);
  return results.filter((r): r is StockReport => r !== null);
}
