"use strict";
// src/watchlist/data-trace-report.ts
//
// 单股数据管道调试视图（HTML）：从 API 请求 → 数据处理 → LLM prompt → LLM 响应 → 下游决策。
// 输出 data-trace.html，浏览器打开即可审查。
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDataTraceReport = generateDataTraceReport;
const shallow_analyzer_1 = require("./shallow-analyzer");
// ── HTML 工具 ────────────────────────────────────────────────────────────────
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fieldRow(label, value, unit = "") {
    if (value === undefined || value === null || value === "") {
        return `<tr><td class="lbl">${esc(label)}</td><td><span class="field-missing">缺失</span></td></tr>`;
    }
    const display = typeof value === "number"
        ? (Number.isFinite(value) ? String(value) : "NaN")
        : String(value);
    return `<tr><td class="lbl">${esc(label)}</td><td>${esc(display)}${esc(unit)}</td></tr>`;
}
function fieldRowHtml(label, htmlContent) {
    return `<tr><td class="lbl">${esc(label)}</td><td>${htmlContent}</td></tr>`;
}
function callRow(c) {
    const ok = c.success;
    const dur = c.duration_ms != null ? `${c.duration_ms}ms` : "-";
    const statusClass = ok ? "ok" : "fail";
    const icon = ok ? "&#10003;" : "&#10007;";
    let detailHtml = `<span class="tag ${statusClass}">${icon} ${esc(c.stage)}</span> <span class="dur">${dur}</span>`;
    if (!ok && c.error)
        detailHtml += `<span class="err">${esc(c.error.slice(0, 80))}</span>`;
    return detailHtml;
}
function summaryTable(title, rows) {
    if (rows.length === 0)
        return "";
    let h = `<div class="summary-block"><h4>${title}</h4><table>`;
    for (const [k, v] of rows)
        h += `<tr><td class="lbl">${esc(k)}</td><td>${esc(v)}</td></tr>`;
    h += "</table></div>";
    return h;
}
function summaryTableHtml(title, rows) {
    if (rows.length === 0)
        return "";
    let h = `<div class="summary-block"><h4>${title}</h4><table>`;
    for (const [k, v] of rows)
        h += `<tr><td class="lbl">${esc(k)}</td><td>${v}</td></tr>`;
    h += "</table></div>";
    return h;
}
function detailTable(rows) {
    if (rows.length === 0)
        return "";
    let h = "<table>";
    for (const [k, v] of rows)
        h += `<tr><td class="lbl">${esc(k)}</td><td>${esc(v)}</td></tr>`;
    h += "</table>";
    return h;
}
function codeBlock(content, lang = "") {
    const cls = lang ? `code-block ${lang}` : "code-block";
    return `<pre class="${cls}"><code>${esc(content)}</code></pre>`;
}
/** 代码块，带 prompt/response 左边框区分 */
function codeBlockStyled(content, style) {
    return `<pre class="code-block ${style}"><code>${esc(content)}</code></pre>`;
}
function details(summary, content) {
    return `<details><summary>${summary}</summary><div class="detail-body">${content}</details>`;
}
/** 尝试从 response_snippet（可能是 JSONP callback({...}) 包裹）解析出 JSON 对象。
 *  失败返回 null（调用方降级为纯文本展示）。
 *  对截断的 JSON（snippet 只有前 200 字符）做容错：尝试补全末尾括号。 */
function tryParseResponseJson(snippet) {
    let s = snippet.trim();
    // JSONP: callback({...}) / jsonp({...}) — 取第一个 ( 到最后一个 ) 之间
    const parenStart = s.indexOf("(");
    const parenEnd = s.lastIndexOf(")");
    if (parenStart >= 0 && parenEnd > parenStart) {
        s = s.slice(parenStart + 1, parenEnd).trim();
    }
    // 先尝试直接解析
    try {
        return JSON.parse(s);
    }
    catch {
        // 截断容错：如果看起来像 JSON（以 { 或 [ 开头），尝试补全末尾
        if (s.startsWith("{") || s.startsWith("[")) {
            return tryParseTruncatedJson(s);
        }
        return null;
    }
}
/** 尝试解析截断的 JSON：逐步从末尾裁剪，再补全括号直到解析成功。
 *  返回补全后的对象，或 null（无法修复）。 */
function tryParseTruncatedJson(s) {
    for (let trim = 0; trim <= Math.min(s.length, 50); trim++) {
        const candidate = trim > 0 ? s.slice(0, -trim) : s;
        let braces = 0, brackets = 0, inStr = false, esc = false;
        for (const ch of candidate) {
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === "\\") {
                esc = true;
                continue;
            }
            if (ch === '"') {
                inStr = !inStr;
                continue;
            }
            if (inStr)
                continue;
            if (ch === "{")
                braces++;
            if (ch === "}")
                braces--;
            if (ch === "[")
                brackets++;
            if (ch === "]")
                brackets--;
        }
        let fixed = candidate;
        if (inStr)
            fixed += '"';
        while (braces > 0) {
            fixed += "}";
            braces--;
        }
        while (brackets > 0) {
            fixed += "]";
            brackets--;
        }
        try {
            return JSON.parse(fixed);
        }
        catch { }
    }
    return null;
}
/** 渲染 JSON 为可折叠树（<details> 嵌套）。顶层默认展开，深层默认折叠。
 *  字符串/数字/布尔/null 直接着色显示；对象/数组可折叠并标注元素数。 */
