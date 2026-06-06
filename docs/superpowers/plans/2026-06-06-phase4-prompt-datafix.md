# Phase 4: Prompt VERDICT Fix + policy.py Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix VERDICT format in all 14 prompt templates so weak models output correct single-value directions, and implement the missing `policy.py` data script.

**Architecture:** Replace ambiguous `<!-- VERDICT: {"direction": "看多|看空|中性"} -->` with explicit single-value instructions + format examples. Create `policy.py` using Eastmoney datacenter + CLS API following existing script patterns.

**Tech Stack:** Markdown prompts, Python 3 (requests), Eastmoney/CLS APIs

---

### Task 1: Fix 7 analyst prompt VERDICT sections

**Files:**
- Modify: `skills/trading-analysis/prompts/analysts/market.md`
- Modify: `skills/trading-analysis/prompts/analysts/fundamentals.md`
- Modify: `skills/trading-analysis/prompts/analysts/news.md`
- Modify: `skills/trading-analysis/prompts/analysts/sentiment.md`
- Modify: `skills/trading-analysis/prompts/analysts/policy.md`
- Modify: `skills/trading-analysis/prompts/analysts/hot_money.md`
- Modify: `skills/trading-analysis/prompts/analysts/lockup.md`

- [ ] **Step 1: Fix market.md VERDICT section**

Find the existing VERDICT section at the bottom of `skills/trading-analysis/prompts/analysts/market.md`:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论：

```html
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

其中 `direction` 必须是以下三个值之一：
- `看多`：预期股价上涨
- `看空`：预期股价下跌
- `中性`：预期股价震荡或趋势不明
```

Replace it with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "均线多头排列，量价配合良好"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "跌破关键支撑位，量能萎缩"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "多空信号交织，方向不明"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 2: Fix fundamentals.md VERDICT section**

Find:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论：

<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "PE过高，盈利增速放缓"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "估值合理但增长动力不足"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 3: Fix news.md VERDICT section**

Find:

```markdown
## 机器可读结论

<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "利好政策频出，业绩超预期"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "负面新闻集中，监管风险上升"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "消息面多空交织"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 4: Fix sentiment.md VERDICT section**

Find:

```markdown
## 机器可读结论

<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "市场情绪偏乐观，热度上升"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "恐慌情绪蔓延，热度骤降"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "情绪平稳，无明显方向"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 5: Fix policy.md VERDICT section**

Find:

```markdown
## 机器可读结论

<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "行业扶持政策密集出台"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "监管收紧信号明显"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "近期无重大政策变化"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 6: Fix hot_money.md VERDICT section**

Find:

```markdown
## 机器可读结论

<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "北向资金持续净流入，主力吸筹"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "主力资金大幅净流出"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "资金面平稳，无明显方向"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 7: Fix lockup.md VERDICT section**

Find:

```markdown
## 机器可读结论

<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "无解禁压力，大股东增持"} -->

正确示例：
<!-- VERDICT: {"direction": "看空", "reason": "大额解禁临近，减持压力大"} -->

正确示例：
<!-- VERDICT: {"direction": "中性", "reason": "解禁规模小，影响有限"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

- [ ] **Step 8: Commit analyst prompt fixes**

```bash
git add skills/trading-analysis/prompts/analysts/
git commit -m "fix: remove ambiguous multi-choice VERDICT in 7 analyst prompts"
```

---

### Task 2: Fix portfolio_manager.md VERDICT section

**Files:**
- Modify: `skills/trading-analysis/prompts/portfolio_manager.md`

- [ ] **Step 1: Fix portfolio_manager.md VERDICT section**

Find:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论：

```html
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "简洁的一句话理由"} -->
```

其中 `direction` 必须是以下五个值之一：
- `Buy`：强烈推荐买入
- `Overweight`：跑赢大盘，增持
- `Hold`：持有观望
- `Underweight`：跑输大盘，减持
- `Sell`：建议卖出
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "Buy", "reason": "多指标共振看多，风险可控"} -->

正确示例：
<!-- VERDICT: {"direction": "Overweight", "reason": "基本面优秀，适度超配"} -->

正确示例：
<!-- VERDICT: {"direction": "Hold", "reason": "多空均衡，维持现有仓位"} -->

正确示例：
<!-- VERDICT: {"direction": "Underweight", "reason": "风险上升，降低配置"} -->

正确示例：
<!-- VERDICT: {"direction": "Sell", "reason": "技术破位，建议清仓"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "..."} -->
```

