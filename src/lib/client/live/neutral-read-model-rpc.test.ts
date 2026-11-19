import { NeutralReadModel, type ReadModelView } from './neutral-read-model';
import { subscribeNeutralReadModel } from './neutral-read-model-subscription';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createReadModelRpcPort, type ReadModelRpcTransport } from './neutral-read-model-rpc';
import type { BackendNotification } from './backend-transport-types';
const snapshot = {
  type: 'snapshot',
  workspaceId: 'ws',
  channel: 'vcs',
  sequence: 3,
  stateToken: 'token-3',
  items: [],
};
const delta = (sequence: number) => ({
  type: 'delta',
  workspaceId: 'ws',
  channel: 'vcs',
  previousSequence: sequence - 1,
  sequence,
  stateToken: `token-${sequence}`,
  upserts: [],
  removedIds: [],
});
function setup() {
  let listener: (n: BackendNotification) => void = () => {};
  const off = vi.fn();
  const order: string[] = [];
  const transport: ReadModelRpcTransport = {
    request: vi.fn(async () => {
      order.push('request');
      return { frames: [snapshot] };
    }),
    subscribe: vi.fn(async () => {
      order.push('subscribe');
      return { subscriptionId: 'sub', lossRecovery: 1 };
    }),
    unsubscribe: vi.fn(async () => {}),
    onNotification: (handler) => {
      order.push('listen');
      listener = handler;
      return off;
    },
    onReconnected: vi.fn(() => vi.fn()),
    fenceEvents: vi.fn(async (subscriptionIds) => ({ subscriptionIds })),
  };
  const emit = (frame: unknown, subscriptionId = 'sub', type = 'vcs:delta') =>
    listener({ method: 'events.event', params: { subscriptionId, event: { type, data: frame } } });
  return {
    transport,
    off,
    order,
    emit,
    notify: (notification: BackendNotification) => listener(notification),
  };
}
describe('prepared read-model RPC adapter', () => {
  it('requires exact recovery capability and an ordered physical fence hook before subscribing', async () => {
    for (const capability of [undefined, 2, true, '1']) {
      const s = setup();
      await expect(
        createReadModelRpcPort('vcs', s.transport, {
          isCurrent: () => true,
          capabilities: () => ({ eventStreamRecovery: capability }),
        }).subscribe('ws', null, vi.fn(), vi.fn()),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      expect(s.transport.subscribe).not.toHaveBeenCalled();
    }
    const s = setup();
    delete s.transport.fenceEvents;
    await expect(
      createReadModelRpcPort('vcs', s.transport, {
        isCurrent: () => true,
        capabilities: () => ({ eventStreamRecovery: 1 }),
      }).subscribe('ws', null, vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(s.transport.subscribe).not.toHaveBeenCalled();
  });
  it('retires an unconfirmed recovery lease without reading or fabricating a legacy path', async () => {
    const s = setup();
    s.transport.subscribe = vi.fn(async () => ({ subscriptionId: 'sub' }));
    await expect(
      createReadModelRpcPort('vcs', s.transport, {
        isCurrent: () => true,
        capabilities: () => ({ eventStreamRecovery: 1 }),
      }).subscribe('ws', null, vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(s.transport.request).not.toHaveBeenCalled();
    expect(s.transport.unsubscribe).toHaveBeenCalledWith('sub', 'ws');
  });

  it('installs events before reading frames, buffers by subscription ID and reorders pending deltas', async () => {
    const s = setup();
    let resolve!: (value: unknown) => void;
    s.transport.request = vi.fn(() => {
      s.order.push('request');
      return new Promise((done) => {
        resolve = done;
      });
    });
    const push = vi.fn();
    const registration = createReadModelRpcPort('vcs', s.transport, {
      isCurrent: () => true,
      capabilities: () => ({ eventStreamRecovery: 1 }),
    }).subscribe('ws', null, push, vi.fn());
    s.emit(delta(99), 'foreign');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    s.emit(delta(5));
    s.emit(delta(4));
    s.emit({ ...delta(90), workspaceId: 'other' });
    resolve({ frames: [snapshot] });
    const stop = await registration;
    expect(s.order).toEqual(['listen', 'subscribe', 'request']);
    expect(s.transport.subscribe).toHaveBeenCalledWith({
      workspaceId: 'ws',
      eventTypes: ['vcs:delta'],
      lossRecovery: 1,
    });
    expect(s.transport.request).toHaveBeenCalledWith('vcs.subscribe', { workspaceId: 'ws' });
    expect(push.mock.calls.map(([frame]) => frame.sequence)).toEqual([3, 4, 5]);
    s.emit(delta(6));
    expect(push).toHaveBeenLastCalledWith(delta(6));
    stop();
    expect(s.off).toHaveBeenCalledOnce();
    expect(s.transport.unsubscribe).toHaveBeenCalledWith('sub', 'ws');
    s.emit(delta(7));
    expect(push).toHaveBeenCalledTimes(4);
  });
  it('maps a durable cursor to after and accepts a zero-frame replay', async () => {
    const s = setup();
    s.transport.request = vi.fn(async () => ({ frames: [] }));
    const push = vi.fn();
    const cursor = { sequence: 3, stateToken: 'token-3' };
    const stop = await createReadModelRpcPort('work', s.transport, {
      isCurrent: () => true,
      capabilities: () => ({ eventStreamRecovery: 1 }),
    }).subscribe('ws', cursor, push, vi.fn());
    expect(s.transport.request).toHaveBeenCalledWith('work.subscribe', {
      workspaceId: 'ws',
      after: cursor,
    });
    expect(s.transport.subscribe).toHaveBeenCalledWith({
      workspaceId: 'ws',
      eventTypes: ['work:delta'],
      lossRecovery: 1,
    });
    expect(push).not.toHaveBeenCalled();
    stop();
  });
  it.each([
    { frames: [] },
    { frames: [{ ...snapshot, sequence: Number.MAX_SAFE_INTEGER + 1 }] },
    { frames: [snapshot], extra: true },
  ])('refuses an incomplete/malformed initial capture and cleans up: %#', async (response) => {
    const s = setup();
    s.transport.request = vi.fn(async () => response);
    const push = vi.fn();
    await expect(
      createReadModelRpcPort('vcs', s.transport, {
        isCurrent: () => true,
        capabilities: () => ({ eventStreamRecovery: 1 }),
      }).subscribe('ws', null, push, vi.fn()),
    ).rejects.toThrow('Read-model subscription unavailable');
    expect(push).not.toHaveBeenCalled();
    expect(s.off).toHaveBeenCalledOnce();
    expect(s.transport.unsubscribe).toHaveBeenCalledWith('sub', 'ws');
  });
  it('refuses malformed pending frames before applying the snapshot', async () => {
    const s = setup();
    s.transport.request = vi.fn(async () => {
      s.emit({ bad: 'payload' });
      return { frames: [snapshot] };
    });
    const push = vi.fn();
    await expect(
      createReadModelRpcPort('vcs', s.transport, {
        isCurrent: () => true,
        capabilities: () => ({ eventStreamRecovery: 1 }),
      }).subscribe('ws', null, push, vi.fn()),
    ).rejects.toThrow('Read-model subscription unavailable');
    expect(push).not.toHaveBeenCalled();
    expect(s.off).toHaveBeenCalledOnce();
  });
  it('bounds pre-ack buffering and releases failed subscriptions', async () => {
    const s = setup();
    s.transport.request = vi.fn(async () => {
      for (let i = 0; i < 513; i++) s.emit(delta(i + 4));
      return { frames: [snapshot] };
    });
    const push = vi.fn();
    await expect(
      createReadModelRpcPort('vcs', s.transport, {
        isCurrent: () => true,
        capabilities: () => ({ eventStreamRecovery: 1 }),
      }).subscribe('ws', null, push, vi.fn()),
    ).rejects.toThrow('Read-model subscription unavailable');
    expect(push).not.toHaveBeenCalled();
    expect(s.off).toHaveBeenCalledOnce();
  });
});

// Load the canonical corpus, not a second transcription of recovery wire shapes.
const corpusBytes = readFileSync(
  resolvePath(process.cwd(), 'src/lib/client/live/__fixtures__/event-stream-recovery.json'),
);
const corpus = JSON.parse(corpusBytes.toString('utf8'));
const source = JSON.parse(
  readFileSync(
    resolvePath(
      process.cwd(),
      'src/lib/client/live/__fixtures__/event-stream-recovery.source.json',
    ),
    'utf8',
  ),
);

const scoped = corpus.admission.find((item: { id: string }) => item.id === 'scoped');
describe('read-model generic loss admission', () => {
  it('uses an unchanged canonical corpus with a recorded source commit', () => {
    expect(source.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(createHash('sha256').update(corpusBytes).digest('hex')).toBe(source.sha256);
  });

  it('invalidates a lost final delta immediately and resumes the accepted durable cursor without any later event', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.transport.subscribe = vi.fn(async () => corpus.wire.scopedAck.result);
    s.transport.request = vi.fn(async () => ({
      frames: [{ ...snapshot, workspaceId: scoped.lease.workspaceId }],
    }));
    const lifetime = {
      isCurrent: () => true,
      capabilities: () => ({ ...corpus.capability, vcs: 1 }),
    };
    const views: ReadModelView[] = [];
    const model = new NeutralReadModel(scoped.lease.workspaceId, 'vcs', lifetime, {
      started: vi.fn(),
      updated: (view) => views.push(view),
    });
    const stop = subscribeNeutralReadModel(
      scoped.lease.workspaceId,
      model,
      createReadModelRpcPort('vcs', s.transport, lifetime),
    );
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(views.at(-1)?.status).toBe('live');
      s.notify(scoped.frame);
      expect(views.at(-1)?.status).toBe('resnapshot-required');
      s.transport.request = vi.fn(async () => ({
        frames: [{ ...delta(4), workspaceId: scoped.lease.workspaceId }],
      }));
      await vi.advanceTimersByTimeAsync(250);
      expect(s.transport.request).toHaveBeenCalledWith('vcs.subscribe', {
        workspaceId: scoped.lease.workspaceId,
        after: { sequence: 3, stateToken: 'token-3' },
      });
      expect(views.at(-1)).toMatchObject({
        status: 'live',
        cursor: { sequence: 4, stateToken: 'token-4' },
      });
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  async function registered() {
    const s = setup();
    s.transport.subscribe = vi.fn(async () => corpus.wire.scopedAck.result);
    s.transport.request = vi.fn(async () => ({
      frames: [{ ...snapshot, workspaceId: scoped.lease.workspaceId }],
    }));
    const current = vi.fn(() => true);
    const invalidated = vi.fn();
    const push = vi.fn();
    const stop = await createReadModelRpcPort('vcs', s.transport, {
      isCurrent: current,
      capabilities: () => corpus.capability,
    }).subscribe(scoped.lease.workspaceId, null, push, invalidated);
    return { ...s, current, invalidated, push, stop };
  }
  it.each(
    corpus.admission.filter(
      (item: {
        id: string;
        lastGeneration?: string;
        lease: { workspaceId: string; lossRecovery: number };
      }) =>
        !item.lastGeneration &&
        item.lease?.workspaceId === scoped.lease.workspaceId &&
        item.lease.lossRecovery === 1,
    ),
  )('canonical admission $id', async (entry) => {
    const s = await registered();
    if (entry.id === 'retired-subscription') s.stop();
    if (entry.deliveryContext) s.current.mockReturnValue(false);
    s.notify(entry.frame);
    expect(s.invalidated).toHaveBeenCalledTimes(entry.expected === 'invalidate' ? 1 : 0);
    s.stop();
  });
  it('does not lose a final-event invalidation or exact-u64 marker without a later domain event', async () => {
    const s = await registered();
    const frame = corpus.admission.find((item: { id: string }) => item.id === 'max-u64').frame;
    s.notify(frame);
    s.notify(frame);
    expect(s.invalidated).toHaveBeenCalledOnce();
    expect(s.off).toHaveBeenCalledOnce();
    s.stop();
  });
  it('stages an early loss until the matching opted-in ack and starts no read', async () => {
    const s = setup();
    let acknowledge!: (value: unknown) => void;
    s.transport.subscribe = vi.fn(
      () =>
        new Promise((done) => {
          acknowledge = done;
        }),
    );
    const invalidated = vi.fn();
    const pending = createReadModelRpcPort('vcs', s.transport, {
      isCurrent: () => true,
      capabilities: () => corpus.capability,
    }).subscribe(scoped.lease.workspaceId, null, vi.fn(), invalidated);
    s.notify(scoped.frame);
    expect(invalidated).not.toHaveBeenCalled();
    acknowledge(corpus.wire.scopedAck.result);
    await expect(pending).rejects.toThrow();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(s.transport.request).not.toHaveBeenCalled();
  });
  it('holds the read until the end fence and refuses a loss before its physical acknowledgment', async () => {
    const s = setup();
    s.transport.subscribe = vi.fn(async () => corpus.wire.scopedAck.result);
    s.transport.request = vi.fn(async () => ({
      frames: [{ ...snapshot, workspaceId: scoped.lease.workspaceId }],
    }));
    let end!: (value: unknown) => void;
    let count = 0;
    s.transport.fenceEvents = vi.fn(async (ids) => {
      if (++count === 1) return { subscriptionIds: ids };
      return new Promise((done) => {
        end = done;
      });
    });
    const push = vi.fn(),
      invalidated = vi.fn();
    const pending = createReadModelRpcPort('vcs', s.transport, {
      isCurrent: () => true,
      capabilities: () => corpus.capability,
    }).subscribe(scoped.lease.workspaceId, null, push, invalidated);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
    s.notify(scoped.frame);
    end(corpus.wire.fenceReply.result);
    await expect(pending).rejects.toThrow();
    expect(push).not.toHaveBeenCalled();
    expect(invalidated).toHaveBeenCalledOnce();
  });
});
