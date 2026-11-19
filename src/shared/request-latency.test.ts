import { describe, expect, it } from 'vitest';
import { requestTraceId, responseRequestId } from './request-latency';

const TRACE = 'latency-12345678-1234-1234-1234-123456789abc';

describe('diagnostic JSON-RPC correlation', () => {
  it('admits only opaque fixed-size trace ids', () => {
    expect(requestTraceId(TRACE)).toBe(TRACE);
    expect(requestTraceId(`${TRACE}.abcdef12-1234-1234-1234-123456789abc`)).toBe(
      `${TRACE}.abcdef12-1234-1234-1234-123456789abc`,
    );
    for (const value of [undefined, null, 1, '1', 'user task text', `${TRACE}\n`, `rev-${TRACE}`])
      expect(requestTraceId(value)).toBeUndefined();
  });

  it('keeps string traces separate from numeric requests and supports numeric-string replies', () => {
    const pending = new Map<number | string, unknown>([
      [1, {}],
      [TRACE, {}],
    ]);
    expect(responseRequestId(pending, TRACE)).toBe(TRACE);
    expect(responseRequestId(pending, 1)).toBe(1);
    expect(responseRequestId(pending, '1')).toBe(1);
    for (const id of ['rev-1', 'latency-missing', null, true, {}, 2])
      expect(responseRequestId(pending, id)).toBeUndefined();
  });
});
