import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeutralReadModel, type ReadModelView } from './neutral-read-model';
import {
  subscribeNeutralReadModel,
  type ReadModelSubscriptionPort,
} from './neutral-read-model-subscription';

const snapshot = {
  type: 'snapshot',
  workspaceId: 'ws',
  channel: 'vcs',
  sequence: 3,
  stateToken: 'token',
  items: [],
};
function setup() {
  const views: ReadModelView[] = [];
  const model = new NeutralReadModel(
    'ws',
    'vcs',
    { isCurrent: () => true, capabilities: () => ({ vcs: 1 }) },
    { started: vi.fn(), updated: (view) => views.push(view) },
  );
  const callbacks: ((frame: unknown) => void)[] = [];
  const disposers: ReturnType<typeof vi.fn>[] = [];
  let reconnect = () => {};
  const port: ReadModelSubscriptionPort = {
    subscribe: vi.fn(async (_workspaceId, _cursor, push) => {
      callbacks.push(push);
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    }),
    onReconnect: (handler) => {
      reconnect = handler;
      return vi.fn();
    },
  };
  return { views, model, port, callbacks, disposers, reconnect: () => reconnect() };
}
afterEach(() => {
  vi.useRealTimers();
});
describe('injected neutral channel registration', () => {
  it('handles pre-ack snapshots and reconnect resume while ignoring retired callbacks', async () => {
    const s = setup();
    const stop = subscribeNeutralReadModel('ws', s.model, s.port);
    s.callbacks[0](snapshot);
    await Promise.resolve();
    s.reconnect();
    await Promise.resolve();
    expect(s.port.subscribe).toHaveBeenLastCalledWith(
      'ws',
      { sequence: 3, stateToken: 'token' },
      expect.any(Function),
      expect.any(Function),
    );
    s.callbacks[0]({ ...snapshot, sequence: 99 });
    expect(s.views.at(-1)?.status).toBe('live');
    s.callbacks[1]({ ...snapshot, sequence: 4, stateToken: 'next' });
    expect(s.views.at(-1)?.cursor?.sequence).toBe(4);
    stop();
    s.callbacks[1]({ ...snapshot, sequence: 100 });
    expect(s.views.at(-1)?.cursor?.sequence).toBe(4);
    expect(s.disposers[0]).toHaveBeenCalledOnce();
    expect(s.disposers[1]).toHaveBeenCalledOnce();
  });
  it('disposes a late successful subscribe acknowledgement after cancellation', async () => {
    const s = setup();
    let resolve!: (stop: () => void) => void;
    s.port.subscribe = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const stop = subscribeNeutralReadModel('ws', s.model, s.port);
    stop();
    const dispose = vi.fn();
    resolve(dispose);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('resnapshots a gap with bounded retry and keeps the last accepted cursor', async () => {
    vi.useFakeTimers();
    const s = setup();
    const stop = subscribeNeutralReadModel('ws', s.model, s.port);
    s.callbacks[0](snapshot);
    await Promise.resolve();
    s.callbacks[0]({
      type: 'delta',
      workspaceId: 'ws',
      channel: 'vcs',
      previousSequence: 9,
      sequence: 10,
      stateToken: 'wrong',
      upserts: [],
      removedIds: [],
    });
    expect(s.views.at(-1)?.status).toBe('resnapshot-required');
    expect(s.port.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(s.port.subscribe).toHaveBeenCalledTimes(2);
    expect(s.port.subscribe).toHaveBeenLastCalledWith(
      'ws',
      { sequence: 3, stateToken: 'token' },
      expect.any(Function),
      expect.any(Function),
    );
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.port.subscribe).toHaveBeenCalledTimes(2);
  });
  it('suspends after three failures until a new connection or demand', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.port.subscribe = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const stop = subscribeNeutralReadModel('ws', s.model, s.port);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.port.subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.port.subscribe).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60000);
    expect(s.port.subscribe).toHaveBeenCalledTimes(3);
    s.reconnect();
    await Promise.resolve();
    expect(s.port.subscribe).toHaveBeenCalledTimes(4);
    stop();
  });
  it('retries transport failure and clears retry timers on disposal', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.port.subscribe = vi.fn(async () => {
      throw new Error('not retained');
    });
    const stop = subscribeNeutralReadModel('ws', s.model, s.port);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.port.subscribe).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.port.subscribe).toHaveBeenCalledTimes(2);
  });
});
