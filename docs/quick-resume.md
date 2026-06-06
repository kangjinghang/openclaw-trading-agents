# Quick Resume Guide — 换电脑后快速恢复工作

> 本文件是换电脑后第一个看的文件。读完这个就能开始工作。

## 30 秒了解项目

我们在做什么：**一个 OpenClaw 插件，让多个 AI Agent 协作分析 A 股，通过辩论机制产出交易决策。**

核心价值 = **Prompt（领域知识）** + **数据源（基础设施）**。Prompt 和数据脚本都来自 4 个开源 TradingAgents 项目的提炼。

## 当前状态

✅ **Phase 1 (MVP)** — Plugin 入口 + K线数据 + 市场分析师/PM + 报告持久化
✅ **Phase 2 (7 分析师)** — 7 个数据技能 + 7 个分析师 Prompt + 并行编排
✅ **Phase 3 (辩论管道)** — Bull↔Bear 辩论 + Research Manager + Trader + 3 方风控辩论
✅ **Phase 4 (VERDICT 修复)** — 14 个 Prompt 格式修复 + policy.py 补齐

**50 个测试全部通过，端到端验证通过（600519 茅台，glm-4-flash）**

## 恢复开发环境

```bash
cd ~/workspace/github/openclaw-trading-agents

# 安装 JS 依赖
npm install

# 安装 Python 依赖
pip install mootdx akshare requests

# 验证一切正常
npm run build               # TypeScript 编译
npm test                    # 50 个 TS 测试
python3 skills/trading-kline/scripts/kline.py --ticker 600519 --date 2026-06-05  # 数据脚本测试
```

## 文档导航

| 文件 | 什么时候看 |
|------|-----------|
| `docs/roadmap.md` | **现在看** — 项目进度和未来规划 |
| `docs/project-overview.md` | 需要回忆项目背景、架构决策、平台选择原因时 |
| `docs/data-sources-reference.md` | 写数据脚本时 — 所有数据源的函数签名、fallback |
| `docs/prompts-reference.md` | 写 Prompt 时 — 16 个角色的完整 Prompt 设计 |
| `docs/design-spec.md` | 需要了解完整系统设计时 |
| `CLAUDE.md` | 给 Claude Code 的项目指引 — 架构、命令、关键文件 |

## 已实现的工具

| 工具 | LLM 调用数 | 说明 |
|------|-----------|------|
| `trading_quick` | 8 | 7 分析师并行 → PM 综合 |
| `trading_full` | 15+ | 7 分析师 → Bull/Bear 辩论 → Research → Trader → 风控 |
| `trading_report` | 0 | 查询已保存的报告 |

## 编码约定

- **数据脚本**：Python，统一 fallback 模式，JSON stdout
- **Plugin**：TypeScript，严格类型
- **Prompt**：Markdown 模板，`{{placeholder}}` 变量
- **VERDICT 协议**：`<!-- VERDICT: {"direction": "单值", "reason": "..."} -->`
- **测试**：TS 用 vitest，50 个测试
- **每个 Skill 是原子的** — 一个数据领域一个 Skill
- **commit message**：`feat:` / `fix:` / `docs:` / `test:` / `chore:`
