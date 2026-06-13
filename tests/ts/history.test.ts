import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listReports } from '../../src/dashboard-api';
import { normalizeDirection, filterReports, formatHistoryCards } from '../../src/history-format';
import type { ReportSummary } from '../../src/dashboard-api';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';

describe('ReportSummary.reasoning field', () => {
  const tmpDir = join(process.cwd(), 'test-tmp-history');

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('listReports exposes final.reasoning on the summary', async () => {
    const tickerDir = join(tmpDir, '600519');
    await mkdir(tickerDir, { recursive: true });
    const report = {
      id: '600519_2026-06-13_full',
      ticker: '600519',
      company_name: '贵州茅台',
      date: '2026-06-13',
      mode: 'full',
      created_at: '2026-06-13T10:00:00Z',
      duration_ms: 180000,
      total_tokens: 12000,
      total_cost_usd: 0.12,
      final: { direction: 'Buy', confidence: 0.78, reasoning: '高端消费复苏，量价齐升' },
      analyst_verdicts: {},
      trace_count: 16,
    };
    await writeFile(join(tickerDir, '2026-06-13_full.json'), JSON.stringify(report), 'utf-8');

    const result = listReports(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].reasoning).toBe('高端消费复苏，量价齐升');
  });
});

function makeSummary(over: Partial<ReportSummary> = {}): ReportSummary {
  return {
    id: 'x', ticker: '600519', company_name: '贵州茅台', date: '2026-06-13',
    mode: 'full', created_at: '', duration_ms: 0, total_tokens: 0, total_cost_usd: 0,
    direction: 'Buy', confidence: 0.5, analyst_verdicts: {}, trace_count: 0, provenance: [],
    ...over,
  };
}

describe('normalizeDirection', () => {
  it('maps English canonical forms', () => {
    expect(normalizeDirection('Buy')).toBe('Buy');
    expect(normalizeDirection('SELL')).toBe('Sell');
    expect(normalizeDirection('hold')).toBe('Hold');
  });
  it('maps analyst Chinese forms', () => {
    expect(normalizeDirection('看多')).toBe('Buy');
    expect(normalizeDirection('看空')).toBe('Sell');
    expect(normalizeDirection('中性')).toBe('Hold');
  });
  it('maps PM/Research forms (Overweight/Underweight)', () => {
    expect(normalizeDirection('Overweight')).toBe('Buy');
    expect(normalizeDirection('underweight')).toBe('Sell');
  });
  it('maps bare 多/空 and 观望', () => {
    expect(normalizeDirection('多')).toBe('Buy');
    expect(normalizeDirection('空')).toBe('Sell');
    expect(normalizeDirection('观望')).toBe('Hold');
  });
  it('returns null for unrecognized / empty / undefined', () => {
    expect(normalizeDirection('foo')).toBeNull();
    expect(normalizeDirection('')).toBeNull();
    expect(normalizeDirection(undefined)).toBeNull();
  });
});

describe('filterReports', () => {
  const sample: ReportSummary[] = [
    makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-13', mode: 'full', direction: 'Buy', confidence: 0.78 }),
    makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-10', mode: 'quick', direction: 'Hold', confidence: 0.52 }),
    makeSummary({ ticker: '000001', company_name: '平安银行', date: '2026-06-12', mode: 'quick', direction: 'Sell', confidence: 0.65 }),
  ];

  it('filters by ticker', () => {
    const r = filterReports(sample, { ticker: '600519' });
    expect(r).toHaveLength(2);
    expect(r.every(x => x.ticker === '600519')).toBe(true);
  });

  it('filters by direction with Chinese normalization', () => {
    const r = filterReports(sample, { direction: '看多' });
    expect(r).toHaveLength(1);
    expect(r[0].direction).toBe('Buy');
  });

  it('direction "Buy" and "overweight" both match Buy reports', () => {
    expect(filterReports(sample, { direction: 'Buy' })).toHaveLength(1);
    expect(filterReports(sample, { direction: 'overweight' })).toHaveLength(1);
  });

  it('filters by mode', () => {
    const r = filterReports(sample, { mode: 'quick' });
    expect(r).toHaveLength(2);
    expect(r.every(x => x.mode === 'quick')).toBe(true);
  });

  it('filters by date range (inclusive)', () => {
    const r = filterReports(sample, { date_from: '2026-06-10', date_to: '2026-06-12' });
    expect(r.map(x => x.date).sort()).toEqual(['2026-06-10', '2026-06-12']);
  });

  it('combines filters with AND', () => {
    const r = filterReports(sample, { ticker: '600519', mode: 'quick' });
    expect(r).toHaveLength(1);
    expect(r[0].date).toBe('2026-06-10');
  });

  it('unrecognized direction returns empty (not all)', () => {
    expect(filterReports(sample, { direction: 'foo' })).toEqual([]);
  });

  it('empty input returns empty', () => {
    expect(filterReports([], { ticker: '600519' })).toEqual([]);
  });

  it('no filters returns all', () => {
    expect(filterReports(sample, {})).toHaveLength(3);
  });
});

