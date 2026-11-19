import { z } from 'zod';
import { IPC_CHANNELS } from '$shared/ipc-registry';
import {
  NeutralWorkspaceCaptureSchema,
  NeutralWorkspaceIngressSchema,
  NeutralWorkspaceQuerySchema,
  NeutralWorkspaceRequestSchema,
  neutralCapabilities,
  type NeutralWorkspaceContext,
  type NeutralWorkspaceIngress,
} from '$shared/types/neutral-workspace';
import { NeutralContractError } from './neutral-client-support';

/** One bridge and one main-owned physical session; ordinary backend IPC is never used. */
export function createNeutralWorkspaceTransport(
  getBridge: () => Window['electronAPI'] | undefined,
) {
  const channels = IPC_CHANNELS.BACKEND.NEUTRAL_WORKSPACE;
  const unavailable = () => new NeutralContractError('unavailable');
  const response = z
    .object({
      ok: z.literal(true),
      result: z.unknown(),
      barrier: z.number().int().safe().positive().optional(),
    })
    .strict();
  return async (workspaceId: string): Promise<NeutralWorkspaceContext> => {
    const query = NeutralWorkspaceQuerySchema.parse({ workspaceId });
    const bridge = getBridge();
    if (!bridge) throw unavailable();
    let id: string | undefined;
    let retired = false;
    let released = false;
    let processed = 0;
    let bufferedBytes = 0;
    let gapTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Map<number, NeutralWorkspaceIngress>();
    const early: NeutralWorkspaceIngress[] = [];
    const listeners = new Set<(notification: { method: string; params?: unknown }) => void>();
    const retirements = new Set<() => void>();
    const waiters = new Set<{ sequence: number; resolve: () => void; reject: () => void }>();
    const retire = () => {
      if (retired) return;
      retired = true;
      clearTimeout(gapTimer);
      gapTimer = undefined;
      for (const waiter of [...waiters]) waiter.reject();
      waiters.clear();
      for (const listener of [...retirements]) {
        try {
          listener();
        } catch {
          /* Notify all consumers. */
        }
      }
      retirements.clear();
      listeners.clear();
      pending.clear();
      early.length = 0;
      bufferedBytes = 0;
    };
    const current = () => {
      if (getBridge() !== bridge) retire();
      return !retired && !released;
    };
    const accept = (item: NeutralWorkspaceIngress) => {
      if (!current() || item.id !== id) return;
      if (item.sequence <= processed) {
        bufferedBytes -= new TextEncoder().encode(JSON.stringify(item)).byteLength;
        return;
      }
      if (pending.size >= 512 || pending.has(item.sequence)) {
        retire();
        return;
      }
      pending.set(item.sequence, item);
      if (item.sequence !== processed + 1 && gapTimer === undefined)
        gapTimer = setTimeout(() => {
          void release();
        }, 5_000);
      while (!retired) {
        const next = pending.get(processed + 1);
        if (!next) break;
        pending.delete(next.sequence);
        bufferedBytes -= new TextEncoder().encode(JSON.stringify(next)).byteLength;
        if (next.type === 'retired') {
          retire();
          break;
        }
        if (next.type === 'notification') {
          for (const listener of [...listeners]) {
            try {
              listener(next.notification);
            } catch {
              retire();
              break;
            }
          }
        }
        processed = next.sequence;
        for (const waiter of [...waiters])
          if (waiter.sequence <= processed) {
            waiters.delete(waiter);
            waiter.resolve();
          }
      }
      if (pending.size === 0) {
        clearTimeout(gapTimer);
        gapTimer = undefined;
      }
    };
    const listenerId = bridge.on(channels.INGRESS, (raw: unknown) => {
      if (retired || !raw || typeof raw !== 'object') return;
      if (id !== undefined && (raw as { id?: unknown }).id !== id) return;
      const parsed = NeutralWorkspaceIngressSchema.safeParse(raw);
      if (!parsed.success) {
        retire();
        return;
      }
      const size = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
      if (bufferedBytes + size > 4 * 1024 * 1024) {
        retire();
        return;
      }
      bufferedBytes += size;
      if (id === undefined) {
        if (early.length >= 128) {
          retire();
          return;
        }
        early.push(parsed.data);
      } else accept(parsed.data);
    });
    const release = async () => {
      if (released) return;
      released = true;
      retire();
      bridge.offById(channels.INGRESS, listenerId);
      if (id)
        try {
          await bridge.invoke(channels.RELEASE, { ...query, id });
        } catch {
          /* Original main owner also performs bounded cleanup. */
        }
    };
    const requestCaptured = async (method: string, params: unknown) => {
      if (!current() || !id) throw unavailable();
      const request = NeutralWorkspaceRequestSchema.parse({ method, params });
      const result = response.safeParse(
        await bridge.invoke(channels.REQUEST, { ...query, id, request }),
      );
      if (!result.success || !current()) {
        void release();
        throw unavailable();
      }
      return result.data;
    };
    try {
      const raw = response.parse(await bridge.invoke(channels.CAPTURE, query)).result;
      const known = z.object({ id: z.string().min(1).max(128) }).safeParse(raw);
      if (known.success) id = known.data.id;
      const capture = NeutralWorkspaceCaptureSchema.parse(raw);
      id = capture.id;
      if (
        capture.workspaceId !== workspaceId ||
        !neutralCapabilities({ server: { capabilities: capture.capabilities } })
      )
        throw unavailable();
      for (const item of early.splice(0)) {
        if (item.id === id) accept(item);
        else bufferedBytes -= new TextEncoder().encode(JSON.stringify(item)).byteLength;
      }
      if (!current()) throw unavailable();
      return {
        workspaceId,
        principalId: capture.principalId,
        capabilities: Object.freeze(capture.capabilities),
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
        request: async (method, params) => (await requestCaptured(method, params)).result,
        subscribe: async (params) => (await requestCaptured('events.subscribe', params)).result,
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
        onReconnected: () => () => {},
        async fenceEvents(subscriptionIds) {
          const result = await requestCaptured('events.fence', { subscriptionIds });
          if (result.barrier === undefined) {
            void release();
            throw unavailable();
          }
          const sequence = result.barrier;
          // Invoke replies and pushed messages use distinct Electron lanes. Only a
          // marker on the sequenced ingress proves preceding callbacks completed.
          if (processed < sequence)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                waiters.delete(waiter);
                void release();
                reject(unavailable());
              }, 5_000);
              const waiter = {
                sequence,
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
                reject: () => {
                  clearTimeout(timer);
                  reject(unavailable());
                },
              };
              waiters.add(waiter);
              if (!current()) waiter.reject();
            });
          if (!current()) throw unavailable();
          return result.result;
        },
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  };
}
