"use strict";
// src/watchlist/ranker.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterCommon = filterCommon;
exports.filterShortExtra = filterShortExtra;
exports.formatLongEntry = formatLongEntry;
exports.formatShortEntry = formatShortEntry;
exports.parseRankResponse = parseRankResponse;
exports.fallbackRank = fallbackRank;
exports.computeDistribution = computeDistribution;
exports.classifyTodayCatalyst = classifyTodayCatalyst;
exports.computeBreakdown = computeBreakdown;
exports.enrichRanked = enrichRanked;
exports.rankCandidates = rankCandidates;
exports.mergeScan = mergeScan;
// ── 过滤规则 ───────────────────────────────────────────────────────────────
/** 共同过滤：ST/退 + 科创板 SH688（用户无交易权限）。
 *  正则避免误伤名字含 ST 字样的正常股（如 BEST...）。 */
function filterCommon(c) {
    if (/(^|[*\s])ST|^退|退$/.test(c.name))
        return false;
    if (c.ticker.startsWith("SH688"))
        return false;
    return true;
}
/** SHORT 专有过滤：continued 一律留；new 必须今日有异动。
 *  diff.ts 要求 ongoing range.end === todayStartMs 才入选，故今日事件 =
 *  range_events 中 timestamp === range.end 的子集。
 *
 *  防御性：老 candidates.json（range_events 字段引入前）没有该字段，
 *  视为空事件链 → 等价于"new + 无今日异动"被丢弃。 */
function filterShortExtra(c) {
    if (c.range_kind === "continued")
        return true;
    const events = c.range_events ?? [];
    if (events.some((r) => r.timestamp === c.range.end))
        return true;
    return false;
}
// ── 格式 B 输入构造 ─────────────────────────────────────────────────────────
function pctStr(p) {
    return (p > 0 ? "+" : "") + p + "%";
}
function kindZh(k) {
    return k === "continued" ? "延续型" : "新成型";
}
/** 把毫秒时间戳渲染成 YYYY-MM-DD（北京时区）。 */
function fmtDate(ms) {
    const d = new Date(ms + 8 * 60 * 60 * 1000); // 强制 +08:00
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
}
/** range_events 渲染成事件链：[日期] description (reason) → ... */
function formatEventChain(events) {
    if (!events || events.length === 0)
        return "(无)";
    return events
        .map((ev) => {
        const head = `[${fmtDate(ev.timestamp)}] ${ev.description ?? ""}`;
        return ev.reason ? `${head} (${ev.reason})` : head;
    })
        .join(" → ");
}
/** range_events 过滤今日（timestamp === range.end）后渲染 */
function formatTodayEvents(c) {
    const events = c.range_events ?? [];
    const today = events.filter((r) => r.timestamp === c.range.end);
    if (today.length === 0)
        return "(无)";
    return today
        .map((ev) => {
        const head = ev.description ?? "";
        return ev.reason ? `${head} (${ev.reason})` : head;
    })
        .join("; ");
}
/** LONG 单股格式 B：5 段（含区间事件链，让 LLM 看趋势演化） */
function formatLongEntry(c, idx) {
    return [
        `### ${idx + 1}. ${c.ticker} ${c.name}`,
        `- 区间: ${pctStr(c.range.percent)} (${c.days}天, ${kindZh(c.range_kind)})`,
        `- 摘要: ${c.range.summary}`,
        `- 驱动要点: ${c.range.points}`,
        `- 区间事件链: ${formatEventChain(c.range_events)}`,
    ].join("\n");
}
/** SHORT 单股格式 B：4 段 + 今日（SHORT 区间短，事件链多为空，不加） */
function formatShortEntry(c, idx) {
    return [
        `### ${idx + 1}. ${c.ticker} ${c.name}`,
        `- 区间: ${pctStr(c.range.percent)} (${c.days}天, ${kindZh(c.range_kind)})`,
        `- 摘要: ${c.range.summary}`,
        `- 驱动要点: ${c.range.points}`,
        `- 今日: ${formatTodayEvents(c)}`,
    ].join("\n");
}
/** 从 LLM 输出中抽 JSON。先 ```json 代码块，再找平衡花括号。失败返回 null。 */
function extractJsonObject(content) {
    if (!content)
        return null;
    // 1. ```json ... ``` 或 ``` ... ``` 代码块
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
        try {
            return JSON.parse(codeBlock[1].trim());
        }
        catch {
            /* fall through */
        }
    }
    // 2. 第一个平衡的 {...}
    const start = content.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0;
    let endIdx = -1;
    let inStr = false;
    let escape = false;
    for (let i = start; i < content.length; i++) {
        const ch = content[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\") {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr)
            continue;
        if (ch === "{")
            depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                endIdx = i;
                break;
            }
        }
    }
    if (endIdx === -1)
        return null;
    try {
        return JSON.parse(content.slice(start, endIdx + 1));
    }
    catch {
        return null;
    }
}
/** 解析 LLM 排名输出：校验结构 + 过滤幻觉 ticker。失败返回 null。 */
function parseRankResponse(content, validTickers) {
    const obj = extractJsonObject(content);
    if (!obj || typeof obj !== "object")
        return null;
    const o = obj;
    if (!Array.isArray(o.ranked) || !Array.isArray(o.excluded))
        return null;
    const cleanRanked = o.ranked
        .filter((x) => !!x && typeof x === "object" && typeof x.ticker === "string" && validTickers.has(x.ticker))
        .map((x) => ({
        ticker: x.ticker,
        name: typeof x.name === "string" ? x.name : "",
        score: typeof x.score === "number" ? x.score : 0,
        reason: typeof x.reason === "string" ? x.reason : "",
    }));
    const cleanExcluded = o.excluded
        .filter((x) => !!x && typeof x === "object" && typeof x.ticker === "string" && validTickers.has(x.ticker))
        .map((x) => ({
        ticker: x.ticker,
        name: typeof x.name === "string" ? x.name : "",
        reason: typeof x.reason === "string" ? x.reason : "",
    }));
    return { ranked: cleanRanked, excluded: cleanExcluded };
}
// ── 规则降级 ────────────────────────────────────────────────────────────────
/** 规则降级：LONG 按 days/percent 排，SHORT 按 percent/days 排。
 *  分数 6.0 起步 -0.2 递减，最低 4.0（明显低于 LLM 区，一眼可识别）。 */
