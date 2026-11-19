import { runSaga, stdChannel } from 'redux-saga';
import { vcsReducer } from '$store/renderer/slices/vcs/vcs-slice';
import { workReducer } from '$store/renderer/slices/work/work-slice';
import { neutralReadModelSaga } from '$store/renderer/slices/vcs/sagas/neutral-read-model-saga';
import { workspaceMounted } from '$store/renderer/slices/workspace-lifecycle/workspace-lifecycle-slice';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '$shared/ipc-registry';
import { createNeutralWorkspaceTransport } from '$lib/client/live/neutral-workspace-transport';
import { captureNeutralWorkspaceClients } from '$lib/client/live/neutral-workspace-client';
import type { BackendTransport } from '$lib/client/live/backend-transport-types';
import { stampWindowWithBackend } from '../../../main/window-backend';
import { JsonRpcClient } from './json-rpc-client';
import { registerNeutralWorkspaceHandlers } from './neutral-workspace-lifecycle';

const windows = vi.hoisted(() => new Map<object, object>());
vi.mock('$lib/client', () => ({ appClient: {} }));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (sender: object) => windows.get(sender) ?? null },
}));
const channels = IPC_CHANNELS.BACKEND.NEUTRAL_WORKSPACE;
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((fn) => fn());
  windows.clear();
  vi.useRealTimers();
});
class Socket extends EventEmitter {
  destroyed = false;
  hold = false;
  earlyControl = false;
  denyWorkspace = false;
  capabilities: Record<string, unknown> = { vcs: 1, workEvidence: 1, eventStreamRecovery: 1 };
  memoryPage: unknown = { memories: [], nextCursor: null };
  next = 0;
  frames: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  write(line: string) {
    const frame = JSON.parse(line);
    this.frames.push(frame);
    if (this.denyWorkspace && frame.method === 'events.subscribe') {
      queueMicrotask(() =>
        this.emit(
          'data',
          Buffer.from(
            JSON.stringify({ id: frame.id, error: { code: -32003, message: 'Forbidden' } }) + '\n',
          ),
        ),
      );
      return true;
    }
    let result: unknown = {};
    if (frame.method === 'client.hello')
      result = { clientId: 'desktop', server: { capabilities: this.capabilities } };
    else if (frame.method === 'principal.me')
      result = {
        id: 'principal-A',
        login: null,
        displayName: null,
        avatarUrl: null,
        isAdministrator: true,
      };
    else if (frame.method === 'memory.list') result = this.memoryPage;
    else if (frame.method === 'events.subscribe') {
      const subscriptionId = `lease-${++this.next}`;
      result = { subscriptionId, lossRecovery: 1 };
      if (this.earlyControl && frame.params.eventTypes.includes('workspace:updated'))
        this.notify({
          method: 'events.lost',
          params: { subscriptionId, generation: '1', scope: { workspaceId: 'ws' } },
        });
    } else if (frame.method === 'events.fence')
      result = { subscriptionIds: frame.params.subscriptionIds };
    else if (frame.method === 'vcs.subscribe' || frame.method === 'work.subscribe')
      result = {
        frames: frame.params.after
          ? []
          : [
              {
                type: 'snapshot',
                workspaceId: 'ws',
                channel: frame.method === 'vcs.subscribe' ? 'vcs' : 'work',
                sequence: 7,
                stateToken: 'token-7',
                items: [],
              },
            ],
      };
    if (!(this.hold && frame.method === 'vcs.subscribe'))
      queueMicrotask(() => this.result(frame.id, result));
    return true;
  }
  result(id: number, result: unknown) {
    this.emit('data', Buffer.from(JSON.stringify({ id, result }) + '\n'));
  }
  notify(notification: unknown) {
    this.emit('data', Buffer.from(JSON.stringify(notification) + '\n'));
  }
  destroy() {
    this.destroyed = true;
  }
}
async function harness(
  capabilities?: Record<string, unknown>,
  earlyControl = false,
  enrolled = false,
) {
  const socket = new Socket();
  if (capabilities) socket.capabilities = capabilities;
  socket.earlyControl = earlyControl;
  const client = new JsonRpcClient({
    socketFactory: () => socket as unknown as Duplex,
    helloParams: () => ({ clientId: 'desktop' }),
    heartbeatIntervalMs: 0,
    ...(enrolled ? { lifecycle: { scope: Symbol('neutral-workspace-test'), generation: 1 } } : {}),
  });
  const pool = new Map([['host-A', client]]);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
  const registry = registerNeutralWorkspaceHandlers(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    { readBackend: (id) => pool.get(id) },
  );
  disposers.push(() => {
    registry.dispose();
    client.dispose();
  });
  client.start();
  socket.emit('connect');
  await vi.waitFor(() => expect(client.getRepositoryConnection()).not.toBeNull());
  const listeners = new Map<string, (value: unknown) => void>();
  const queue: unknown[] = [];
  let next = 0;
  const frame = {
    send: (channel: string, value: unknown) => {
      if (channel === channels.INGRESS) queue.push(value);
    },
  };
  const sender = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), {
    webContents: sender,
    isDestroyed: () => false,
  });
  windows.set(sender, window);
  stampWindowWithBackend(window as unknown as BrowserWindow, 'host-A');
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const bridge = {
    on: (_channel: string, listener: (value: unknown) => void) => {
      const id = String(++next);
      listeners.set(id, listener);
      return id;
    },
    offById: (_channel: string, id: string) => listeners.delete(id),
    invoke: vi.fn((channel: string, value: unknown) =>
      Promise.resolve(handlers.get(channel)!(event, value)),
    ),
  };
  let selectedBridge = bridge;
  const capture = createNeutralWorkspaceTransport(
    () => selectedBridge as unknown as Window['electronAPI'],
  );
  const flush = () => {
    for (const item of queue.splice(0))
      for (const listener of [...listeners.values()]) listener(item);
  };
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      flush();
    }
  };
  return {
    socket,
    client,
    pool,
    registry,
    window,
    bridge,
    capture,
    queue,
    flush,
    settle,
    event,
    handlers,
    replaceBridge: () => {
      selectedBridge = { ...bridge };
    },
  };
}
describe('captured neutral physical socket → main → ordered IPC ingress', () => {
  it('holds a fence reply until preceding notification callbacks cross the bridge queue', async () => {
    const h = await harness();
    const context = await h.capture('ws');
    const lease = (await context.subscribe({
      workspaceId: 'ws',
      eventTypes: ['vcs:delta'],
      lossRecovery: 1,
    })) as { subscriptionId: string };
    const observed: string[] = [];
    context.onNotification((notice) => observed.push(notice.method));
    h.socket.notify({
      method: 'events.lost',
      params: {
        subscriptionId: lease.subscriptionId,
        generation: '1',
        scope: { workspaceId: 'ws' },
      },
    });
    let fenced = false;
    const fence = context.fenceEvents([lease.subscriptionId]).then(() => {
      fenced = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.queue.map((item) => (item as { type: string }).type)).toEqual([
      'notification',
      'barrier',
    ]);
    expect(fenced).toBe(false);
    expect(observed).toEqual([]);
    h.flush();
    await fence;
    expect(observed).toEqual(['events.lost']);
    expect(fenced).toBe(true);
    expect(
      h.bridge.invoke.mock.calls.every(([channel]) =>
        Object.values(channels).some((expected) => expected === channel),
      ),
    ).toBe(true);
    await context.release();
  });
  it('refuses a missing ingress message at the barrier deadline', async () => {
    const h = await harness();
    const context = await h.capture('ws');
    const lease = (await context.subscribe({
      workspaceId: 'ws',
      eventTypes: ['vcs:delta'],
      lossRecovery: 1,
    })) as { subscriptionId: string };
    vi.useFakeTimers();
    h.socket.notify({
      method: 'events.lost',
      params: {
        subscriptionId: lease.subscriptionId,
        generation: '1',
        scope: { workspaceId: 'ws' },
      },
    });
    const fence = context.fenceEvents([lease.subscriptionId]);
    const rejected = expect(fence).rejects.toThrow('unavailable');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    h.queue.shift();
    h.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(context.isCurrent()).toBe(false);
    await context.release();
  });
  it('joins original in-flight requests and lease cleanup exactly once before pool sealing', async () => {
    const h = await harness(undefined, false, true);
    const context = await h.capture('ws');
    h.socket.hold = true;
    const pending = context.request('vcs.subscribe', { workspaceId: 'ws' });
    const rejected = expect(pending).rejects.toThrow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.registry.retireBackend('host-A');
    const ticket = h.client.beginMemberRetirement();
    expect(ticket.isDrained()).toBe(false);
    const held = h.socket.frames.find((row) => row.method === 'vcs.subscribe')!;
    h.socket.result(held.id, { frames: [] });
    await rejected;
    await vi.waitFor(() => expect(ticket.isDrained()).toBe(true));
    expect(h.socket.frames.some((row) => row.method === 'events.unsubscribe')).toBe(true);
    expect(ticket.failures()).toEqual([]);
    await context.release();
  });
  it('recovers when the last durable delta is lost, without waiting for any later event', async () => {
    const h = await harness();
    const ports = await captureNeutralWorkspaceClients(
      { captureNeutralWorkspace: h.capture } as BackendTransport,
      'ws',
    );
    const views: Array<{ status: string; cursor: unknown }> = [];
    const stop = ports.vcs!.subscribeReadModel('ws', {
      started: () => {},
      updated: (view) => views.push(view),
    });
    await h.settle();
    expect(views.at(-1)).toMatchObject({
      status: 'live',
      cursor: { sequence: 7, stateToken: 'token-7' },
    });
    h.socket.notify({
      method: 'events.lost',
      params: {
        subscriptionId: 'lease-2',
        generation: '18446744073709551615',
        scope: { workspaceId: 'ws' },
      },
    });
    h.flush();
    expect(views.at(-1)?.status).toBe('resnapshot-required');
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.socket.frames.filter((row) => row.method === 'vcs.subscribe')).toHaveLength(2);
    });
    expect(h.socket.frames.filter((row) => row.method === 'vcs.subscribe')[1].params).toEqual({
      workspaceId: 'ws',
      after: { sequence: 7, stateToken: 'token-7' },
    });
    expect(views.at(-1)?.status).toBe('live');
    stop();
    await ports.release();
  });
  it('retires an A→B→A document binding and rejects late request completion on its original socket', async () => {
    const h = await harness();
    const context = await h.capture('ws');
    const retired = vi.fn();
    context.onRetired(retired);
    h.socket.hold = true;
    const request = context.request('vcs.subscribe', { workspaceId: 'ws' });
    const rejected = expect(request).rejects.toThrow();
    await Promise.resolve();
    const held = h.socket.frames.find((row) => row.method === 'vcs.subscribe')!;
    stampWindowWithBackend(h.window as unknown as BrowserWindow, 'host-B');
    stampWindowWithBackend(h.window as unknown as BrowserWindow, 'host-A');
    h.flush();
    expect(retired).toHaveBeenCalledOnce();
    h.socket.result(held.id, { frames: [] });
    await rejected;
    await expect(context.request('work.subscribe', { workspaceId: 'ws' })).rejects.toThrow();
    expect(h.socket.frames.some((row) => row.method === 'work.subscribe')).toBe(false);
    await context.release();
  });
  it.each(['workspace:updated', 'workspace:deleted', 'events.lost'])(
    'retires protected state on %s control, and refuses another bridge',
    async (type) => {
      const h = await harness();
      const context = await h.capture('ws');
      const retired = vi.fn();
      context.onRetired(retired);
      h.socket.notify(
        type === 'events.lost'
          ? {
              method: type,
              params: { subscriptionId: 'lease-1', generation: '1', scope: { workspaceId: 'ws' } },
            }
          : {
              method: 'events.event',
              params: { subscriptionId: 'lease-1', event: { type, data: { workspaceId: 'ws' } } },
            },
      );
      h.flush();
      expect(context.isCurrent()).toBe(false);
      expect(retired).toHaveBeenCalledOnce();
      h.replaceBridge();
      await expect(context.request('vcs.subscribe', { workspaceId: 'ws' })).rejects.toThrow();
      await context.release();
    },
  );
  it('clears actual mounted projections on revocation and fences retired pushes', async () => {
    const h = await harness();
    const channel = stdChannel();
    let state = {
      vcs: vcsReducer(undefined, { type: '@@INIT' }),
      work: workReducer(undefined, { type: '@@INIT' }),
    };
    const task = runSaga(
      {
        channel,
        dispatch: (action) => {
          state = { vcs: vcsReducer(state.vcs, action), work: workReducer(state.work, action) };
        },
      },
      neutralReadModelSaga,
      {
        captureNeutralWorkspace: (ws) =>
          captureNeutralWorkspaceClients(
            { captureNeutralWorkspace: h.capture } as BackendTransport,
            ws,
          ),
      },
    );
    channel.put(workspaceMounted('ws'));
    await vi.waitFor(async () => {
      await h.settle();
      expect(state.vcs.byWorkspaceId.ws.status).toBe('live');
      expect(state.work.byWorkspaceId.ws.status).toBe('live');
    });
    h.socket.denyWorkspace = true;
    h.socket.notify({
      method: 'events.event',
      params: {
        subscriptionId: 'lease-1',
        event: { type: 'workspace:updated', data: { workspaceId: 'ws' } },
      },
    });
    h.flush();
    expect(state.vcs.byWorkspaceId).toEqual({});
    expect(state.work.byWorkspaceId).toEqual({});
    await h.settle();
    h.socket.notify({
      method: 'events.event',
      params: {
        subscriptionId: 'lease-2',
        event: {
          type: 'vcs:delta',
          data: {
            type: 'snapshot',
            workspaceId: 'ws',
            channel: 'vcs',
            sequence: 99,
            stateToken: 'stale',
            items: [],
          },
        },
      },
    });
    await h.settle();
    expect(state.vcs.byWorkspaceId).toEqual({});
    expect(state.work.byWorkspaceId).toEqual({});
    task.cancel();
  });
  it('retires on actual physical hello identity replacement', async () => {
    const h = await harness();
    const context = await h.capture('ws');
    const retired = vi.fn();
    context.onRetired(retired);
    await h.client.request('client.hello', {});
    h.flush();
    expect(retired).toHaveBeenCalledOnce();
    await expect(context.request('vcs.subscribe', { workspaceId: 'ws' })).rejects.toThrow();
    await context.release();
  });
  it('supplies only exact capability ports and leaves unpublished operations unavailable', async () => {
    const h = await harness({ vcs: 1, workEvidence: 2, eventStreamRecovery: 1 });
    const ports = await captureNeutralWorkspaceClients(
      { captureNeutralWorkspace: h.capture } as BackendTransport,
      'ws',
    );
    expect(ports.work).toBeUndefined();
    expect(ports.vcs?.canSubscribeReadModel).toBe(true);
    await expect(
      ports.vcs!.status({
        workspaceId: 'ws',
        rootId: 'root',
        repositoryId: 'repo',
        locator: '/repo',
        kind: 'git',
        epoch: 1,
      }),
    ).rejects.toThrow('unavailable');
    expect(h.socket.frames.some((row) => row.method === 'vcs.status')).toBe(false);
    await ports.release();
  });
  it('does not publish a capture when control loss precedes its acknowledgment', async () => {
    const h = await harness(undefined, true);
    await expect(h.capture('ws')).rejects.toThrow();
    expect(h.socket.frames.some((row) => row.method === 'events.unsubscribe')).toBe(true);
    expect(h.socket.frames.some((row) => row.method === 'vcs.subscribe')).toBe(false);
  });
  it.each([{}, { vcs: 2, eventStreamRecovery: 1 }, { vcs: 1, eventStreamRecovery: 2 }])(
    'refuses unsupported raw capabilities without registering event leases: %o',
    async (caps) => {
      const h = await harness(caps);
      await expect(h.capture('ws')).rejects.toThrow();
      expect(h.socket.frames.map((row) => row.method)).toEqual(['client.hello']);
    },
  );
  it('refuses cross-workspace scope, foreign event IDs, and unpublished mutation methods', async () => {
    const h = await harness();
    const context = await h.capture('ws');
    await expect(context.request('vcs.subscribe', { workspaceId: 'other' })).rejects.toThrow();
    await expect(context.fenceEvents(['foreign'])).rejects.toThrow();
    await expect(context.request('work.decide', { workspaceId: 'ws' })).rejects.toThrow();
    expect(
      h.socket.frames.some((row) => ['vcs.subscribe', 'work.decide'].includes(row.method)),
    ).toBe(false);
    await context.release();
  });
});

