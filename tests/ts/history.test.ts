import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listReports } from '../../src/dashboard-api';
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