function fallbackRank(pool, topN, group) {
    const sorted = [...pool].sort((a, b) => {
        if (group === "LONG") {
            return b.days - a.days || Math.abs(b.range.percent) - Math.abs(a.range.percent);
        }
        return Math.abs(b.range.percent) - Math.abs(a.range.percent) || b.days - a.days;
    });
    const ranked = sorted.slice(0, topN).map((c, i) => ({
        ticker: c.ticker,
        name: c.name,
        score: Math.max(4.0, 6.0 - i * 0.2),
        percent: c.range.percent,
        days: c.days,
        range_kind: c.range_kind,
        reason: `[规则降级] 按 ${group === "LONG" ? "days/percent" : "percent/days"} 排序第 ${i + 1} 名`,
    }));
    const rankedSet = new Set(ranked.map((r) => r.ticker));
    const excluded = sorted
        .filter((c) => !rankedSet.has(c.ticker))
        .map((c) => ({
        ticker: c.ticker,
        name: c.name,
        reason: "[规则降级] 排名未进 topN",
    }));
    return { ranked, excluded };
}
// ── 分布统计（事后复盘用） ──────────────────────────────────────────────────
/** 算一组数字的分位（min/p25/median/p75/max），用线性插值。
 *  空数组返回 null。导出便于测试。 */
function computeDistribution(values) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p) => {
        const idx = (sorted.length - 1) * p;
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        if (lo === hi)
            return sorted[lo];
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    };
    return {
        min: sorted[0],
        p25: q(0.25),
        median: q(0.5),
        p75: q(0.75),
        max: sorted[sorted.length - 1],
    };
}
/** 算 pool 的 percent + days 分布。pool 为空返回 null。 */
function computePoolDistribution(pool) {
    if (pool.length === 0)
        return null;
    const percent = computeDistribution(pool.map((c) => c.range.percent));
    const days = computeDistribution(pool.map((c) => c.days));
    if (!percent || !days)
        return null;
    return { percent, days };
}
// ── 分类计数（事后复盘用） ──────────────────────────────────────────────────
/** 单股的今日催化强度分类。
 *  - limit_up: 今日涨停（description 含"涨停"，或涨幅 ≥ 板涨停阈值：
 *    创业板 SZ300/SZ301 / 科创板 SH688 阈值 19.5%；其他 9.5%）
 *  - pct_over_5: 今日涨幅 >5%（但未达涨停）
 *  - pct_under_5: 今日有事件但提取不出 >5% 涨幅
 *  - none: 今日无事件（range_events 中无 timestamp === range.end 的事件）
 *
 *  导出便于测试。 */
