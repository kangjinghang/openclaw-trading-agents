# OpenClaw Trading Agents

多角色 A 股分析插件 —— 基于 OpenClaw 的多智能体辩论式股票分析系统

## 项目简介

OpenClaw Trading Agents 是一个独立的 OpenClaw 插件，通过多智能体协作机制实现 A 股市场的深度分析。系统采用"市场分析师 + 投资组合经理"的双层架构，通过辩论式决策生成高质量的交易建议。

### 核心特性

- **多智能体协作**：模拟真实投资团队的分析决策流程
- **辩论式决策**：通过多轮辩论提高决策质量
- **数据源自动切换**：mootdx 主数据源 + akshare 备份源
- **报告持久化**：自动保存分析报告，支持溯源审计
- **LLM 可追溯性**：记录每条 LLM 输出的生成来源

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/kangjinghang/openclaw-trading-agents.git
cd openclaw-trading-agents
```

### 2. 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 安装 Python 依赖
./scripts/setup-python.sh
```

### 3. 构建插件

```bash
npm run build
```

### 4. 安装到 OpenClaw

```bash
# 在项目根目录执行
openclaw plugins install --link .
```

### 5. 配置插件

```bash
# 复制示例配置
cp config/openclaw.example.json ~/.openclaw/plugins/trading-agents/config.json

# 根据需要修改配置文件
vim ~/.openclaw/plugins/trading-agents/config.json
```

## 使用方法

### 快速分析

```bash
# 分析贵州茅台（600519）
/quick 600519

# 分析平安银行（000001）
/quick 000001
```

### 生成交易报告

```bash
# 生成指定日期的交易报告
/trading_report 600519 2026-06-05

# 生成当前日期的交易报告
/trading_report 600519
```

### 查看历史报告

报告默认保存在 `~/.openclaw/trading-reports/` 目录：

```bash
# 查看报告列表
ls ~/.openclaw/trading-reports/

# 查看特定报告
cat ~/.openclaw/trading-reports/600519_2026-06-05.json
```

## 系统架构

```
用户输入 → Plugin (trading_quick tool)
  ↓
Python 脚本获取 K 线数据 (mootdx/akshare)
  ↓
市场分析师 prompt + 数据 → LLM
  ↓
投资组合经理 prompt + 分析师报告 → LLM
  ↓
结构化交易决策
  ↓
报告持久化 + LLM 溯源
```

### 组件说明

1. **Plugin Entry Point** (`src/index.ts`)
   - OpenClaw 插件主入口
   - 注册 trading_quick 和 trading_report 工具

2. **Python 集成** (`src/exec-python.ts`)
   - 调用 Python 脚本获取 K 线数据
   - 处理数据源自动切换

3. **多智能体编排** (`src/orchestrator.ts`)
   - 协调市场分析师和投资组合经理
   - 管理辩论轮次

4. **LLM 客户端** (`src/llm-client.ts`)
   - 统一的 LLM 调用接口
   - 支持多种模型配置

5. **报告存储** (`src/report-store.ts`)
   - 持久化分析报告
   - 支持历史查询

## 数据源

| 数据源 | 用途 | 状态 | 依赖 |
|--------|------|------|------|
| **mootdx** | K 线数据（主） | 默认启用 | `mootdx>=0.5.7` |
| **akshare** | K 翻译（备） | 自动回退 | `akshare>=1.15` |

### 数据源切换逻辑

1. 优先使用 mootdx（通达信 TCP 协议）
2. mootdx 失败时自动切换到 akshare（新浪财经 HTTP）
3. 两者都失败时返回错误提示

## 报告格式

### 报告结构

```json
{
  "ticker": "600519",
  "date": "2026-06-05",
  "analyst_reports": [
    {
      "role": "市场分析师 - 技术面",
      "analysis": "...",
      "trace": {
        "model": "gpt-4",
        "prompt_template": "market_analyst_technical.md",
        "timestamp": "2026-06-05T10:30:00Z"
      }
    },
    {
      "role": "市场分析师 - 基本面",
      "analysis": "...",
      "trace": { ... }
    }
  ],
  "portfolio_decision": {
    "action": "HOLD",
    "confidence": 0.75,
    "reasoning": "...",
    "trace": {
      "model": "gpt-4",
      "prompt_template": "portfolio_manager.md",
      "timestamp": "2026-06-05T10:32:00Z"
    }
  },
  "metadata": {
    "debate_rounds": 2,
    "data_source": "mootdx",
    "created_at": "2026-06-05T10:32:15Z"
  }
}
```

### LLM 溯源信息

每条 LLM 输出都包含 `trace` 字段，记录：
- `model`: 使用的模型名称
- `prompt_template`: 使用的提示模板
- `timestamp`: 生成时间

## 开发指南

### 构建项目

```bash
npm run build
```

### 运行测试

```bash
# 运行所有测试
npm test

# 监听模式（开发时使用）
npm run test:watch
```

### 项目结构

```
openclaw-trading-agents/
├── src/                    # TypeScript 源码
│   ├── index.ts           # 插件入口
│   ├── exec-python.ts     # Python 脚本执行器
│   ├── llm-client.ts      # LLM 客户端
│   ├── orchestrator.ts    # 多智能体编排
│   ├── prompt-loader.ts   # 提示模板加载器
│   ├── report-store.ts    # 报告存储
│   ├── trace-logger.ts    # LLM 溯源日志
│   └── types.ts           # 类型定义
├── skills/                # OpenClaw 技能定义
│   ├── trading-kline/     # K 线数据获取
│   └── trading-analysis/  # 多智能体分析
├── scripts/               # 构建和部署脚本
│   └── setup-python.sh    # Python 依赖安装
├── tests/                 # 测试文件
├── config/                # 配置示例
├── dist/                  # 编译输出
├── package.json
├── tsconfig.json
├── openclaw.plugin.json
└── README.md
```

## 配置说明

### 插件配置 (`~/.openclaw/plugins/trading-agents/config.json`)

```json
{
  "models": {
    "analyst": "gpt-4",
    "portfolio_manager": "gpt-4"
  },
  "debate_rounds": 2,
  "risk_debate_rounds": 1,
  "max_risk_retries": 1,
  "report_dir": "~/.openclaw/trading-reports"
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `models` | object | `{}` | LLM 模型配置 |
| `debate_rounds` | number | `2` | 常规辩论轮次 |
| `risk_debate_rounds` | number | `1` | 风险评估辩论轮次 |
| `max_risk_retries` | number | `1` | 风险评估最大重试次数 |
| `report_dir` | string | `~/.openclaw/trading-reports` | 报告保存目录 |

## 许可证

MIT License

## 贡献指南

欢迎提交 Issue 和 Pull Request！

## 相关资源

- [OpenClaw 文档](https://github.com/openclaw/openclaw)
- [mootdx 文档](https://github.com/0h1x/mootdx)
- [akshare 文档](https://github.com/akfamily/akshare)

## 更新日志

### v0.1.0 (2026-06-05)
- 初始版本发布
- 支持多智能体分析
- 支持报告持久化
- 支持 LLM 溯源