describe('experimental memory over the captured renderer/main wire', () => {
  it('installs only opted-in reads and sends the exact scoped method on the original socket', async () => {
    const h = await harness({ experimentalMemoryRead: 1, eventStreamRecovery: 1 });
    const ports = await captureNeutralWorkspaceClients(
      { captureNeutralWorkspace: h.capture } as BackendTransport,
      'ws',
    );
    expect(ports.vcs).toBeUndefined();
    expect(ports.work).toBeUndefined();
    expect(await ports.memory!.list({ workspaceId: 'ws', paths: ['src'], limit: 20 })).toEqual({
      memories: [],
      nextCursor: null,
    });
    const reads = h.socket.frames.filter((frame) => frame.method.startsWith('memory.'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      method: 'memory.list',
      params: { workspaceId: 'ws', paths: ['src'], limit: 20 },
    });
    h.registry.retireBackend('host-A');
    h.flush();
    await expect(ports.memory!.list({ workspaceId: 'ws' })).rejects.toThrow();
    expect(h.socket.frames.filter((frame) => frame.method.startsWith('memory.'))).toHaveLength(1);
    await ports.release();
  });
  it('cannot smuggle a memory mutation or a foreign workspace through the readonly session', async () => {
    const h = await harness({ experimentalMemoryRead: 1, eventStreamRecovery: 1 });
    const context = await h.capture('ws');
    await expect(
      context.request('memory.accept', { workspaceId: 'ws', expected: {} }),
    ).rejects.toThrow();
    await expect(context.request('memory.list', { workspaceId: 'foreign' })).rejects.toThrow();
    expect(h.socket.frames.some((frame) => frame.method.startsWith('memory.'))).toBe(false);
    await context.release();
  });
  it('does not infer a memory read port from ordinary work capabilities', async () => {
    const h = await harness({
      vcs: 1,
      workEvidence: 1,
      experimentalMemoryRead: 2,
      eventStreamRecovery: 1,
    });
    const ports = await captureNeutralWorkspaceClients(
      { captureNeutralWorkspace: h.capture } as BackendTransport,
      'ws',
    );
    expect(ports.memory).toBeUndefined();
    const context = await h.capture('ws');
    await expect(context.request('memory.list', { workspaceId: 'ws' })).rejects.toThrow();
    expect(h.socket.frames.some((frame) => frame.method.startsWith('memory.'))).toBe(false);
    await context.release();
    await ports.release();
  });
});