describe('formatHistoryCards', () => {
  it('renders empty result with guidance', () => {
    const txt = formatHistoryCards([], [], {});
    expect(txt).toContain('历史报告 · 0 条');
    expect(txt).toContain('没有匹配的报告');
  });

  it('renders a card with emoji, MM-DD date, confidence, duration, cost, reasoning excerpt', () => {
    const items: ReportSummary[] = [
      makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-13', mode: 'full', direction: 'Buy', confidence: 0.78, duration_ms: 180000, total_cost_usd: 0.12, reasoning: '高端消费复苏，量价齐升，渠道反馈良好' }),
    ];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).toContain('🟢');
    expect(txt).toContain('600519 贵州茅台');
    expect(txt).toContain('06-13');        // MM-DD, not full date
    expect(txt).toContain('置信 78%');
    expect(txt).toContain('耗时 3m0s');
    expect(txt).toContain('$0.12');
    expect(txt).toContain('> 高端消费复苏'); // reasoning quote
  });

  it('truncates reasoning longer than 60 chars with …', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九'; // 71 chars
    const items: ReportSummary[] = [makeSummary({ reasoning: long, direction: 'Buy' })];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).toContain('…');
    expect(txt).toContain(`> ${long.slice(0, 60)}…`);
  });

  it('omits reasoning line entirely when reasoning missing/empty', () => {
    const items: ReportSummary[] = [makeSummary({ direction: 'Hold', reasoning: undefined })];
    const txt = formatHistoryCards(items, items, {});
    expect(txt.split('\n').some(l => l.trim() === '>')).toBe(false);
  });

  it('shows truncation hint when filtered > shown', () => {
    const items: ReportSummary[] = Array.from({ length: 23 }, (_, i) =>
      makeSummary({ ticker: '600519', date: `2026-06-${String(i + 1).padStart(2, '0')}`, direction: 'Buy' })
    );
    const shown = items.slice(0, 10);
    const txt = formatHistoryCards(items, shown, {});
    expect(txt).toContain('共 23 条');
    expect(txt).toContain('还有 13 条');
    expect(txt).toContain('trading_report');
  });

  it('no truncation hint when all shown', () => {
    const items: ReportSummary[] = [makeSummary({ direction: 'Buy' }), makeSummary({ direction: 'Sell' })];
    const txt = formatHistoryCards(items, items, {});
    expect(txt).not.toContain('还有');
    expect(txt).toContain('trading_report');
  });

  it('title shows company name when filtered by ticker', () => {
    const items: ReportSummary[] = [
      makeSummary({ ticker: '600519', company_name: '贵州茅台', date: '2026-06-13', direction: 'Buy' }),
    ];
    const txt = formatHistoryCards(items, items, { ticker: '600519' });
    expect(txt).toContain('已按 贵州茅台 过滤');
  });

  it('title falls back to ticker code when company_name missing', () => {
    const items: ReportSummary[] = [
      makeSummary({ ticker: '600519', company_name: '', date: '2026-06-13', direction: 'Buy' }),
    ];
    const txt = formatHistoryCards(items, items, { ticker: '600519' });
    expect(txt).toContain('已按 600519 过滤');
  });
});