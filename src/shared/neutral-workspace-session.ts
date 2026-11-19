/** A read-only lease over one already acknowledged physical connection. */
import { z } from 'zod';
import { parsePrincipalSnapshot } from './types/principal';
import {
  neutralCapabilities,
  NeutralWorkspaceQuerySchema,
  NeutralWorkspaceRequestSchema,
  type NeutralWorkspaceContext,
} from './types/neutral-workspace';

type Notification = { method: string; params?: unknown };
interface PhysicalConnection {
  hello: unknown;
  isCurrent(): boolean;
  request(method: string, params: unknown): Promise<unknown>;
  onNotification(handler: (notification: Notification) => void): () => void;
  onRetired(handler: () => void): () => void;
}
const ack = z.object({ subscriptionId: z.string().min(1).max(512), lossRecovery: z.literal(1) });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new Error('NEUTRAL_WORKSPACE_UNAVAILABLE');

export async function captureNeutralWorkspaceSession(
  workspaceId: string,
  physical: PhysicalConnection,
): Promise<NeutralWorkspaceContext> {
  NeutralWorkspaceQuerySchema.parse({ workspaceId });
  const capabilities = neutralCapabilities(physical.hello);
  if (!capabilities || !physical.isCurrent()) throw unavailable();
  let retired = false;
  let releasePromise: Promise<void> | undefined;
  let controlId: string | undefined;
  let pendingSubscriptions = 0;
  let earlyBytes = 0;
  const owned = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  const listeners = new Set<(notification: Notification) => void>();
  const retirements = new Set<() => void>();
  const early: Notification[] = [];
  let stopPhysical = () => {};
  let stopRetired = () => {};
  const run = (method: string, params: unknown) => {
    const promise = physical.request(method, params).catch((error: unknown) => {
      const code = object(error) ? (error.rpcCode ?? error.code) : undefined;
      if (code === -32003 || code === -32001 || code === 'AUTH_REJECTED' || code === 'FORBIDDEN')
        void release();
      throw error;
    });
    inFlight.add(promise);
    void promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise),
    );
    return promise;
  };
  const unsubscribe = async (id: string) => {
    owned.delete(id);
    try {
      await run('events.unsubscribe', { workspaceId, subscriptionId: id });
    } catch {
      /* Original connection only; never redial for cleanup. */
    }
  };
  const release = () => {
    if (releasePromise) return releasePromise;
    retired = true;
    releasePromise = Promise.resolve().then(async () => {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      await Promise.allSettled([...owned].map(unsubscribe));
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    });
    stopPhysical();
    stopRetired();
    for (const handler of [...retirements]) {
      try {
        handler();
      } catch {
        /* Retire every consumer. */
      }
    }
    retirements.clear();
    listeners.clear();
    early.length = 0;
    return releasePromise;
  };
  const current = () => {
    if (!physical.isCurrent()) void release();
    return !retired;
  };
  const deliver = (notification: Notification) => {
    if (!current() || !object(notification.params)) return;
    const id = notification.params.subscriptionId;
    if (typeof id !== 'string') return;
    if (id === controlId) {
      // Any access-control invalidation or missed control event retires protected state.
      if (notification.method === 'events.event' || notification.method === 'events.lost')
        void release();
      return;
    }
    if (!owned.has(id)) return;
    for (const handler of [...listeners]) {
      try {
        handler(notification);
      } catch {
        void release();
        return;
      }
    }
  };
  stopPhysical = physical.onNotification((notification) => {
    if (!current() || !['events.event', 'events.lost'].includes(notification.method)) return;
    if (pendingSubscriptions > 0) {
      let size: number;
      try {
        size = new TextEncoder().encode(JSON.stringify(notification)).byteLength;
      } catch {
        void release();
        return;
      }
      if (early.length >= 128 || earlyBytes + size > 4 * 1024 * 1024) {
        void release();
        return;
      }
      earlyBytes += size;
      early.push(notification);
    } else deliver(notification);
  });
  stopRetired = physical.onRetired(() => {
    void release();
  });
  const subscribe = async (params: unknown, control = false) => {
    if (!current() || owned.size + pendingSubscriptions >= 8) throw unavailable();
    pendingSubscriptions += 1;
    try {
      const raw = await run('events.subscribe', params);
      const known = z.object({ subscriptionId: z.string().min(1).max(512) }).safeParse(raw);
      if (known.success) owned.add(known.data.subscriptionId);
      const result = ack.parse(raw);
      if (control) controlId = result.subscriptionId;
      if (!current()) {
        await unsubscribe(result.subscriptionId);
        throw unavailable();
      }
      return result;
    } finally {
      pendingSubscriptions -= 1;
      if (pendingSubscriptions === 0) {
        earlyBytes = 0;
        for (const notification of early.splice(0)) deliver(notification);
      }
    }
  };
  try {
    const principal = parsePrincipalSnapshot(physical.hello, await run('principal.me', {}));
    if (!principal || !current()) throw unavailable();
    // This lease authenticates workspace access before publishing any read port.
    // Workspace mutations may change membership; conservatively retire and reacquire.
    const control = await subscribe(
      { workspaceId, eventTypes: ['workspace:updated', 'workspace:deleted'], lossRecovery: 1 },
      true,
    );
    controlId = control.subscriptionId;
    // Control notices may precede subscribe acknowledgment on the physical bulk lane.
    // The admission fence makes them observable before this capture can be published.
    if (!current()) throw unavailable();
    const fence = z
      .strictObject({ subscriptionIds: z.array(z.string()).length(1) })
      .parse(await run('events.fence', { subscriptionIds: [controlId] }));
    if (fence.subscriptionIds[0] !== controlId) throw unavailable();
    if (!current()) throw unavailable();
    const requestCaptured = async (method: string, params: unknown): Promise<unknown> => {
      if (!current()) throw unavailable();
      const query = NeutralWorkspaceRequestSchema.parse({ method, params });
      if ('workspaceId' in query.params && query.params.workspaceId !== workspaceId)
        throw unavailable();
      if (
        (query.method === 'vcs.subscribe' && capabilities.vcs !== 1) ||
        (query.method === 'work.subscribe' && capabilities.workEvidence !== 1) ||
        ((query.method === 'memory.list' || query.method === 'memory.context') &&
          capabilities.experimentalMemoryRead !== 1)
      )
        throw unavailable();
      if (query.method === 'events.subscribe') {
        const event = query.params.eventTypes[0];
        if (
          (event === 'vcs:delta' && capabilities.vcs !== 1) ||
          (event === 'work:delta' && capabilities.workEvidence !== 1)
        )
          throw unavailable();
        return subscribe(query.params);
      }
      if (query.method === 'events.unsubscribe') {
        if (!owned.has(query.params.subscriptionId) || query.params.subscriptionId === controlId)
          throw unavailable();
        await unsubscribe(query.params.subscriptionId);
        return {};
      }
      if (
        query.method === 'events.fence' &&
        query.params.subscriptionIds.some((id) => !owned.has(id) || id === controlId)
      )
        throw unavailable();
      const result = await run(query.method, query.params);
      if (!current()) throw unavailable();
      return result;
    };
    return {
      workspaceId,
      principalId: principal.principal.id,
      capabilities: Object.freeze(capabilities),
      isCurrent: current,
      onRetired(handler) {
        if (!current()) {
          handler();
          return () => {};
        }
        retirements.add(handler);
        return () => {
          retirements.delete(handler);
        };
      },
      request: requestCaptured,
      subscribe: (params) => requestCaptured('events.subscribe', params),
      unsubscribe: async (subscriptionId, scope) => {
        await requestCaptured('events.unsubscribe', { workspaceId: scope, subscriptionId });
      },
      onNotification(handler) {
        if (!current()) return () => {};
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      // A captured connection never reconnects under a replacement principal.
      onReconnected: () => () => {},
      fenceEvents: (subscriptionIds) => requestCaptured('events.fence', { subscriptionIds }),
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}
