import type { IpcMainInvokeEvent } from 'electron';
import { requestTraceId, type MainRequestTiming } from '$shared/request-latency';

interface IpcRequestTrace {
  traceId: string;
  rpc<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * IPC-only metadata. The daemon result and error remain untouched. Durations
 * use this process's monotonic clock; cross-process timestamps are never subtracted.
 */
export function withBackendRequestLatency<
  Payload extends { traceId?: unknown },
  Result extends object,
>(
  handler: (
    event: IpcMainInvokeEvent,
    payload: Payload,
    trace?: IpcRequestTrace,
  ) => Promise<Result>,
): (
  event: IpcMainInvokeEvent,
  payload: Payload,
) => Promise<Result & { latency?: MainRequestTiming }> {
  return async (event, payload) => {
    const traceId = requestTraceId(payload?.traceId);
    if (!traceId) return handler(event, payload);
    const start = performance.now();
    let rpcDurationMs: number | undefined;
    const result = await handler(event, payload, {
      traceId,
      async rpc(operation) {
        const rpcStart = performance.now();
        try {
          return await operation();
        } finally {
          rpcDurationMs = performance.now() - rpcStart;
        }
      },
    });
    return {
      ...result,
      latency: {
        traceId,
        mainDurationMs: performance.now() - start,
        ...(rpcDurationMs === undefined ? {} : { rpcDurationMs }),
      },
    };
  };
}
