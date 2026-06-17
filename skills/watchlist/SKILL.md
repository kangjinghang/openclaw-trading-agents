# Watchlist 股票池

每日扫描全市场 A 股的雪球异动数据，自动发现候选股。

## 数据流

```
universe (akshare 清单) → raw 雪球快照 → diff 新增异动 → candidates 候选清单
```

详见 `docs/superpowers/specs/2026-06-17-watchlist-stock-pool-design.md`。

## 脚本

| 脚本 | 作用 |
|------|------|
| `scan_universe.py` | akshare 全市场清单（排除北交所 + symbol 转换） |
| `snapshot.py` | 雪球异动并发扫描（滚动 14 个月窗口） |

## 数据源说明

`scan_universe.py` 实际使用 **akshare** `stock_info_a_code_name`（约 5207 只，排除北交所），而非设计文档最初指定的东方财富 clist（5533 只）。原因：实测东财 clist 频繁被限流，稳定性不足。两者相差约 326 只。东财恢复（全量 + akshare 兜底）列为后续 TODO。

## 用法

```bash
npm run scan-universe          # 刷新清单
npm run snapshot -- --date 2026-06-17
npm run diff -- --date 2026-06-17
npm run candidates -- --date 2026-06-17
npm run scan-all -- --date 2026-06-17   # 一键全流程
```
