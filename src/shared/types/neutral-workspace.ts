import { z } from 'zod';
import { ReadModelCursorSchema } from './work-read-model';
import { MemoryContextRequestSchema, MemoryListRequestSchema } from './memory-read';

export const NeutralWorkspaceQuerySchema = z.strictObject({
  workspaceId: z.string().min(1).max(512),
});
const ids = z.array(z.string().min(1).max(512)).min(1).max(8);
export const NeutralWorkspaceRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('memory.list'), params: MemoryListRequestSchema }),
  z.strictObject({ method: z.literal('memory.context'), params: MemoryContextRequestSchema }),
  z.strictObject({
    method: z.enum(['vcs.subscribe', 'work.subscribe']),
    params: NeutralWorkspaceQuerySchema.extend({
      after: ReadModelCursorSchema.optional(),
    }).strict(),
  }),
  z.strictObject({
    method: z.literal('events.subscribe'),
    params: NeutralWorkspaceQuerySchema.extend({
      eventTypes: z
        .array(z.enum(['vcs:delta', 'work:delta']))
        .min(1)
        .max(1),
      lossRecovery: z.literal(1),
    }).strict(),
  }),
  z.strictObject({
    method: z.literal('events.unsubscribe'),
    params: NeutralWorkspaceQuerySchema.extend({
      subscriptionId: z.string().min(1).max(512),
    }).strict(),
  }),
  z.strictObject({
    method: z.literal('events.fence'),
    params: z.strictObject({ subscriptionIds: ids }),
  }),
]);
export const NeutralWorkspaceBoundSchema = NeutralWorkspaceQuerySchema.extend({
  id: z.string().min(1).max(128),
}).strict();
export const NeutralWorkspaceInvokeSchema = NeutralWorkspaceBoundSchema.extend({
  request: NeutralWorkspaceRequestSchema,
}).strict();
export const NeutralWorkspaceCaptureSchema = NeutralWorkspaceBoundSchema.extend({
  principalId: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()),
}).strict();
export const NeutralWorkspaceIngressSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('notification'),
    id: z.string().min(1).max(128),
    sequence: z.number().int().safe().positive(),
    notification: z.strictObject({ method: z.string(), params: z.unknown().optional() }),
  }),
  z.strictObject({
    type: z.enum(['barrier', 'retired']),
    id: z.string().min(1).max(128),
    sequence: z.number().int().safe().positive(),
  }),
]);
export type NeutralWorkspaceIngress = z.infer<typeof NeutralWorkspaceIngressSchema>;
export interface NeutralWorkspaceContext {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly capabilities: Record<string, unknown>;
  isCurrent(): boolean;
  onRetired(handler: () => void): () => void;
  request(method: string, params: unknown): Promise<unknown>;
  subscribe(params: unknown): Promise<unknown>;
  unsubscribe(subscriptionId: string, workspaceId: string): Promise<void>;
  onNotification(handler: (notification: { method: string; params?: unknown }) => void): () => void;
  onReconnected(handler: () => void): () => void;
  fenceEvents(subscriptionIds: string[]): Promise<unknown>;
  release(): Promise<void>;
}
export function neutralCapabilities(hello: unknown): Record<string, unknown> | null {
  if (!hello || typeof hello !== 'object') return null;
  const value = hello as { connectionRole?: unknown; server?: { capabilities?: unknown } };
  if (
    value.connectionRole !== undefined ||
    !value.server?.capabilities ||
    typeof value.server.capabilities !== 'object' ||
    Array.isArray(value.server.capabilities)
  )
    return null;
  const caps = value.server.capabilities as Record<string, unknown>;
  return caps.eventStreamRecovery === 1 &&
    (caps.vcs === 1 || caps.workEvidence === 1 || caps.experimentalMemoryRead === 1)
    ? structuredClone(caps)
    : null;
}
