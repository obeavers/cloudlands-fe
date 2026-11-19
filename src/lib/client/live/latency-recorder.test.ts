import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginLatencyRequest } from './latency-recorder';

afterEach(() => {
  window.__INTENT_LATENCY__?.stop();
  window.__INTENT_LATENCY__?.clear();
  vi.restoreAllMocks();
});

describe('opt-in request latency recorder', () => {
  it('carries an explicit interaction root through distinct concurrent request spans', () => {
    beginLatencyRequest('workspace.list');
    const probe = window.__INTENT_LATENCY__!;
    probe.start();
    const parent = probe.beginInteraction('workspace-changes')!;
    const first = beginLatencyRequest('workspace.list', parent)!;
    const second = beginLatencyRequest('workspace.list', parent)!;
    const unrelated = beginLatencyRequest('host.status')!;
    expect(first.traceId).toMatch(new RegExp(`^${parent}\\.`));
    expect(second.traceId).toMatch(new RegExp(`^${parent}\\.`));
    expect(first.traceId).not.toBe(second.traceId);
    first.finish('success');
    second.finish('success');
    unrelated.finish('success');
    expect(probe.snapshot().samples.map((s) => s.interactionTraceId)).toEqual([
      parent,
      parent,
      undefined,
    ]);
  });
  it('collects nothing by default, and discards replies from an earlier capture', () => {
    expect(beginLatencyRequest('workspace.list')).toBeUndefined();
    const probe = window.__INTENT_LATENCY__!;
    probe.start();
    const old = beginLatencyRequest('workspace.list')!;
    probe.start();
    old.finish('success');
    expect(probe.snapshot().samples).toEqual([]);
  });

  it('records correlated durations without payloads or cross-process timestamp arithmetic', () => {
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    beginLatencyRequest('workspace.list');
    const probe = window.__INTENT_LATENCY__!;
    probe.start();
    const span = beginLatencyRequest('workspace.list')!;
    now = 30;
    span.finish('success', { traceId: span.traceId, mainDurationMs: 15, rpcDurationMs: 12 });
    expect(probe.snapshot().samples).toEqual([
      {
        traceId: span.traceId,
        phase: 'request',
        method: 'workspace.list',
        outcome: 'success',
        durationMs: 20,
      },
      {
        traceId: span.traceId,
        phase: 'main',
        method: 'workspace.list',
        outcome: 'success',
        durationMs: 15,
      },
      {
        traceId: span.traceId,
        phase: 'ipc-overhead',
        method: 'workspace.list',
        outcome: 'success',
        durationMs: 5,
      },
      {
        traceId: span.traceId,
        phase: 'rpc',
        method: 'workspace.list',
        outcome: 'success',
        durationMs: 12,
      },
    ]);
    span.finish('error');
    expect(probe.snapshot().samples).toHaveLength(4);
  });

  it('drops invalid/mismatched main timings and bounds retained samples', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1);
    beginLatencyRequest('workspace.list');
    const probe = window.__INTENT_LATENCY__!;
    probe.start();
    const first = beginLatencyRequest('workspace.list')!;
    first.finish('success', { traceId: first.traceId, mainDurationMs: 100 });
    for (let i = 0; i < 4096; i++) beginLatencyRequest('private task text')!.finish('error');
    const result = probe.snapshot();
    expect(result.samples).toHaveLength(4096);
    expect(result.dropped).toBe(2);
    expect(
      result.samples.every((s) => s.phase === 'request' && s.method === 'invalid-method'),
    ).toBe(true);
  });

  it('marks DOM readiness separately from actual paint instead of claiming a frame is painted', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    beginLatencyRequest('workspace.list');
    const probe = window.__INTENT_LATENCY__!;
    probe.start();
    const id = probe.beginInteraction('workspace-changes')!;
    now = 4;
    probe.interactionReady(id);
    probe.interactionReady(id);
    expect(probe.snapshot().samples).toEqual([
      {
        traceId: id,
        metric: 'workspace-changes',
        phase: 'interaction-ready',
        durationMs: 4,
        outcome: 'success',
      },
    ]);
  });
});