- [ ] **Step 2: Commit**

```bash
git add skills/trading-analysis/prompts/portfolio_manager.md
git commit -m "fix: remove ambiguous multi-choice VERDICT in portfolio_manager prompt"
```

---

### Task 3: Fix 6 debate prompt VERDICT sections

**Files:**
- Modify: `skills/trading-analysis/prompts/debate/bull_researcher.md`
- Modify: `skills/trading-analysis/prompts/debate/bear_researcher.md`
- Modify: `skills/trading-analysis/prompts/debate/research_manager.md`
- Modify: `skills/trading-analysis/prompts/debate/trader.md`
- Modify: `skills/trading-analysis/prompts/debate/risk_debater.md`
- Modify: `skills/trading-analysis/prompts/debate/risk_manager.md`

- [ ] **Step 1: Fix bull_researcher.md VERDICT section**

Find:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式：

```html
<!-- VERDICT: {"direction": "看多", "reason": "不超过20字的核心看多理由"} -->
```
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式。direction 固定为"看多"。

<!-- VERDICT: {"direction": "看多", "reason": "一句话核心看多理由"} -->
```

- [ ] **Step 2: Fix bear_researcher.md VERDICT section**

Find:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式：

```html
<!-- VERDICT: {"direction": "看空", "reason": "不超过20字的核心看空理由"} -->
```
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式。direction 固定为"看空"。

<!-- VERDICT: {"direction": "看空", "reason": "一句话核心看空理由"} -->
```

- [ ] **Step 3: Fix research_manager.md VERDICT section**

Find:

```markdown
## 机器可读结论

```html
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "不超过20字的核心结论"} -->
```
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "Buy", "reason": "多头论据充分，风险可控"} -->

正确示例：
<!-- VERDICT: {"direction": "Hold", "reason": "多空均衡，方向不明"} -->

正确示例：
<!-- VERDICT: {"direction": "Sell", "reason": "空头论据充分，风险显著"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "..."} -->
```

- [ ] **Step 4: Fix trader.md VERDICT section**

Find:

```markdown
## 机器可读结论

```html
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "不超过20字的核心结论"} -->
```
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "Buy", "reason": "建议买入建仓"} -->

正确示例：
<!-- VERDICT: {"direction": "Hold", "reason": "维持现有仓位"} -->

正确示例：
<!-- VERDICT: {"direction": "Sell", "reason": "建议卖出清仓"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "..."} -->
```

- [ ] **Step 5: Fix risk_debater.md VERDICT section**

Find:

```markdown
## 机器可读结论

```html
<!-- VERDICT: {"direction": "pass|revise|reject", "reason": "不超过20字的风险评估结论"} -->
```
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "pass", "reason": "风险可控，计划可执行"} -->

正确示例：
<!-- VERDICT: {"direction": "revise", "reason": "仓位偏高，建议降低"} -->

正确示例：
<!-- VERDICT: {"direction": "reject", "reason": "存在重大风险，建议暂缓"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "pass|revise|reject", "reason": "..."} -->
```

- [ ] **Step 6: Fix risk_manager.md VERDICT section**

Find:

```markdown
## 机器可读结论

```html
<!-- VERDICT: {"direction": "pass|revise|reject", "reason": "不超过20字的风控结论"} -->
```
```

Replace with:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "pass", "reason": "综合风险可控"} -->

正确示例：
<!-- VERDICT: {"direction": "revise", "reason": "需降低仓位并调整止损"} -->

