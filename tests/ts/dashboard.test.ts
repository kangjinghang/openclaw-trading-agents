// tests/ts/dashboard.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { listReports, readReport, readDetail, readTracesByTickerDate, readDataSources } from '../../src/dashboard-api';
import { startServer, parseDashboardArgs } from '../../src/dashboard';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';

describe('dashboard-api', () => {
  const tmpReportDir = join(process.cwd(), 'test-tmp-dashboard');

  beforeEach(async () => {
    await mkdir(tmpReportDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpReportDir, { recursive: true, force: true });
  });

  it('listReports returns empty array for non-existent dir', () => {
    const result = listReports('/nonexistent/path');
    expect(result).toEqual([]);
  });

  it('listReports scans and returns report summaries', async () => {
    const tickerDir = join(tmpReportDir, '600519');
    await mkdir(tickerDir, { recursive: true });

    const report = {
      id: '600519_2026-06-05_quick',
      ticker: '600519',
      company_name: '贵州茅台',
      date: '2026-06-05',
      mode: 'quick',
      created_at: '2026-06-05T10:00:00Z',
      duration_ms: 5000,
      total_tokens: 6000,
      total_cost_usd: 0.03,
      final: { direction: 'Buy', confidence: 0.75 },
      analyst_verdicts: {
        market: { direction: '看多', reason: 'bullish' },
      },
      trace_count: 8,
    };

    await writeFile(join(tickerDir, '2026-06-05_quick.json'), JSON.stringify(report), 'utf-8');

    const result = listReports(tmpReportDir);
    expect(result).toHaveLength(1);
    expect(result[0].ticker).toBe('600519');
    expect(result[0].direction).toBe('Buy');
    expect(result[0].confidence).toBe(0.75);
  });

  it('listReports sorts by date descending', async () => {
    const tickerDir = join(tmpReportDir, '600519');
    await mkdir(tickerDir, { recursive: true });

    for (const date of ['2026-06-03', '2026-06-05', '2026-06-04']) {
      const report = {
        id: `600519_${date}_quick`,
        ticker: '600519',
        company_name: '',
        date,
        mode: 'quick',
        created_at: `${date}T10:00:00Z`,
        final: { direction: 'Hold', confidence: 0.5 },
        analyst_verdicts: {},
      };
      await writeFile(join(tickerDir, `${date}_quick.json`), JSON.stringify(report), 'utf-8');
    }

    const result = listReports(tmpReportDir);
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2026-06-05');
    expect(result[1].date).toBe('2026-06-04');
    expect(result[2].date).toBe('2026-06-03');
  });

  it('readReport returns parsed JSON for existing report', async () => {
    const tickerDir = join(tmpReportDir, '600519');
    await mkdir(tickerDir, { recursive: true });
    const report = { id: '600519_2026-06-05_quick', ticker: '600519' };
    await writeFile(join(tickerDir, '2026-06-05_quick.json'), JSON.stringify(report), 'utf-8');

    const result = readReport(tmpReportDir, '600519', '2026-06-05_quick');
    expect(result).toBeTruthy();
    expect(result.ticker).toBe('600519');
  });

  it('readReport returns null for non-existent report', () => {
    const result = readReport(tmpReportDir, '999999', '2026-01-01_quick');
    expect(result).toBeNull();
  });

  it('readDetail returns detail file content', async () => {
    const detailDir = join(tmpReportDir, '600519', '2026-06-05_full', '01_analysts');
    await mkdir(detailDir, { recursive: true });
    const analyst = { role: 'market', verdict: { direction: '看多', reason: 'test' } };
    await writeFile(join(detailDir, 'market.json'), JSON.stringify(analyst), 'utf-8');

    const result = readDetail(tmpReportDir, '600519', '2026-06-05_full', '01_analysts/market.json');
    expect(result).toBeTruthy();
    expect(result.role).toBe('market');
  });

  it('readDetail blocks path traversal', () => {
    const result = readDetail(tmpReportDir, '../../etc', '2026-06-05_full', 'passwd');
    expect(result).toBeNull();
  });

  it('readTracesByTickerDate returns traces from report dir', async () => {
    const tracesDir = join(tmpReportDir, '600519', '2026-06-05_quick', '02_traces');
    await mkdir(tracesDir, { recursive: true });
    const trace = {
      trace_id: 'trace-test-1',
      run_id: 'run-1',
      call_index: 1,
      phase: 'analyst',
      role: 'market',
      request: { model: 'gpt-4o' },
      response: { raw_content: 'test' },
      meta: { duration_ms: 1000, usage: { total_tokens: 500 }, cost_usd: 0.01 },
    };
    await writeFile(join(tracesDir, 'trace-test-1.json'), JSON.stringify(trace), 'utf-8');

    const result = readTracesByTickerDate(tmpReportDir, '600519', '2026-06-05');
    expect(result).toHaveLength(1);
    expect(result[0].trace_id).toBe('trace-test-1');
  });

  it('readDataSources returns raw data from report dir', async () => {
    const dataDir = join(tmpReportDir, '600519', '2026-06-05_quick', '03_data');
    await mkdir(dataDir, { recursive: true });
    const rawData = { success: true, data: { ticker: '600519', count: 120 }, _source: 'mootdx' };
    await writeFile(join(dataDir, 'market_raw.json'), JSON.stringify(rawData), 'utf-8');

    const result = readDataSources(tmpReportDir, '600519', '2026-06-05_quick');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('market');
    expect(result[0].success).toBe(true);
    expect(result[0]._source).toBe('mootdx');
  });

  it('readDataSources returns empty for non-existent dir', () => {
    const result = readDataSources(tmpReportDir, '999999', '2026-01-01_quick');
    expect(result).toEqual([]);
  });
});

