/** Opt-in prepared protocol adapter. Ambient backend routing cannot establish a captured lease. */
import { z } from 'zod';
import { ReadModelFrameSchema, type ReadModelChannel } from '$shared/types/work-read-model';
import type { BackendNotification } from './backend-transport-types';
import type { ReadModelSubscriptionPort } from './neutral-read-model-subscription';
import { NeutralContractError, type NeutralServiceLifetime } from './neutral-client-support';
import type { Unsubscribe } from '../app-client';

/** All operations address the same captured backend/account/physical connection. */
export interface ReadModelRpcTransport {
  request(method: string, params: unknown): Promise<unknown>;
  subscribe(params: unknown): Promise<unknown>;
  unsubscribe(subscriptionId: string, workspaceId: string): Promise<void>;
  onNotification(handler: (notification: BackendNotification) => void): Unsubscribe;
  onReconnected(handler: () => void): Unsubscribe;
  /**
   * Resolve an events.fence bulk-lane ack only after its preceding notification
   * callbacks were processed on this captured connection, including across IPC.
   * An ordinary request promise is insufficient. Absence refuses registration.
   */
  fenceEvents?(subscriptionIds: string[]): Promise<unknown>;
}
const responseSchema = z.strictObject({ frames: z.array(ReadModelFrameSchema) });
const subscriptionSchema = z.object({
  subscriptionId: z.string().min(1),
  lossRecovery: z.literal(1),
});
const fenceSchema = z.strictObject({ subscriptionIds: z.array(z.string().min(1)) });
const lossSchema = z.object({
  subscriptionId: z.string().min(1),
  generation: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine((value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n),
  scope: z.strictObject({ workspaceId: z.string().min(1) }),
});
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_BUFFER_FRAMES = 512;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_EARLY_LOSS_IDS = 64;

export function createReadModelRpcPort(
  channel: ReadModelChannel,
  transport: ReadModelRpcTransport,
  admission: Pick<NeutralServiceLifetime, 'isCurrent' | 'capabilities'>,
): ReadModelSubscriptionPort {
  const current = () =>
    admission.isCurrent() &&
    admission.capabilities()?.eventStreamRecovery === 1 &&
    typeof transport.fenceEvents === 'function';
  return {
    onReconnect: (handler) => transport.onReconnected(handler),
    async subscribe(workspaceId, cursor, push, onInvalidated) {
      if (!current()) throw new NeutralContractError('unavailable');
      let subscriptionId: string | undefined;
      let admitted = false;
      let ready = false;
      let closed = false;
      let overflow = false;
      let lossOverflow = false;
      let bytes = 0;
      let lossGeneration = 0n;
      const earlyLoss = new Map<string, bigint>();
      const pending: { subscriptionId: string; frame: unknown }[] = [];
      const eventType = channel === 'vcs' ? 'vcs:delta' : 'work:delta';
      const invalidate = () => {
        if (!closed) {
          dispose();
          onInvalidated();
        }
      };
      const off = transport.onNotification((notification) => {
        if (closed || !current()) return;
        if (notification.method === 'events.lost') {
          const loss = lossSchema.safeParse(notification.params);
          if (!loss.success || loss.data.scope.workspaceId !== workspaceId) return;
          const generation = BigInt(loss.data.generation);
          if (!admitted) {
            if (earlyLoss.size >= MAX_EARLY_LOSS_IDS && !earlyLoss.has(loss.data.subscriptionId)) {
              earlyLoss.clear();
              lossOverflow = true;
              return;
            }
            if (!lossOverflow && generation > (earlyLoss.get(loss.data.subscriptionId) ?? 0n))
              earlyLoss.set(loss.data.subscriptionId, generation);
          } else if (loss.data.subscriptionId === subscriptionId && generation > lossGeneration) {
            lossGeneration = generation;
            invalidate();
          }
          return;
        }
        if (notification.method !== 'events.event' || !object(notification.params)) return;
        const params = notification.params,
          event = params.event;
        if (typeof params.subscriptionId !== 'string' || !object(event) || event.type !== eventType)
          return;
        if (subscriptionId !== undefined && params.subscriptionId !== subscriptionId) return;
        if (
          object(event.data) &&
          typeof event.data.workspaceId === 'string' &&
          event.data.workspaceId !== workspaceId
        )
          return;
        if (ready) {
          push(event.data);
          return;
        }
        if (overflow) return;
        let size: number;
        try {
          size = new TextEncoder().encode(JSON.stringify(event.data)).byteLength;
        } catch {
          overflow = true;
          return;
        }
        if (pending.length >= MAX_BUFFER_FRAMES || bytes + size > MAX_BUFFER_BYTES) {
          overflow = true;
          pending.length = 0;
          return;
        }
        bytes += size;
        pending.push({ subscriptionId: params.subscriptionId, frame: event.data });
      });
      const dispose = () => {
        if (closed) return;
        closed = true;
        off();
        pending.length = 0;
        earlyLoss.clear();
        if (subscriptionId) void transport.unsubscribe(subscriptionId, workspaceId).catch(() => {});
      };
      const fence = async () => {
        if (closed || !current() || !subscriptionId || !transport.fenceEvents)
          throw new Error('Read-model fence unavailable');
        const result = fenceSchema.safeParse(await transport.fenceEvents([subscriptionId]));
        if (
          closed ||
          !current() ||
          !result.success ||
          result.data.subscriptionIds.length !== 1 ||
          result.data.subscriptionIds[0] !== subscriptionId
        )
          throw new Error('Read-model fence refused');
      };
      try {
        const raw = await transport.subscribe({
          workspaceId,
          eventTypes: [eventType],
          lossRecovery: 1,
        });
        if (object(raw) && typeof raw.subscriptionId === 'string' && raw.subscriptionId)
          subscriptionId = raw.subscriptionId;
        const subscription = subscriptionSchema.safeParse(raw);
        if (closed || !current() || !subscription.success)
          throw new NeutralContractError('unavailable');
        subscriptionId = subscription.data.subscriptionId;
        admitted = true;
        if (lossOverflow || earlyLoss.has(subscriptionId)) {
          invalidate();
          throw new Error('Read-model admission lost');
        }
        earlyLoss.clear();
        await fence();
        if (closed || !current()) throw new Error('Read-model capture retired');
        const response = responseSchema.safeParse(
          await transport.request(channel === 'vcs' ? 'vcs.subscribe' : 'work.subscribe', {
            workspaceId,
            ...(cursor === null ? {} : { after: cursor }),
          }),
        );
        if (
          closed ||
          !current() ||
          !response.success ||
          overflow ||
          (cursor === null && response.data.frames.length === 0) ||
          response.data.frames.some(
            (frame) => frame.workspaceId !== workspaceId || frame.channel !== channel,
          )
        )
          throw new Error('Read-model capture refused');
        await fence();
        const drain = () => {
          const frames = pending
            .splice(0)
            .filter((entry) => entry.subscriptionId === subscriptionId)
            .map((entry) => entry.frame);
          const parsed = frames.map((frame) => ReadModelFrameSchema.safeParse(frame));
          if (parsed.some((frame) => !frame.success))
            throw new Error('Read-model pending frame refused');
          return parsed
            .flatMap((frame) => (frame.success ? [frame.data] : []))
            .sort((a, b) => a.sequence - b.sequence);
        };
        const buffered = drain();
        for (const frame of response.data.frames) push(frame);
        for (const frame of buffered) push(frame);
        while (pending.length) for (const frame of drain()) push(frame);
        ready = true;
        return dispose;
      } catch (error) {
        dispose();
        if (error instanceof NeutralContractError) throw error;
        throw new Error('Read-model subscription unavailable');
      }
    },
  };
}
