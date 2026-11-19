import { describe, expect, it } from 'vitest';
import {
  evaluateLatencyReport,
  analyzeInteractionPaints,
  INTERACTION_BUDGETS,
  p95,
} from './interaction-latency-lib.mjs';

const id = (n: number) => `latency-12345678-1234-1234-1234-${String(n).padStart(12, '0')}`;
function fixture() {
  return {
    version: 1,
    reference: {
      machine: 'fixture-reference',
      repositoryFiles: 20_000,
      mockAgent: true,
      sandboxMode: 'stack',
      engine: 'git',
      copyOnWrite: true,
      frameBudgetMs: 1000 / 60,
    },
    dropped: 0,
    samples: Object.entries(INTERACTION_BUDGETS).flatMap(([metric, budget]) =>
      Array.from({ length: 20 }, (_, n) => ({
        metric,
        source: budget.source,
        traceId: id(n),
        outcome: 'success',
        ...(budget.source === 'concurrency-invariant'
          ? { blockedByWriter: false }
          : { durationMs: budget.ms ?? 1000 / 60 }),
      })),
    ),
  };
}

describe('interaction latency qualification', () => {
  it('uses nearest-rank p95 and refuses invalid measurements', () => {
    expect(p95(Array.from({ length: 20 }, (_, n) => n + 1))).toBe(19);
    for (const values of [[], [NaN], [-1], [Infinity]]) expect(() => p95(values)).toThrow();
  });

  it('requires every budget, sample coverage, and the reference prerequisites', () => {
    expect(evaluateLatencyReport(fixture()).qualified).toBe(true);
    for (const metric of Object.keys(INTERACTION_BUDGETS)) {
      const report = fixture();
      report.samples = report.samples.filter((s) => s.metric !== metric);
      expect(evaluateLatencyReport(report).qualified).toBe(false);
    }
    const report = fixture();
    report.reference.repositoryFiles = 19_999;
    expect(evaluateLatencyReport(report).qualified).toBe(false);
    report.reference.repositoryFiles = 20_000;
    report.dropped = 1;
    expect(evaluateLatencyReport(report).qualified).toBe(false);
  });

  it('does not turn duplicate, failed, nonfinite, or DOM-ready-only spans into passes', () => {
    for (const patch of [
      { traceId: id(1) },
      { outcome: 'error' },
      { durationMs: NaN },
      { source: 'interaction-ready' },
    ]) {
      const report = fixture();
      Object.assign(report.samples[0], patch);
      expect(evaluateLatencyReport(report).qualified).toBe(false);
    }
    const report = fixture();
    for (const sample of report.samples.filter((s) => s.metric === 'workspace-changes'))
      sample.durationMs = 101;
    expect(evaluateLatencyReport(report).qualified).toBe(false);
  });

  it('requires a Paint on the marked thread after DOM readiness and before the next interaction', () => {
    const mark = (name: string, ts: number, n = 0) => ({
      name,
      ts,
      pid: 1,
      tid: 2,
      args: { data: { detail: JSON.stringify({ traceId: id(n), metric: 'workspace-changes' }) } },
    });
    const start = mark('intent.latency.interaction-start', 1000);
    const ready = mark('intent.latency.interaction-ready', 4000);
    const paint = {
      name: 'Paint',
      ph: 'X',
      cat: 'devtools.timeline',
      ts: 5000,
      dur: 2000,
      pid: 1,
      tid: 2,
    };
    expect(analyzeInteractionPaints([start, ready])).toEqual({ samples: [], unmatched: 1 });
    expect(analyzeInteractionPaints([start, ready, { ...paint, tid: 3 }])).toEqual({
      samples: [],
      unmatched: 1,
    });
    expect(
      analyzeInteractionPaints([start, ready, { ...paint, cat: 'blink.user_timing' }]),
    ).toEqual({ samples: [], unmatched: 1 });
    expect(analyzeInteractionPaints([start, ready, paint])).toEqual({
      unmatched: 0,
      samples: [
        {
          traceId: id(0),
          metric: 'workspace-changes',
          source: 'cdp-paint',
          durationMs: 6,
          outcome: 'success',
        },
      ],
    });
    expect(
      analyzeInteractionPaints([
        start,
        ready,
        mark('intent.latency.interaction-start', 4500, 1),
        paint,
      ]),
    ).toEqual({ samples: [], unmatched: 2 });
  });
});