正确示例：
<!-- VERDICT: {"direction": "reject", "reason": "发现重大风险"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "pass|revise|reject", "reason": "..."} -->
```

- [ ] **Step 7: Commit debate prompt fixes**

```bash
git add skills/trading-analysis/prompts/debate/
git commit -m "fix: remove ambiguous multi-choice VERDICT in 6 debate prompts"
```

---

### Task 4: Create policy.py data script

**Files:**
- Create: `skills/trading-policy/scripts/policy.py`
- Create: `skills/trading-policy/SKILL.md` (minimal)

- [ ] **Step 1: Create policy.py**

Create `skills/trading-policy/scripts/policy.py`:

```python
#!/usr/bin/env python3
"""Fetch A-share policy events relevant to a given stock."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_policy_eastmoney(code, lookback_days=30):
    """Fetch policy-related news from Eastmoney datacenter."""
    from datetime import datetime, timedelta
    articles = []
    try:
        url = "https://search-api-web.eastmoney.com/search/jsonp"
        inner_param = {
            "uid": "",
            "keyword": code,
            "type": ["cmsArticleWebOld"],
            "client": "web",
            "clientType": "web",
            "clientVersion": "curr",
            "param": {
                "cmsArticleWebOld": {
                    "searchScope": "default",
                    "sort": "default",
                    "pageIndex": 1,
                    "pageSize": 30,
                    "preTag": "",
                    "postTag": "",
                }
            },
        }
        params = {
            "cb": "callback",
            "param": json.dumps(inner_param, ensure_ascii=False),
            "_": "1",
        }
        headers = {
            "Referer": "https://so.eastmoney.com/",
            "User-Agent": _UA,
        }
        resp = em_get(url, params=params, headers=headers, timeout=15)
        text = resp.text
        text = text[text.index("(") + 1: text.rindex(")")]
        data = json.loads(text)
        cutoff = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
        for item in data.get("result", {}).get("cmsArticleWebOld", []):
            date_str = item.get("date", "")[:10]
            if date_str >= cutoff:
                title = item.get("title", "")
                content = (item.get("content", "") or "")[:300]
                articles.append({
                    "date": date_str,
                    "title": title,
                    "content": content,
                    "source": item.get("mediaName", "东方财富"),
                })
    except Exception:
        pass
    return articles


def _fetch_macro_policy_cls(limit=20):
    """Fetch macro policy telegrams from CLS (财联社)."""
    import requests
    articles = []
    try:
        url = "https://www.cls.cn/nodeapi/telegraphList"
        params = {"rn": str(limit), "page": "1"}
        headers = {"User-Agent": _UA, "Referer": "https://www.cls.cn/"}
        r = requests.get(url, params=params, headers=headers, timeout=10)
        d = r.json()
        for item in d.get("data", {}).get("roll_data", []):
            title = item.get("title", "") or item.get("brief", "")
            content = item.get("content", "") or item.get("brief", "")
            ctime = item.get("ctime", "")
            pub_time = ""
            if ctime:
                try:
                    pub_time = datetime.fromtimestamp(int(ctime)).strftime("%Y-%m-%d %H:%M")
                except (ValueError, TypeError, OSError):
                    pub_time = str(ctime)
            articles.append({
                "date": pub_time[:10] if pub_time else "",
                "title": title,
                "content": content[:300],
                "source": "财联社",
            })
    except Exception:
        pass
    return articles


def fetch_policy(ticker, date, lookback_days=30):
    """Fetch policy events for a given stock."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    try:
        data["stock_policy_news"] = _fetch_policy_eastmoney(code, lookback_days)
    except Exception as e:
        data["stock_policy_error"] = str(e)

    try:
        data["macro_policy_news"] = _fetch_macro_policy_cls()
    except Exception as e:
        data["macro_policy_error"] = str(e)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch policy events for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=30, help="Days to look back")
    args = parser.parse_args()

    try:
        data = fetch_policy(args.ticker, args.date, args.lookback_days)
        output_json(True, data=data, source="eastmoney+cls")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test policy.py directly**

Run: `python3 skills/trading-policy/scripts/policy.py --ticker 600519 --date 2026-06-05`
Expected: JSON output with `success: true` and `stock_policy_news` + `macro_policy_news` arrays.

- [ ] **Step 3: Create SKILL.md**

Create `skills/trading-policy/SKILL.md`:

```markdown
# trading-policy

Fetch A-share policy events relevant to a given stock.

## Scripts

- `scripts/policy.py` — Fetches policy-related news from Eastmoney search API + CLS macro telegrams.

### Usage

```bash
python3 scripts/policy.py --ticker 600519 --date 2026-06-05 --lookback-days 30
```
```

- [ ] **Step 4: Commit policy.py**

```bash
git add skills/trading-policy/
git commit -m "feat: add policy.py data script for A-share policy events"
```

---

### Task 5: Verify build + tests pass

**Files:** None (verification only)

- [ ] **Step 1: Run build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: 41/41 tests pass.

- [ ] **Step 3: Commit any fixes if needed**

Only if tests fail — fix and commit.