function classifyTodayCatalyst(c) {
    const today = (c.range_events ?? []).filter((r) => r.timestamp === c.range.end);
    if (today.length === 0)
        return "none";
    // 板涨停阈值：创业板/科创板 20% 板（雪球描述常写"涨幅20.00%"而非"涨停"）
    const is20PctBoard = /^(SZ30[01]|SH688)/.test(c.ticker);
    const limitThreshold = is20PctBoard ? 19.5 : 9.5;
    let hasLimitUp = false;
    let maxPct = null;
    for (const ev of today) {
        const desc = ev.description ?? "";
        if (desc.includes("涨停")) {
            hasLimitUp = true;
            break;
        }
        const m = desc.match(/涨幅\s*([0-9]+(?:\.[0-9]+)?)%/);
        if (m) {
            const p = parseFloat(m[1]);
            if (maxPct === null || p > maxPct)
                maxPct = p;
        }
    }
    if (hasLimitUp)
        return "limit_up";
    if (maxPct !== null && maxPct >= limitThreshold)
        return "limit_up";
    if (maxPct !== null && maxPct > 5)
        return "pct_over_5";
    return "pct_under_5";
}
/** 算 pool 的 range_kind + today_catalyst 计数。pool 为空返回 null。 */
function computeBreakdown(pool) {
    if (pool.length === 0)
        return null;
    const rk = { continued: 0, new: 0 };
    const tc = { limit_up: 0, pct_over_5: 0, pct_under_5: 0, none: 0 };
    for (const c of pool) {
        rk[c.range_kind]++;
        tc[classifyTodayCatalyst(c)]++;
    }
    return { range_kind: rk, today_catalyst: tc };
}
// ── 字段补齐 ────────────────────────────────────────────────────────────────
/** LLM 返回的 ticker/name/score/reason + 候选股反查 → 补 percent/days/range_kind。 */
function enrichRanked(llmRanked, lookup) {
    return llmRanked.map((r) => {
        const c = lookup.get(r.ticker);
        if (!c) {
            // 不应发生（parseRankResponse 已过滤幻觉），防御性兜底
            return {
                ticker: r.ticker,
                name: r.name,
                score: r.score,
                percent: 0,
                days: 0,
                range_kind: "new",
                reason: r.reason,
            };
        }
        return {
            ticker: r.ticker,
            // 用候选池的权威 name 覆盖 LLM 输出 —— LLM 偶尔会把另一只股票的名称/理由
            // 串到真实存在的 ticker 上（如把"大元泵业"的液冷泵理由挂到 SH603259，而
            // 603259 实为药明康德）。parseRankResponse 只校验 ticker 真实性，无法发现
            // 这类 ticker-name 错配；候选池的 name 来自 candidates（雪球原始数据），
            // 是权威来源，用它覆盖可阻断串号向下游 rebalance 传播。
            name: c.name,
            score: r.score,
            percent: c.range.percent,
            days: c.days,
            range_kind: c.range_kind,
            reason: r.reason,
        };
    });
}
// ── Prompts ────────────────────────────────────────────────────────────────
const LONG_PROMPT = `# 角色
你是一位专注 A 股趋势投资的分析师。

# 背景
以下是从雪球异动榜筛选出的长区间异动股票（区间跨度 >10 个交易日，共 {N} 支）。
这些股票已经形成明确趋势，请按投资价值排序，选出 top-{topN}。

# 评估维度

## 1. 趋势健康度（权重最高）
- **天数**：40-70 天最佳（趋势确立但未过久）；>70 天需警惕见顶；<30 天趋势可能不稳
- **涨幅**：50-150% 有空间；150-300% 需要更强驱动支撑；>300% 见顶风险大
- **类型**：延续型 > 新成型，延续说明趋势已确立且被市场认可

## 2. 驱动逻辑（决定趋势能否持续）
- **强驱动**：政策落地、业绩兑现、行业拐点、供需格局变化
- **弱驱动**：资金推动、市场情绪、概念炒作
- **板块共振**：若候选列表中有多只股票属于相同行业或概念板块（可通过摘要或驱动要点识别如"光模块"、"PCB"、"覆铜板"等），应予以适当加分，因为共振代表资金合力更强。
- 判断依据：摘要的具体性 + 驱动要点"个股驱动"段的实质内容（具体产品/订单/客户/产能/涨价 > 模糊概念如"国产替代"、"AI算力"堆砌）。雪球 points 是"个股驱动 / 行业驱动 / 市场驱动"三段分点驱动原因，不是日期事件链。

## 3. 见顶风险（必须排除）
- 涨幅 >300% 且天数 >70：大概率见顶
- 摘要中出现"见顶"、"回调"、"获利了结"等字眼
- 今日无异动 + 涨幅已大 + 天数长：趋势可能衰竭

## 4. 催化剂（可选加分项，最多 +0.5；不扣分）
- 今日有涨停：+0.5
- 今日涨幅 >5%：+0.3
- 今日无：0（**中性，不扣分**）

**关键**：LONG 延续型常态是间歇异动，今日空不代表趋势弱。趋势本身的健康度
（维度 1-3）和事件链整体演化（维度 5）才是主要评分依据。

## 5. 区间事件链演化（关键维度，看趋势是加速 / 见顶 / 衰竭）
- 事件密度递增 + 涨幅递增：加速阶段，分数向上
- 整个区间事件密度递减（如月初每周 2 条、月末每周 0 条）：衰竭，扣分
- 事件链末端连续跌停/跌幅放大 + 出现"机构抛售"/"股东减持"/"高管辞职"等风险事件：见顶信号，大幅扣分
- 事件链跨多周持续（如 5 个以上事件，分布均匀）：趋势确立，加分

注：本维度看**整个区间**的事件密度演化，不是看"今天是否有事件"
（那是维度 4 催化剂的事，今日无事件不扣分）。

# 排除标准
- 涨幅 >400%（几乎确定见顶）
- 天数 >70 且涨幅 >250% 且 今日无异动

# 强制分布约束（必须遵守，违反则结果作废）
- top-1 必须 ≥ 9.3
- 最后一名（top-{topN}）必须 ≤ 7.5
- 任意相邻两支分差 ≥ 0.2
- 禁止两支同分
- 跨度（max - min）必须 ≥ 2.0

打分本质是**排序**，不是绝对评价。如果所有股都 9 分+，下游拿到 N 个并列第一，
排序就失效了。请敢于给低分——top-N 不该高于 7.5，不喜欢的股不要犹豫给 5-6。

# reason 写作规则（严格）
reason 必须包含至少 1 个**具体名词**，且具体名词必须从该股输入的摘要/驱动要点/事件链里抽取，不能编造。

具体词候选（白名单示例）：
- 产品/技术（如"T7 锡膏"、"TLVR 电感"、"ABF 膜"、"PPE 树脂"、"HVLP 铜箔"）
- 客户/合作方（如"英伟达"、"SK 海力士"、"华为昇腾"）
- 量化数据（如"涨价10.21%"、"订单排至27年"、"净利+159%"）
- 业务节点（如"送样验证"、"获单"、"扩产"、"认证通过"）

禁止模糊词（黑名单，用了就算违规）：
- 共振 / 协同效应（除非点名具体两个板块如何联动）
- 资金追捧 / 资金涌入 / 资金极度认可 / 资金抢筹 / 资金合力
- 情绪高涨 / 市场情绪 / 信心提振
- 活跃 / 热点 / 概念走强 / 板块走强
- 爆发力强 / 强势确立（除非给量化数据支撑）

反例（违规）："板块共振强烈，资金追捧，爆发力强。"
正例（合规）："TLVR 电感获英伟达认证，一季度订单排至 27 年。"

# 输出格式（严格 JSON，不要 markdown 代码块外的额外说明）
{
  "ranked": [
    { "ticker": "...", "name": "...", "score": 9.0, "reason": "一句评价" }
  ],
  "excluded": [
    { "ticker": "...", "name": "...", "reason": "排除理由" }
  ],
  "summary": "共评估{N}支，排除{M}支，精选{topN}支"
}

# 候选列表
`;
const SHORT_PROMPT = `# 角色
你是一位专注 A 股短线机会捕捉的分析师。

# 背景
以下是从雪球异动榜筛选出的短区间异动股票（区间跨度 ≤10 个交易日，共 {N} 支）。
这些股票刚出现异动信号，请按投资价值排序，选出 top-{topN}。

# 评估维度

## 1. 信号强度（权重最高）
- **涨幅**：>20% 信号强；10-20% 中等；<10% 信号弱
- **天数**：7-10 天为佳（有持续性，不是一日游）；<5 天太短，可能只是脉冲
- **类型**：延续型 > 新成型，延续说明不是首次异动，趋势有惯性

## 2. 催化剂（决定短期爆发力）
- **今日涨停**：最强信号，资金认可度高
- **今日涨幅 >5%**：中等信号，当前仍在活跃期
- **今日无异动**：弱信号，可能已经启动完毕
- 判断依据：今日异动的具体描述

## 3. 驱动逻辑（决定持续性）
- **强驱动**：行业涨价、订单超预期、政策催化、业绩预增
- **弱驱动**：纯资金推动、市场情绪、无实质内容
- **板块共振**：若候选列表中有多只股票属于相同行业或概念板块（可通过摘要或驱动要点识别如"光模块"、"PCB"、"覆铜板"等），应予以适当加分，因为共振代表资金合力更强。
- 判断依据：摘要的具体性 + 驱动要点"个股驱动"段的实质内容（具体产品/订单/客户/产能/涨价 > 模糊概念堆砌）。雪球 points 是三段分点驱动原因，不是日期事件链。

## 4. 风险识别
- 涨幅 >80% 但天数 <7：可能是情绪炒作，风险高
- 摘要中只有"资金推动"、"游资介入"：持续性存疑
- 新成型 且 今日无异动：可能是首次异动后的衰竭

# 排除标准
- 涨幅 >80%（实测 SHORT max=83%，边缘见顶风险）
- 摘要只说"资金推动"/"游资介入"无实质内容（持续性存疑）

# 强制分布约束（必须遵守，违反则结果作废）
- top-1 必须 ≥ 9.3
- 最后一名（top-{topN}）必须 ≤ 7.5
- 任意相邻两支分差 ≥ 0.2
- 禁止两支同分
- 跨度（max - min）必须 ≥ 2.0

打分本质是**排序**，不是绝对评价。如果所有股都 9 分+，下游拿到 N 个并列第一，
排序就失效了。请敢于给低分——top-N 不该高于 7.5，不喜欢的股不要犹豫给 5-6。

# reason 写作规则（严格）
reason 必须包含至少 1 个**具体名词**，且具体名词必须从该股输入的摘要/驱动要点/事件链里抽取，不能编造。

具体词候选（白名单示例）：
- 产品/技术（如"T7 锡膏"、"TLVR 电感"、"ABF 膜"、"PPE 树脂"、"HVLP 铜箔"）
- 客户/合作方（如"英伟达"、"SK 海力士"、"华为昇腾"）
- 量化数据（如"涨价10.21%"、"订单排至27年"、"净利+159%"）
- 业务节点（如"送样验证"、"获单"、"扩产"、"认证通过"）

禁止模糊词（黑名单，用了就算违规）：
- 共振 / 协同效应（除非点名具体两个板块如何联动）
- 资金追捧 / 资金涌入 / 资金极度认可 / 资金抢筹 / 资金合力
- 情绪高涨 / 市场情绪 / 信心提振
- 活跃 / 热点 / 概念走强 / 板块走强
- 爆发力强 / 强势确立（除非给量化数据支撑）

反例（违规）："板块共振强烈，资金追捧，爆发力强。"
正例（合规）："TLVR 电感获英伟达认证，一季度订单排至 27 年。"

# 输出格式（严格 JSON，不要 markdown 代码块外的额外说明）
{
  "ranked": [
    { "ticker": "...", "name": "...", "score": 9.0, "reason": "一句评价" }
  ],
  "excluded": [
    { "ticker": "...", "name": "...", "reason": "排除理由" }
  ],
  "summary": "共评估{N}支，排除{M}支，精选{topN}支"
}

# 候选列表
`;
/** 主入口：拆分 → 共同过滤 → SHORT 专有过滤 → LLM/降级 → 补齐 → 合并。 */
async function rankCandidates(candidates, options) {
    const all = candidates.up;
    const longsAll = all.filter((c) => c.range.type === "LONG");
    const shortsAll = all.filter((c) => c.range.type === "SHORT");
    const longsPool = longsAll.filter(filterCommon);
    const shortsCommon = shortsAll.filter(filterCommon);
    const shortsPool = shortsCommon.filter(filterShortExtra);
    const longResult = await rankGroup("LONG", longsPool, longsAll.length, longsPool.length, options.topLong, candidates.scan_date, options.caller);
    const shortResult = await rankGroup("SHORT", shortsPool, shortsAll.length, shortsCommon.length, options.topShort, candidates.scan_date, options.caller);
    const summary = mergeScan(longResult, shortResult, all.length, candidates.scan_date);
    return { longResult, shortResult, summary };
}
/** 排名单组。pool 已经过所有过滤；totalPreFilter/totalPostCommon 用于报表。 */
async function rankGroup(group, pool, totalPreFilter, totalPostCommon, topN, scanDate, caller) {
    const base = {
        scan_date: scanDate,
        group,
        fallback: false,
        total: pool.length,
        distribution: computePoolDistribution(pool) ?? undefined,
        breakdown: computeBreakdown(pool) ?? undefined,
        ranked_count: 0,
        excluded_count: 0,
        ranked: [],
        excluded: [],
    };
    if (group === "SHORT") {
        base.total_pre_filter = totalPreFilter;
        base.total_post_common_filter = totalPostCommon;
    }
    // 空组：直接返回（不调 LLM、不降级）
    if (pool.length === 0)
        return base;
    // 构造输入
    const fmtFn = group === "LONG" ? formatLongEntry : formatShortEntry;
    const formatted = pool.map((c, i) => fmtFn(c, i)).join("\n\n");
    const promptTemplate = group === "LONG" ? LONG_PROMPT : SHORT_PROMPT;
    const systemPrompt = promptTemplate
        .replace(/\{N\}/g, String(pool.length))
        .replace(/\{topN\}/g, String(topN));
    const userMessage = formatted;
    // 调用 LLM
    let llmResult = null;
    try {
        const validTickers = new Set(pool.map((c) => c.ticker));
        const content = await caller({ group, systemPrompt, userMessage });
        llmResult = parseRankResponse(content, validTickers);
    }
    catch {
        llmResult = null;
    }
    // LLM 失败 → 规则降级
    if (!llmResult) {
        const fb = fallbackRank(pool, topN, group);
        return {
            ...base,
            fallback: true,
            ranked_count: fb.ranked.length,
            excluded_count: fb.excluded.length,
            ranked: fb.ranked,
            excluded: fb.excluded,
        };
    }
    // LLM 成功：补齐字段，尊重 LLM 实际选出的数量（不足 topN 不补齐）
    const lookup = new Map(pool.map((c) => [c.ticker, c]));
    const ranked = enrichRanked(llmResult.ranked, lookup);
    // excluded 同样用候选池权威 name 覆盖（同 enrichRanked 的 ticker-name 串号防护）
    const excluded = llmResult.excluded.map((e) => ({
        ticker: e.ticker,
        name: lookup.get(e.ticker)?.name ?? e.name,
        reason: e.reason,
    }));
    return {
        ...base,
        ranked_count: ranked.length,
        excluded_count: excluded.length,
        ranked,
        excluded,
    };
}
/** 合并 scan.json。top_picks 跨组按 score 降序。 */
function mergeScan(longResult, shortResult, totalCandidates, scanDate) {
    const topPicks = [
        ...longResult.ranked.map((r) => ({ ...r, group: "LONG" })),
        ...shortResult.ranked.map((r) => ({ ...r, group: "SHORT" })),
    ].sort((a, b) => b.score - a.score);
    return {
        scan_date: scanDate,
        total_candidates: totalCandidates,
        groups: {
            LONG: {
                total: longResult.total,
                ranked: longResult.ranked_count,
                excluded: longResult.excluded_count,
                fallback: longResult.fallback,
            },
            SHORT: {
                total: shortResult.total,
                pre_filter: shortResult.total_pre_filter ?? 0,
                post_common_filter: shortResult.total_post_common_filter ?? 0,
                ranked: shortResult.ranked_count,
                excluded: shortResult.excluded_count,
                fallback: shortResult.fallback,
            },
        },
        top_picks: topPicks,
    };
}
//# sourceMappingURL=ranker.js.map