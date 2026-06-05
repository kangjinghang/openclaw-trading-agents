# Quick Resume Guide — 换电脑后快速恢复工作

> 本文件是换电脑后第一个看的文件。读完这个就能开始工作。

## 30 秒了解项目

我们在做什么：**一个 OpenClaw 插件，让多个 AI Agent 协作分析 A 股，通过辩论机制产出交易决策。**

核心价值 = **Prompt（领域知识）** + **数据源（基础设施）**。Prompt 和数据脚本都来自 4 个开源 TradingAgents 项目的提炼。

## 当前状态

✅ **Phase 1 (MVP) 已完成** — 14 个 commits, 44 个测试全部通过

已完成：Plugin 入口 + 编排器 + K线数据技能 + 市场分析师/PM Prompt + 报告持久化 + LLM溯源

🔜 **Phase 2 是下一步** — 补全 7 个数据技能 + 6 个分析师 Prompt + 并行分析师编排

## 恢复开发环境

```bash
cd ~/workspace/github/openclaw-trading-agents

# 安装 JS 依赖
npm install

# 安装 Python 依赖
./scripts/setup-python.sh

# 验证一切正常
npx tsc                    # TypeScript 编译
npx vitest run             # 25 个 TS 测试
python3 -m pytest tests/scripts/ -v  # 19 个 Python 测试
```

## 文档导航

| 文件 | 什么时候看 |
|------|-----------|
| `docs/roadmap.md` | **现在看** — Phase 2 详细任务列表，下一步该做什么 |
| `docs/project-overview.md` | 需要回忆项目背景、架构决策、平台选择原因时 |
| `docs/data-sources-reference.md` | 写数据脚本时 — 所有数据源的函数签名、fallback、限流策略 |
| `docs/prompts-reference.md` | 写 Prompt 时 — 16 个角色的完整 Prompt 设计 |
| `docs/design-spec.md` | 需要了解完整系统设计时 — 数据交换结构、Phase间接口、报告格式 |
| `docs/phase1-plan.md` | 参考 Phase 1 的实现步骤模式（已被完成） |

## Phase 2 第一步

Phase 2 的第一个任务是创建 **trading-fundamentals** 数据技能：

1. 创建 `skills/trading-fundamentals/scripts/fundamentals.py`
   - 主源：腾讯财经 (PE/PB/总市值/季报快照)
   - 备源：mootdx F10
   - 输出 JSON：`{success: true, data: {...}, _source: "tencent"}`
2. 创建 `skills/trading-fundamentals/scripts/financials.py`
   - 主源：新浪财经 (三大报表)
   - 备源：mootdx
3. 创建 `skills/trading-fundamentals/scripts/profit_forecast.py`
   - 主源：同花顺 (机构一致预期 EPS)
   - 无 fallback（同花顺独家数据）
4. 创建 `requirements.txt`、`SKILL.md`、测试

参考 `skills/trading-kline/` 的模式（kline.py 是已完成的例子）。
参考 `docs/data-sources-reference.md` 了解具体 API 调用方式。

## 参考项目（在本地）

如果需要查看原始数据脚本的实现：

```bash
# astock 项目 — 最全的 A 股数据源实现
ls ~/workspace/github/TradingAgents-astock/tradingagents/dataflows/

# AShare 项目 — Claim-based 辩论机制
ls ~/workspace/github/TradingAgents-AShare/

# PanWatch 项目 — 实时监控 Agent
ls ~/workspace/github/PanWatch/
```

## 编码约定

- **数据脚本**：Python，统一 fallback 模式，JSON stdout
- **Plugin**：TypeScript，严格类型
- **Prompt**：Markdown 模板，`{{placeholder}}` 变量
- **测试**：TS 用 vitest，Python 用 pytest
- **每个 Skill 是原子的** — 一个数据领域一个 Skill
- **commit message**：`feat:` / `fix:` / `docs:` / `test:` / `chore:`