describe('parseDashboardArgs', () => {
  it('returns defaults with no args', () => {
    const result = parseDashboardArgs([]);
    expect(result.port).toBe(3210);
    // Auto-detects local trading-reports/ or falls back to ~/.openclaw
    expect(result.reportDir).toContain('trading-reports');
  });

  it('parses --port', () => {
    const result = parseDashboardArgs(['--port', '8080']);
    expect(result.port).toBe(8080);
  });

  it('parses --report-dir', () => {
    const result = parseDashboardArgs(['--report-dir', './my-reports']);
    expect(result.reportDir).toBe('./my-reports');
  });
});

describe('dashboard HTTP server', () => {
  const tmpReportDir = join(process.cwd(), 'test-tmp-dash-http');
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    await mkdir(tmpReportDir, { recursive: true });
    // Use a random available port
    server = startServer(tmpReportDir, 0);
    await new Promise<void>(resolve => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    server.close();
    await rm(tmpReportDir, { recursive: true, force: true });
  });

  function fetch(path: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}${path}`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      }).on('error', reject);
    });
  }

  it('GET /api/reports returns empty array', async () => {
    const { status, body } = await fetch('/api/reports');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET /api/reports returns reports', async () => {
    const tickerDir = join(tmpReportDir, '600519');
    await mkdir(tickerDir, { recursive: true });
    const report = {
      id: '600519_2026-06-05_quick',
      ticker: '600519',
      company_name: '',
      date: '2026-06-05',
      mode: 'quick',
      created_at: '2026-06-05T10:00:00Z',
      duration_ms: 1000,
      total_tokens: 100,
      total_cost_usd: 0.01,
      final: { direction: 'Buy', confidence: 0.8 },
      analyst_verdicts: {},
    };
    await writeFile(join(tickerDir, '2026-06-05_quick.json'), JSON.stringify(report), 'utf-8');

    const { status, body } = await fetch('/api/reports');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].ticker).toBe('600519');
    expect(body[0].direction).toBe('Buy');
  });

  it('GET / serves index.html', async () => {
    const { status, body } = await fetch('/');
    expect(status).toBe(200);
    expect(typeof body).toBe('string');
    expect(body).toContain('OpenClaw Trading Agents');
  });

  it('GET /api/traces without params returns empty array', async () => {
    const { status, body } = await fetch('/api/traces');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET /api/data returns data sources', async () => {
    const dataDir = join(tmpReportDir, '600519', '2026-06-05_quick', '03_data');
    await mkdir(dataDir, { recursive: true });
    const rawData = { success: true, data: { ticker: '600519' }, _source: 'mootdx' };
    await writeFile(join(dataDir, 'market_raw.json'), JSON.stringify(rawData), 'utf-8');

    const { status, body } = await fetch('/api/data/600519/2026-06-05_quick');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].role).toBe('market');
  });

  it('GET unknown path returns 404', async () => {
    const { status } = await fetch('/api/nonexistent');
    expect(status).toBe(404);
  });
});
