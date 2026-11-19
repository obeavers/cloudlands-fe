import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBackendRequestLatency } from './request-latency';

const TRACE = 'latency-12345678-1234-1234-1234-123456789abc';
const event = {} as IpcMainInvokeEvent;

afterEach(() => vi.restoreAllMocks());

describe('IPC request timing', () => {
  it('leaves uninstrumented responses unchanged', async () => {
    const response = { ok: true, result: { secret: 'never-copy-to-timing' } };
    const handler = vi.fn(async () => response);
    const invoke = withBackendRequestLatency<{ traceId?: unknown }, typeof response>(handler);
    expect(await invoke(event, {})).toBe(response);
    expect(await invoke(event, { traceId: 'not-a-trace' })).toBe(response);
  });

  it('returns monotonic main and RPC durations as IPC metadata without changing the result', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const invoke = withBackendRequestLatency(
      async (_event, _payload: { traceId?: unknown }, trace) => {
        now = 2;
        const result = await trace!.rpc(async () => {
          now = 9;
          return { taskText: 'private' };
        });
        now = 11;
        return { ok: true, result };
      },
    );
    expect(await invoke(event, { traceId: TRACE })).toEqual({
      ok: true,
      result: { taskText: 'private' },
      latency: { traceId: TRACE, mainDurationMs: 11, rpcDurationMs: 7 },
    });
  });

  it('does not invent a daemon roundtrip for cached or specialized routes', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(5).mockReturnValueOnce(8);
    const invoke = withBackendRequestLatency(async (_event, _payload: { traceId?: unknown }) => ({
      ok: true,
    }));
    expect(await invoke(event, { traceId: TRACE })).toEqual({
      ok: true,
      latency: { traceId: TRACE, mainDurationMs: 3 },
    });
  });
});