function renderJsonTree(value, key) {
    const keyHtml = key !== undefined ? `<span class="jt-key">${esc(key)}</span>: ` : "";
    if (value === null) {
        return `<div>${keyHtml}<span class="jt-null">null</span></div>`;
    }
    const type = typeof value;
    if (type === "string") {
        // 截断超长字符串（如整篇新闻正文），title 提供完整内容
        const shown = value.length > 200 ? value.slice(0, 200) + "…" : value;
        return `<div>${keyHtml}<span class="jt-str" title="${esc(value)}">"${esc(shown)}"</span></div>`;
    }
    if (type === "number") {
        return `<div>${keyHtml}<span class="jt-num">${value}</span></div>`;
    }
    if (type === "boolean") {
        return `<div>${keyHtml}<span class="jt-bool">${value}</span></div>`;
    }
    // 对象或数组 → 可折叠
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    const open = key === undefined ? " open" : ""; // 顶层（无 key）默认展开
    const bracket = isArray ? ["[", "]"] : ["{", "}"];
    const count = entries.length;
    const summary = `${keyHtml}<span class="jt-bracket">${bracket[0]}</span><span class="jt-count">${count} 项</span><span class="jt-bracket">${bracket[1]}</span>`;
    if (count === 0) {
        return `<div>${keyHtml}<span class="jt-bracket">${bracket[0]}${bracket[1]}</span></div>`;
    }
    let body = "";
    for (const [k, v] of entries) {
        body += renderJsonTree(v, isArray ? `[${k}]` : k);
    }
    // 顶层（key===undefined）= 一棵 JSON 树的根：summary 右侧加就地「展开/折叠全部」按钮，
    // 只控制本树内部节点（data-action + 最接近的 .json-tree 容器作用域），无需滚到页面顶部。
    const treeActions = key === undefined
        ? ` <span class="jt-tree-actions"><button type="button" class="jt-btn" data-action="expand">展开全部</button><button type="button" class="jt-btn" data-action="collapse">折叠全部</button></span>`
        : "";
    return `<details${open}><summary>${summary}${treeActions}</summary><div class="jt-children">${body}</div></details>`;
}
// ── 语义化辅助函数 ──────────────────────────────────────────────────────────
/** 根据数值正负返回 CSS class */
function valClass(v) {
    if (v > 0)
        return "val-pos";
    if (v < 0)
        return "val-neg";
    return "val-neutral";
}
/** 渲染带符号的着色数值（suffix 包含在着色 span 内） */
function signedVal(v, decimals = 2, suffix = "") {
    const sign = v > 0 ? "+" : "";
    const cls = valClass(v);
    return `<span class="${cls}">${sign}${v.toFixed(decimals)}${suffix}</span>`;
}
/** 渲染百分位进度条（0-100，低=绿，中=黄，高=红） */
function pctBar(pct) {
    if (pct == null || !Number.isFinite(pct))
        return `<span class="field-missing">N/A</span>`;
    const p = Math.max(0, Math.min(100, pct));
    let color;
    if (p < 30)
        color = "var(--ok)";
    else if (p < 70)
        color = "var(--warn)";
    else
        color = "var(--fail)";
    return `<span class="pct-wrap">${p.toFixed(0)}%<span class="pct-bar"><span class="pct-fill" style="width:${p}%;background:${color}"></span></span></span>`;
}
/** 渲染信号标签（方向/状态） */
function signalTag(value, cls) {
    if (!value)
        return `<span class="field-missing">无</span>`;
    return `<span class="signal ${cls}">${esc(value)}</span>`;
}
/** 根据 northbound_signal 返回标签 */
function northboundTag(signal) {
    if (signal === "inflow")
        return signalTag("净流入", "inflow");
    if (signal === "outflow")
        return signalTag("净流出", "outflow");
    return `<span class="muted">${esc(signal || "无数据")}</span>`;
}
/** 根据 sector_in_industry_tag 返回标签 */
function sectorTag(tag) {
    if (!tag)
        return `<span class="field-missing">未上榜</span>`;
    if (tag === "主线")
        return signalTag("主线", "bullish");
    if (tag === "弱势")
        return signalTag("弱势", "bearish");
    return signalTag(tag, "neutral");
}
/** 根据 fitness_score 返回色彩 class */
function fitnessClass(score) {
    if (score >= 8)
        return "val-pos";
    if (score >= 5)
        return "val-warn";
    return "val-neg";
}
/** 根据 overall_risk 返回信号标签 */
function riskTag(risk) {
    if (risk === "low")
        return signalTag("low", "bullish");
    if (risk === "medium")
        return signalTag("medium", "neutral");
    if (risk === "high")
        return signalTag("high", "bearish");
    return `<span class="muted">${esc(risk)}</span>`;
}
/** 根据 MACD crossover 返回信号标签 */
function crossoverTag(crossover) {
    if (crossover === "golden")
        return signalTag("金叉", "bullish");
    if (crossover === "death")
        return signalTag("死叉", "bearish");
    return signalTag(crossover || "none", "neutral");
}
/** 根据 MACD direction 返回信号标签 */
function directionTag(direction) {
    if (direction === "看多")
        return signalTag("看多", "bullish");
    if (direction === "看空")
        return signalTag("看空", "bearish");
    return signalTag(direction || "中性", "neutral");
}
// ── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
<style>
:root {
  --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a;
  --text: #e0e0e0; --muted: #888; --accent: #4fc3f7;
  --ok: #4caf50; --fail: #ef5350; --warn: #ffa726;
  --code-bg: #12141c; --hover: #252836;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', monospace; background: var(--bg); color: var(--text); line-height: 1.6; padding: 24px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.4em; color: var(--accent); margin-bottom: 4px; }
h2 { font-size: 1.15em; color: var(--accent); margin: 28px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 1.0em; color: #ccc; margin: 18px 0 8px; }
h4 { font-size: 0.9em; color: var(--muted); margin: 10px 0 6px; }
.subtitle { color: var(--muted); font-size: 0.85em; margin-bottom: 20px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 12px 0; }
.tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.82em; font-weight: 600; }
.tag.ok { background: #1b3a1b; color: var(--ok); }
.tag.fail { background: #3a1b1b; color: var(--fail); }
.tag.warn { background: #3a2f1b; color: var(--warn); }
.dur { color: var(--muted); font-size: 0.82em; margin-left: 6px; }
.err { color: var(--fail); font-size: 0.8em; margin-left: 8px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 0.88em; }
td { padding: 4px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
td.lbl { color: var(--muted); white-space: nowrap; width: 160px; }
table tr:nth-child(even) { background: rgba(255,255,255,0.015); }
table tr:hover { background: var(--hover); }
.muted { color: var(--muted); }
pre.code-block { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 0.82em; line-height: 1.5; margin: 8px 0; }
pre.code-block.prompt { border-left: 3px solid var(--accent); }
pre.code-block.response { border-left: 3px solid var(--ok); }
code { font-family: 'SF Mono', 'Fira Code', monospace; }
.summary-block { margin: 8px 0; }
details { margin: 8px 0; }
details > summary { cursor: pointer; color: var(--accent); font-size: 0.9em; padding: 6px 0; user-select: none;
  list-style: none; }  /* 隐藏默认 marker，用自定义 ▶ 三角替代，暗色主题下更醒目 */
details > summary::-webkit-details-marker { display: none; }  /* Safari */
details > summary::before { content: "▶"; display: inline-block; color: var(--muted); font-size: 0.75em;
  margin-right: 6px; transition: transform 0.15s; }
details[open] > summary::before { transform: rotate(90deg); }  /* 展开时三角朝下 */
details > summary:hover { text-decoration: underline; }
.detail-body { padding: 8px 0 8px 16px; border-left: 2px solid var(--border); }
.call-flow { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.section-divider { border: none; border-top: 1px solid var(--border); margin: 28px 0; }

/* 数值语义色彩 */
.val-pos { color: var(--ok); font-weight: 600; }
.val-neg { color: var(--fail); font-weight: 600; }
.val-warn { color: var(--warn); font-weight: 600; }
.val-neutral { color: var(--muted); }

/* 缺失字段 */
.field-missing { color: var(--muted); font-style: italic; background: rgba(255,255,255,0.03); padding: 1px 6px; border-radius: 3px; font-size: 0.88em; }

/* 信号标签 */
.signal { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.82em; font-weight: 600; }
.signal.inflow { background: #1b3a1b; color: var(--ok); }
.signal.outflow { background: #3a1b1b; color: var(--fail); }
.signal.bullish { background: #1b3a1b; color: var(--ok); }
.signal.bearish { background: #3a1b1b; color: var(--fail); }
.signal.neutral { background: #2a2d3a; color: var(--muted); }

/* 百分位进度条 */
.pct-wrap { display: inline-flex; align-items: center; gap: 6px; }
.pct-bar { display: inline-block; width: 80px; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; vertical-align: middle; }
.pct-fill { height: 100%; border-radius: 3px; }

/* JSON 折叠树 */
.json-tree { font-size: 0.84em; line-height: 1.7; margin: 6px 0; }
.json-tree details > summary { color: #ccc; font-size: 1em; padding: 1px 0; }
.json-tree details > summary:hover { text-decoration: none; color: var(--accent); }
.json-tree .jt-key { color: #9cdcfe; }
.json-tree .jt-str { color: #ce9178; }
.json-tree .jt-num { color: #b5cea8; }
.json-tree .jt-bool { color: #569cd6; }
.json-tree .jt-null { color: var(--muted); font-style: italic; }
.json-tree .jt-count { color: var(--muted); font-size: 0.9em; margin-left: 2px; }
.json-tree .jt-bracket { color: var(--muted); }
.json-tree .jt-children { padding-left: 18px; border-left: 1px dashed var(--border); margin-left: 4px; }
.json-tree .jt-tree-actions { margin-left: 10px; white-space: nowrap; }
.json-tree .jt-btn { background: var(--border); border: none; color: var(--muted); padding: 1px 7px;
  border-radius: 3px; cursor: pointer; font-size: 0.8em; font-family: inherit; margin-left: 4px; }
.json-tree .jt-btn:hover { color: var(--accent); background: var(--hover); }
.risk-flag { background: #3a1b1b; border-left: 3px solid var(--fail); padding: 6px 10px; margin: 4px 0; border-radius: 0 4px 4px 0; font-size: 0.88em; }
.risk-flag .sev { color: var(--fail); font-weight: 600; }
.action-sell { color: var(--fail); font-weight: 600; }
.action-hold { color: var(--warn); font-weight: 600; }
.action-buy { color: var(--ok); font-weight: 600; }

/* 置顶导航栏 */
.nav-bar { position: sticky; top: 0; z-index: 100; background: var(--card); border-bottom: 1px solid var(--border); padding: 8px 16px; display: flex; align-items: center; gap: 6px; font-size: 0.85em; margin: 0 -24px; padding-left: 24px; }
.nav-bar .nav-links { display: flex; gap: 12px; flex: 1; overflow-x: auto; }
.nav-bar a { color: var(--muted); text-decoration: none; white-space: nowrap; }
.nav-bar a:hover { color: var(--accent); }
.nav-bar .nav-actions { display: flex; gap: 4px; flex-shrink: 0; }
.nav-btn { background: var(--border); border: none; color: var(--muted); padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.82em; font-family: inherit; }
.nav-btn:hover { background: var(--hover); color: var(--text); }

/* 搜索框 */
.search-wrap { position: relative; flex-shrink: 0; }
.search-wrap input { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 3px 8px; border-radius: 4px; font-size: 0.82em; font-family: inherit; width: 140px; outline: none; }
.search-wrap input:focus { border-color: var(--accent); width: 200px; transition: width 0.2s; }
.search-wrap input::placeholder { color: var(--muted); }

/* 搜索高亮 */
mark { background: rgba(255,167,38,0.35); color: inherit; border-radius: 2px; padding: 0 1px; }
.search-dim { opacity: 0.3; }

/* news_layer_stats 小卡片 */
.stats-row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.stat-chip { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; font-size: 0.85em; text-align: center; }
.stat-chip .stat-val { font-size: 1.3em; font-weight: 700; color: var(--text); display: block; }
.stat-chip .stat-label { color: var(--muted); font-size: 0.8em; }

/* fitness 评分色块 */
.fitness-badge { display: inline-block; font-size: 1.2em; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
.fitness-badge.high { background: rgba(76,175,80,0.15); color: var(--ok); }
.fitness-badge.mid { background: rgba(255,167,38,0.15); color: var(--warn); }
.fitness-badge.low { background: rgba(239,83,80,0.15); color: var(--fail); }

/* 快捷键提示面板 */
.shortcut-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; z-index: 200; font-size: 0.88em; box-shadow: 0 8px 32px rgba(0,0,0,0.5); display: none; }
.shortcut-panel.show { display: block; }
.shortcut-panel h3 { margin-bottom: 10px; color: var(--accent); }
.shortcut-panel table { margin: 0; }
.shortcut-panel td { padding: 4px 12px; }
.shortcut-panel kbd { background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 3px; font-family: 'SF Mono', monospace; font-size: 0.85em; }
.shortcut-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 199; display: none; }
.shortcut-overlay.show { display: block; }
</style>`;
// ── JavaScript ───────────────────────────────────────────────────────────────
const JS = `
<script>
(function(){
  // ── 一键展开/折叠 ──
  // toggleTree(scope, open)：scope=容器元素，只操作该容器内的 details；
  // toggleTree(null, open)：全局（顶部按钮/快捷键），操作页面上所有 .json-tree。
  function toggleTree(scope, open) {
    var sel = scope ? (scope.matches('.json-tree') ? scope : scope.closest('.json-tree') || scope) : null;
    var root = sel || document;
    root.querySelectorAll('details').forEach(function(d) {
      if (open) d.setAttribute('open', '');
      else d.removeAttribute('open');
    });
  }
  var expandBtn = document.getElementById('btn-expand');
  var collapseBtn = document.getElementById('btn-collapse');
  if (expandBtn) expandBtn.addEventListener('click', function() { toggleTree(null, true); });
  if (collapseBtn) collapseBtn.addEventListener('click', function() { toggleTree(null, false); });

  // 就地按钮（每棵 JSON 树根 summary 上）：只控制本树，且阻止冒泡到 summary
  document.addEventListener('click', function(e) {
    var btn = e.target.closest && e.target.closest('.jt-btn[data-action]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var tree = btn.closest('.json-tree');
    toggleTree(tree, btn.getAttribute('data-action') === 'expand');
  });

  // ── 搜索高亮 ──
  var searchInput = document.getElementById('search-input');
  function clearSearch() {
    // 先把所有 mark 还原为纯文本
    document.querySelectorAll('mark').forEach(function(m) {
      var parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    document.querySelectorAll('.search-dim').forEach(function(el) { el.classList.remove('search-dim'); });
  }
  function highlightSearch(query) {
    clearSearch();
    if (!query || query.length < 2) return;
    var lowerQuery = query.toLowerCase();
    // 收集所有可见文本节点
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while (node = walker.nextNode()) {
      if (node.parentElement && (node.parentElement.tagName === 'CODE' || node.parentElement.tagName === 'PRE' || node.parentElement.tagName === 'TD' || node.parentElement.tagName === 'DIV' || node.parentElement.tagName === 'SPAN' || node.parentElement.tagName === 'LI' || node.parentElement.tagName === 'P' || node.parentElement.tagName === 'SUMMARY' || node.parentElement.tagName === 'STRONG' || node.parentElement.tagName === 'H3' || node.parentElement.tagName === 'H4')) {
        if (node.textContent.trim().length > 0 && !node.parentElement.closest('.nav-bar') && !node.parentElement.closest('.shortcut-panel')) {
          nodes.push(node);
        }
      }
    }
    for (var i = 0; i < nodes.length; i++) {
      var text = nodes[i].textContent;
      var lowerText = text.toLowerCase();
      var idx = lowerText.indexOf(lowerQuery);
      if (idx === -1) {
        nodes[i].parentElement.classList.add('search-dim');
      } else {
        var frag = document.createDocumentFragment();
        var lastIdx = 0;
        while (idx !== -1) {
          if (idx > lastIdx) frag.appendChild(document.createTextNode(text.substring(lastIdx, idx)));
          var mk = document.createElement('mark');
          mk.textContent = text.substring(idx, idx + query.length);
          frag.appendChild(mk);
          lastIdx = idx + query.length;
          idx = lowerText.indexOf(lowerQuery, lastIdx);
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.substring(lastIdx)));
        nodes[i].parentNode.replaceChild(frag, nodes[i]);
      }
    }
  }
  var searchTimer;
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      clearTimeout(searchTimer);
      var q = this.value;
      searchTimer = setTimeout(function() { highlightSearch(q); }, 300);
    });
  }

  // ── 平滑滚动导航 ──
  document.querySelectorAll('.nav-bar a[href^="#"]').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      var target = document.querySelector(this.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ── 快捷键 ──
  var shortcutPanel = document.getElementById('shortcut-panel');
  var shortcutOverlay = document.getElementById('shortcut-overlay');
  function toggleShortcuts() {
    if (!shortcutPanel) return;
    var show = !shortcutPanel.classList.contains('show');
    shortcutPanel.classList.toggle('show', show);
    if (shortcutOverlay) shortcutOverlay.classList.toggle('show', show);
  }
  function hideShortcuts() {
    if (shortcutPanel) shortcutPanel.classList.remove('show');
    if (shortcutOverlay) shortcutOverlay.classList.remove('show');
  }
  if (shortcutOverlay) shortcutOverlay.addEventListener('click', hideShortcuts);

  document.addEventListener('keydown', function(e) {
    // 忽略输入框内的按键
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape' && e.target === searchInput) { searchInput.value = ''; clearSearch(); searchInput.blur(); }
      return;
    }
    if (e.key === 'e' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleTree(null, true); }
    if (e.key === 'E' && e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleTree(null, false); }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (searchInput) searchInput.focus(); }
    if (e.key === '?') { e.preventDefault(); toggleShortcuts(); }
    if (e.key === 'Escape') { hideShortcuts(); }
  });
})();
</script>`;
const SHORTCUT_PANEL = `
<div class="shortcut-overlay" id="shortcut-overlay"></div>
<div class="shortcut-panel" id="shortcut-panel">
  <h3>快捷键</h3>
  <table>
    <tr><td><kbd>E</kbd></td><td>展开全部折叠</td></tr>
    <tr><td><kbd>Shift</kbd>+<kbd>E</kbd></td><td>折叠全部</td></tr>
    <tr><td><kbd>/</kbd></td><td>聚焦搜索框</td></tr>
    <tr><td><kbd>?</kbd></td><td>显示/关闭本面板</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>关闭面板 / 清空搜索</td></tr>
  </table>
</div>`;
// ── 6 个数据源的链路追踪 ────────────────────────────────────────────────────
function traceKline(d) {
    let h = `<h3 id="sec-kline">1. K 线（kline.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-kline/scripts/kline.py &nbsp;|&nbsp; API: mootdx TDX TCP → akshare fallback</p>`;
    const r2 = (v) => Number.isFinite(v) ? v.toFixed(2) : String(v);
    h += summaryTableHtml("parseKline() 处理后", [
        ["pct_5d", signedVal(d.kline.pct_5d, 2, "%")],
        ["pct_20d", signedVal(d.kline.pct_20d, 2, "%")],
        ["support", r2(d.kline.support)],
        ["resistance", r2(d.kline.resistance)],
        ["volatility_20d", d.kline.volatility_20d > 4 ? `<span class="val-warn">${r2(d.kline.volatility_20d)}%</span>` : `${r2(d.kline.volatility_20d)}%`],
        ["volume_ratio_5_20", d.kline.volume_ratio_5_20 > 1.2 ? `<span class="val-pos">${r2(d.kline.volume_ratio_5_20)}</span> 放量` : d.kline.volume_ratio_5_20 < 0.8 ? `<span class="val-warn">${r2(d.kline.volume_ratio_5_20)}</span> 缩量` : `${r2(d.kline.volume_ratio_5_20)} 正常`],
    ]);
    if (d.macd) {
        h += summaryTableHtml("MACD", [
            ["DIF", String(d.macd.dif)],
            ["DEA", String(d.macd.dea)],
            ["histogram", signedVal(d.macd.histogram)],
            ["direction", directionTag(d.macd.direction)],
            ["crossover", crossoverTag(d.macd.crossover)],
        ]);
    }
    h += `<h4>注入 prompt</h4>`;
    h += codeBlockStyled(`## K 线（5 日 ${d.kline.pct_5d > 0 ? "+" : ""}${r2(d.kline.pct_5d)}% / 20 日 ${d.kline.pct_20d > 0 ? "+" : ""}${r2(d.kline.pct_20d)}%，支撑 ${r2(d.kline.support)} / 压力 ${r2(d.kline.resistance)}）`, "prompt");
    return h;
}
function traceNews(d) {
    let h = `<h3 id="sec-news">2. 新闻（news.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-news/scripts/news.py &nbsp;|&nbsp; API: 东方财富搜索</p>`;
    // news_layer_stats 卡片
    if (d.news_layer_stats) {
        const s = d.news_layer_stats;
        h += `<div class="stats-row">`;
        h += `<div class="stat-chip"><span class="stat-val">${s.realtime_6h_count}</span><span class="stat-label">6h 突发</span></div>`;
        h += `<div class="stat-chip"><span class="stat-val">${s.extended_24h_count}</span><span class="stat-label">24h</span></div>`;
        h += `<div class="stat-chip"><span class="stat-val">${s.history_7d_count}</span><span class="stat-label">7 天</span></div>`;
        h += `<div class="stat-chip"><span class="stat-val">${s.total_categorized}</span><span class="stat-label">已分类</span></div>`;
        h += `</div>`;
    }
    h += `<h4>parseNews() 处理后</h4>`;
    h += "<ul>";
    for (const n of d.news.slice(0, 5)) {
        h += `<li><strong>${esc(n.title)}</strong>`;
        if (n.source)
            h += ` <span class="muted">[${esc(n.source)}]</span>`;
        if (n.content) {
            // 过滤纯数字/表格噪音，只保留可读文本段
            const clean = n.content
                .replace(/\d+\.\d+\s+\d+\.\d+/g, "") // 连续数字对
                .replace(/\b\d{6}\b/g, "") // 6位股票代码
                .replace(/\s{3,}/g, " ") // 多空格
                .trim();
            if (clean.length > 10) {
                h += `<br><span class="muted">${esc(clean.slice(0, 120))}${clean.length > 120 ? "..." : ""}</span>`;
            }
            else {
                h += `<br><span class="muted">(表格数据，省略)</span>`;
            }
        }
        if (n.time)
            h += `<br><span class="muted">${esc(n.time)}</span>`;
        h += "</li>";
    }
    if (d.news.length > 5)
        h += `<li class="muted">... 共 ${d.news.length} 条</li>`;
    h += "</ul>";
    h += `<h4>注入 prompt</h4>`;
    h += codeBlockStyled(d.news.map(n => {
        const t = n.time ? `[${n.time}] ` : "";
        const c = n.content ? `：${n.content}` : "";
        return `- ${t}${n.title}${c}`;
    }).join("\n"), "prompt");
    return h;
}
function traceHotMoney(d) {
    let h = `<h3 id="sec-hotmoney">3. 资金流向（hot_money.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-hot-money/scripts/hot_money.py &nbsp;|&nbsp; 3 个全局子源并行</p>`;
    const rYi = (v) => v !== 0 ? `${(v / 1e8).toFixed(2)}亿` : "0";
    h += summaryTableHtml("parseHotMoney() 处理后", [
        ["northbound_yi", signedVal(d.hot_money.northbound_yi, 2, "亿")],
        ["northbound_signal", northboundTag(d.hot_money.northbound_signal)],
        ["dragon_tiger_recent", d.hot_money.dragon_tiger_recent ?? `<span class="field-missing">缺失</span>`],
        ["dragon_tiger_reason", d.hot_money.dragon_tiger_reason ?? `<span class="field-missing">缺失</span>`],
        ["sector_in_industry_tag", sectorTag(d.hot_money.sector_in_industry_tag ?? "")],
        ["hot_stocks_top", d.hot_money.hot_stocks_top ?? `<span class="field-missing">缺失</span>`],
    ]);
    h += `<h4>注入 prompt</h4>`;
    h += codeBlockStyled((0, shallow_analyzer_1.renderHotMoneySummary)(d.hot_money), "prompt");
    return h;
}
function traceFundamentals(d) {
    let h = `<h3 id="sec-fundamentals">4. 基本面（fundamentals.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-fundamentals/scripts/fundamentals.py &nbsp;|&nbsp; 10 个子源</p>`;
    const rYi = (v) => v > 0 ? `${(v / 1e8).toFixed(2)}亿` : String(v);
    const industry = d.fundamentals.industry;
    h += summaryTableHtml("parseFundamentals() 处理后", [
        // PE<0（亏损股）标注语义，避免误读为高估值；保留原始数值供调试
        ["pe", `${d.fundamentals.pe}${d.fundamentals.pe < 0 ? ` <span class="field-missing">(亏损，prompt 归一化为 N/A)</span>` : ""}`],
        ["pb", String(d.fundamentals.pb)],
        ["rev_q1", rYi(d.fundamentals.rev_q1)],
        ["np_q1", rYi(d.fundamentals.np_q1)],
        ["industry", industry ? esc(industry) : `<span class="field-missing">缺失</span>`],
        ["pe_percentile", d.fundamentals.pe_percentile != null ? pctBar(d.fundamentals.pe_percentile) : `<span class="field-missing">N/A</span>`],
        ["pb_percentile", d.fundamentals.pb_percentile != null ? pctBar(d.fundamentals.pb_percentile) : `<span class="field-missing">N/A</span>`],
    ]);
    if (d.fundamentals.quarterly_trends && d.fundamentals.quarterly_trends.length > 0) {
        h += `<h4>季度趋势</h4>`;
        h += codeBlockStyled((0, shallow_analyzer_1.renderQuarterlyTrends)(d.fundamentals.quarterly_trends), "prompt");
    }
    if (d.fundamentals.consensus_eps) {
        h += `<h4>机构预期</h4>`;
        h += codeBlockStyled((0, shallow_analyzer_1.renderConsensus)(d.fundamentals.consensus_eps), "prompt");
    }
    h += `<h4>注入 prompt</h4>`;
    const revQ1 = d.fundamentals.rev_q1 > 0 ? `${(d.fundamentals.rev_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.rev_q1);
    const npQ1 = d.fundamentals.np_q1 > 0 ? `${(d.fundamentals.np_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.np_q1);
    const pe = (0, shallow_analyzer_1.renderPe)(d.fundamentals.pe); // 与实际注入 prompt 一致（亏损股归一化为 N/A）
    const pb = Number.isFinite(d.fundamentals.pb) ? d.fundamentals.pb.toFixed(2) : String(d.fundamentals.pb);
    h += codeBlockStyled(`## 基本面（PE ${pe} / PB ${pb} / Q1 营收 ${revQ1} / Q1 净利 ${npQ1}）`, "prompt");
    return h;
}
function traceVpaMacd(d) {
    let h = `<h3 id="sec-vpa">5. VPA 量价预计算 + MACD</h3>`;
    h += `<p class="muted">来源: skills/trading-kline/scripts/kline.py（与 K 线同一脚本）</p>`;
    if (d.vpa_text) {
        h += `<h4>VPA 量价预计算 → 注入 risk prompt</h4>`;
        h += codeBlockStyled(d.vpa_text, "prompt");
    }
    else {
        h += `<p class="muted">VPA: 无数据</p>`;
    }
    if (d.macd) {
        h += `<h4>MACD 动量信号 → 注入 risk prompt</h4>`;
        h += codeBlockStyled((0, shallow_analyzer_1.renderMacd)(d.macd), "prompt");
    }
    return h;
}
function traceLockup(d) {
    let h = `<h3 id="sec-lockup">6. 解禁与减持（lockup.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-lockup/scripts/lockup.py &nbsp;|&nbsp; 3 个子源</p>`;
    if (d.lockup) {
        h += summaryTable("parseLockup() 处理后", [
            ["pressure_rating", d.lockup.pressure_rating],
            ["upcoming 解禁数", `${d.lockup.upcoming.length}笔`],
            ["reduce_holdings 减持数", `${d.lockup.reduce_holdings.length}笔`],
        ]);
        if (d.lockup.upcoming.length > 0) {
            h += "<h4>解禁明细（未来 90 天）</h4><ul>";
            for (const u of d.lockup.upcoming.slice(0, 5)) {
                h += `<li>${esc(u.date)} | ${esc(u.type ?? "?")} | 比例 ${esc(u.ratio ?? "?")}</li>`;
            }
            h += "</ul>";
        }
        h += `<h4>注入 prompt</h4>`;
        h += codeBlockStyled((0, shallow_analyzer_1.renderLockup)(d.lockup), "prompt");
    }
    else {
        h += `<p class="muted">无解禁减持数据</p>`;
    }
    return h;
}
function traceDecisionChain(stockReport, action, positionTrace) {
    let h = `<h3 id="sec-decision">7. 下游决策链</h3>`;
    // fitness 评分醒目展示
    const fitCls = stockReport.fitness_score >= 8 ? "high" : stockReport.fitness_score >= 5 ? "mid" : "low";
    h += summaryTableHtml("Analyst 输出 → fitness 评分", [
        ["fitness_score", `<span class="fitness-badge ${fitCls}">${stockReport.fitness_score}</span>`],
        ["overall_risk", riskTag(stockReport.overall_risk)],
        ["deal_breaker", stockReport.deal_breaker ? `<span class="val-neg">true</span>` : "false"],
    ]);
    if (stockReport.quality_notes && stockReport.quality_notes.length > 0) {
        h += `<p><strong>quality_notes:</strong> ${esc(stockReport.quality_notes.join("; "))}</p>`;
    }
    if (stockReport.risk_flags.length > 0) {
        h += "<h4>Risk flags</h4>";
        for (const f of stockReport.risk_flags) {
            h += `<div class="risk-flag"><span class="sev">[${esc(f.severity)}]</span> <strong>${esc(f.flag)}</strong>: ${esc(f.detail)}</div>`;
        }
    }
    h += "<h4>Rebalancer 判定</h4>";
    if (action) {
        const cls = action.action === "SELL" ? "action-sell" : action.action === "BUY" ? "action-buy" : "action-hold";
        h += summaryTableHtml("Rebalancer 判定", [
            ["action", `<span class="${cls}">${esc(action.action)}</span>`],
            ["current_weight", `${(action.current_weight * 100).toFixed(1)}%`],
            ["target_weight", `${(action.target_weight * 100).toFixed(1)}%`],
            ["delta", `${(action.delta * 100).toFixed(1)}%`],
            ["reason", action.reason],
        ]);
    }
    else {
        h += `<p class="muted">无对应 action</p>`;
    }
    if (positionTrace) {
        h += `<h4>仓位计算溯源</h4>`;
        h += codeBlock(positionTrace);
    }
    return h;
}
// ── 主入口 ──────────────────────────────────────────────────────────────────
function generateDataTraceReport(ticker, name, stockData, stockReport, action, positionTrace) {
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据管道: ${esc(ticker)} ${esc(name)}</title>
${CSS}
</head>
<body>`;
    // ── 置顶导航栏 ──
    html += `<nav class="nav-bar">
  <div class="nav-links">
    <a href="#sec-calls">调用记录</a>
    <a href="#sec-kline">K 线</a>
    <a href="#sec-news">新闻</a>
    <a href="#sec-hotmoney">资金</a>
    <a href="#sec-fundamentals">基本面</a>
    <a href="#sec-vpa">VPA</a>
    <a href="#sec-lockup">解禁</a>
    <a href="#sec-prompt">Prompt</a>
    <a href="#sec-decision">决策</a>
  </div>
  <div class="search-wrap"><input type="text" id="search-input" placeholder="搜索... (按 / 聚焦)"></div>
  <div class="nav-actions">
    <button class="nav-btn" id="btn-expand" title="展开全部 (E)">展开</button>
    <button class="nav-btn" id="btn-collapse" title="折叠全部 (Shift+E)">折叠</button>
  </div>
</nav>`;
    html += `<h1>${esc(ticker)} ${esc(name)}</h1>`;
    html += `<p class="subtitle">数据管道调试视图 &mdash; API 请求 &rarr; 数据处理 &rarr; LLM prompt &rarr; LLM 响应 &rarr; 下游决策 &nbsp; <span class="muted">(按 <kbd>?</kbd> 查看快捷键)</span></p>`;
    // ── 一、子源调用记录 ──
    if (stockData.calls && stockData.calls.length > 0) {
        html += `<hr class="section-divider"><h2 id="sec-calls">一、子源调用记录</h2>`;
        html += `<div class="call-flow">`;
        for (const c of stockData.calls) {
            html += callRow(c);
        }
        html += `</div>`;
        // 详细记录折叠
        let detailHtml = "";
        for (const c of stockData.calls) {
            const ok = c.success;
            const icon = ok ? "&#10003;" : "&#10007;";
            detailHtml += `<h4>${icon} ${esc(c.stage)}</h4>`;
            const rows = [];
            if (c.url)
                rows.push(["请求 URL", c.url]);
            if (c.status_code)
                rows.push(["HTTP 状态码", String(c.status_code)]);
            if (c.duration_ms)
                rows.push(["耗时", `${c.duration_ms}ms`]);
            if (c.response_size)
                rows.push(["响应大小", `${c.response_size} bytes`]);
            if (c.error)
                rows.push(["错误", c.error]);
            detailHtml += detailTable(rows);
            if (c.response_snippet) {
                detailHtml += `<h4>响应内容</h4>`;
                const parsed = tryParseResponseJson(c.response_snippet);
                if (parsed !== null) {
                    // JSON / JSONP → 折叠树（默认展开第一层，点开往下钻，不截断）
                    detailHtml += `<div class="json-tree">${renderJsonTree(parsed)}</div>`;
                }
                else {
                    // 非 JSON（HTML/纯文本）→ 保留截断展示，但放进 details 避免巨长
                    const snippet = c.response_snippet;
                    const shown = snippet.length > 2000 ? snippet.slice(0, 2000) + "\n... (truncated)" : snippet;
                    detailHtml += codeBlock(shown, "json");
                }
            }
        }
        html += details("展开全部调用详情", detailHtml);
    }
    // ── 二、数据处理链路 ──
    html += `<hr class="section-divider"><h2>二、数据处理链路</h2>`;
    html += `<div class="card">`;
    html += traceKline(stockData);
    html += traceNews(stockData);
    html += traceHotMoney(stockData);
    html += traceFundamentals(stockData);
    html += traceVpaMacd(stockData);
    html += traceLockup(stockData);
    html += `</div>`;
    // ── 三、LLM 交互 ──
    html += `<hr class="section-divider"><h2 id="sec-prompt">三、LLM 交互</h2>`;
    // analyst prompt
    html += `<h3>完整 analyst prompt</h3>`;
    html += details("展开 prompt 全文", codeBlockStyled((0, shallow_analyzer_1.formatAnalystPrompt)(stockData), "prompt"));
    if (stockReport) {
        // LLM 返回
        html += `<h3>LLM 返回（analyst-role）</h3>`;
        html += codeBlockStyled(JSON.stringify({
            thesis: stockReport.thesis,
            fitness_score: stockReport.fitness_score,
            key_signals: stockReport.key_signals,
            data_gaps: stockReport.data_gaps,
        }, null, 2), "response");
        // risk prompt
        html += `<h3>完整 risk prompt</h3>`;
        const mockAnalyst = {
            thesis: stockReport.thesis,
            fitness_score: stockReport.fitness_score,
            data_freshness: "",
            key_signals: stockReport.key_signals,
            data_gaps: stockReport.data_gaps,
        };
        html += details("展开 prompt 全文", codeBlockStyled((0, shallow_analyzer_1.formatRiskPrompt)(stockData, mockAnalyst), "prompt"));
        // 决策链
        html += traceDecisionChain(stockReport, action, positionTrace);
    }
    html += SHORTCUT_PANEL;
    html += JS;
    html += `</body></html>`;
    return html;
}
//# sourceMappingURL=data-trace-report.js.map