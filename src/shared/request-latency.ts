/** Diagnostic correlation only. Never conveys request authority or contains user data. */
export interface MainRequestTiming {
  traceId: string;
  mainDurationMs: number;
  /** Present only for an ordinary request forwarded to the JSON-RPC client. */
  rpcDurationMs?: number;
}

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const TRACE_ID = new RegExp(`^latency-${UUID}(?:\\.${UUID})?$`);

/** Ignore invalid instrumentation without changing the underlying operation. */
export function requestTraceId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    (value.length === 44 || value.length === 81) &&
    TRACE_ID.test(value)
    ? value
    : undefined;
}

/** Preserve traced string IDs and existing daemons that stringify numeric IDs. */
export function responseRequestId(
  pending: ReadonlyMap<number | string, unknown>,
  value: unknown,
): number | string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (pending.has(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && pending.has(numeric)) return numeric;
  }
  return undefined;
}
