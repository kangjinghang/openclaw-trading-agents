---
name: trading-agents-integration-plan
description: 将 TradingAgents A股多Agent交易系统集成到 Hermes Agent 的实施计划和架构决策
metadata: 
  node_type: memory
  type: project
  originSessionId: f36c9da1-8803-4179-9553-2d45dc89fe53
---

# Hermes Agent + TradingAgents A 股集成计划

## 背景

用户主要关注 A 股市场，希望将 TradingAgents 的多 Agent 辩论交易架构集成到 Hermes Agent 中，利用 Hermes 的多平台交互能力（Telegram/Slack/钉钉）。

## 核心洞察

TradingAgents 项目群的最大价值是 **Prompt（领域知识）+ 数据源（基础设施）**。其余一切（Web后端/调度/通知/用户管理）Hermes 已有。

参考了 4 个 A 股项目：
- TradingAgents-astock：7 分析师（含政策/游资/解禁），最全免费数据源
- TradingAgents-AShare：博弈论经理，Claim-based 辩论，FastAPI+React
- TradingAgents-CN：企业级，多租户，MongoDB+Redis
- PanWatch：实时监控，多模态K线分析

详见 [[trading-agents-reference]]

## 架构决策

### 编排方式：Plugin + 内部多 Agent 编排（推荐）

原因：
1. TradingAgents 的"多 Agent"本质是多次 LLM 调用 + 不同 System Prompt，不需要为每个角色启动完整 Hermes Agent
2. 辩论机制需要"有状态的多轮对话"，delegate_task 做不到（单次任务）
3. 部署简单，单实例，利用 Hermes 已有机制

### 触发方式：手动 + Cron

- `/analyze <ticker>` 斜杠命令（Telegram/Slack/CLI）
- Cron 定时调度（每日开盘前/收盘后）

### 数据源：从 astock 提取 + 后期接入用户自有数据源

### 不需要回测，只需要实时分析

## 推荐角色组合

| 角色 | 来源 | 说明 |
|------|------|------|
| 技术分析师 | astock | A 股规则最全 |
| 新闻分析师 | astock | 政策敏感度框架 |
| 情绪分析师 | astock | 散户情绪 + 反向指标 |
| 基本面分析师 | astock | CAS 会计准则 |
| 政策分析师 | astock 独有 | "政策市"核心因子 |
| 游资追踪器 | astock 独有 | 龙虎榜/北向/主力 |
| 解禁观察员 | astock 独有 | 限售股/减持/质押 |
| 多头/空头 | AShare | Claim-based 结构化辩论 |
| 研究经理 | AShare | 含预期差分析 |
| 交易员 | astock | A 股交易约束 |
| 风险辩论三方 | astock | A 股风险框架 |
| 风控经理 | AShare 独有 | pass/revise/reject |
| 投资组合经理 | astock | 最终决策 |

## 实施路线

```
Phase 1 → Plugin + 数据源工具 + 基础分析（MVP）
Phase 2 → 加入辩论机制（Bull/Bear + Risk）
Phase 3 → 接入用户自有数据源
Phase 4 → （可选）升级为 delegate_task 真正的多 Agent
```

## 用户偏好

- 主要关注 A 股
- 有自己的数据源（后期决定集成）
- 需要同时支持手动触发和定时调度
- 不需要回测功能
- 通过 Hermes gateway（Telegram 等）交互
