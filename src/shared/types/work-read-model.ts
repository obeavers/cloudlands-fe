/** Mirrors intent-core::work_read_model; these contracts do not register a channel. */
import { z } from 'zod';
import { NativeChangeRefSchema, NativeStateRefSchema, VcsKindSchema } from './vcs';
import { TaskRevisionRefSchema } from './work';

const id = z.string().min(1);
const counter = z.number().int().safe().nonnegative();
const ReadModelRootSchema = z.strictObject({
  workspaceId: id,
  rootId: id,
  repositoryId: id,
  kind: VcsKindSchema,
  epoch: counter,
});
const ReadModelChannelSchema = z.enum(['vcs', 'work']);
export type ReadModelChannel = z.infer<typeof ReadModelChannelSchema>;
const IndexedFileSchema = z.strictObject({
  path: z.string(),
  oldPath: z.string().nullable(),
  added: counter.nullable(),
  removed: counter.nullable(),
});
export const ReadModelItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('change'),
    value: z.strictObject({
      id,
      root: ReadModelRootSchema,
      change: NativeChangeRefSchema.nullable(),
      turnAttempt: z.string().nullable(),
      agentId: z.string().nullable(),
      model: z.string().nullable(),
      files: z.array(IndexedFileSchema),
      state: z.enum(['unrecorded', 'recording', 'recorded', 'published']),
    }),
  }),
  z.strictObject({
    kind: z.literal('dirtySet'),
    value: z.strictObject({
      id,
      root: ReadModelRootSchema,
      paths: z.array(z.string()),
    }),
  }),
  z.strictObject({
    kind: z.literal('binding'),
    value: z.strictObject({
      id,
      bindingId: id,
      taskRevision: TaskRevisionRefSchema,
      root: ReadModelRootSchema.nullable(),
      active: z.boolean(),
    }),
  }),
  z.strictObject({
    kind: z.literal('candidate'),
    value: z.strictObject({
      id,
      candidateId: id,
      root: ReadModelRootSchema,
      taskRevision: TaskRevisionRefSchema,
      state: NativeStateRefSchema,
      materializationId: id,
      selectionRevision: id,
      compositionRevision: id,
    }),
  }),
  z.strictObject({
    kind: z.literal('check'),
    value: z.strictObject({
      id,
      runId: id,
      candidateId: id,
      checkerId: id,
      kind: id,
      origin: z.enum(['runner-observation', 'agent-claim']),
      outcome: z.enum(['passed', 'failed', 'cancelled', 'error', 'uncertain']).nullable(),
      taskRevision: TaskRevisionRefSchema.nullable(),
      state: NativeStateRefSchema.nullable(),
      materializationId: id.nullable(),
      outputDigest: id.nullable(),
      artifactCount: counter,
      coverageCount: counter,
      startedAt: z.string(),
      completedAt: z.string().nullable(),
    }),
  }),
  z.strictObject({
    kind: z.literal('offer'),
    value: z.strictObject({
      id,
      offerId: id,
      taskRevision: TaskRevisionRefSchema,
      completionNoteRev: counter,
      offerDigest: id,
      createdAt: z.string(),
    }),
  }),
  z.strictObject({
    kind: z.literal('taskTransition'),
    value: z.strictObject({
      id,
      operationId: id,
      taskRevision: TaskRevisionRefSchema,
      completionKind: z.enum(['confirmed', 'completed-without-confirmation']),
      receiptDigest: id,
      completedAt: z.string(),
    }),
  }),
  z.strictObject({
    kind: z.literal('receipt'),
    value: z.strictObject({
      id,
      operationId: id,
      offerId: id,
      offerDigest: id,
      taskRevision: TaskRevisionRefSchema,
      decision: z.enum(['accept', 'request-changes', 'reject']),
      receiptDigest: id,
      decidedAt: z.string(),
    }),
  }),
]);
export type ReadModelItem = z.infer<typeof ReadModelItemSchema>;
export const ReadModelCursorSchema = z.strictObject({ sequence: counter, stateToken: id });
export type ReadModelCursor = z.infer<typeof ReadModelCursorSchema>;
const scope = {
  workspaceId: id,
  channel: ReadModelChannelSchema,
  ...ReadModelCursorSchema.shape,
};
export const ReadModelFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...scope, type: z.literal('snapshot'), items: z.array(ReadModelItemSchema) }),
  z.strictObject({
    ...scope,
    type: z.literal('delta'),
    previousSequence: counter,
    upserts: z.array(ReadModelItemSchema),
    removedIds: z.array(id),
  }),
]);
export type ReadModelFrame = z.infer<typeof ReadModelFrameSchema>;

function readModelItemChannel(item: ReadModelItem): ReadModelChannel {
  return item.kind === 'change' || item.kind === 'dirtySet' ? 'vcs' : 'work';
}

/** Validate each row before any reconciliation so invalid rows cannot advance a cursor. */
export function readModelItemInScope(
  item: ReadModelItem,
  workspaceId: string,
  channel: ReadModelChannel,
): boolean {
  if (readModelItemChannel(item) !== channel) return false;
  if (
    item.kind === 'taskTransition' &&
    item.value.id !== `task-transition:${item.value.operationId}`
  )
    return false;
  const value = item.value;
  if (
    'taskRevision' in value &&
    value.taskRevision &&
    value.taskRevision.workspaceId !== workspaceId
  )
    return false;
  if ('root' in value && value.root && value.root.workspaceId !== workspaceId) return false;
  if (item.kind === 'change' && item.value.change)
    return (
      item.value.root.kind === item.value.change.kind &&
      item.value.root.repositoryId === item.value.change.repositoryId
    );
  if (item.kind === 'candidate')
    return (
      item.value.root.kind === item.value.state.kind &&
      item.value.root.repositoryId === item.value.state.repositoryId
    );
  return true;
}

/** A capability loss cannot turn an existing Atomic projection into legacy Git. */
export function readModelItemRequiresAtomic(item: ReadModelItem): boolean {
  return (
    ('root' in item.value && item.value.root?.kind === 'atomic') ||
    ((item.kind === 'candidate' || item.kind === 'check') && item.value.state?.kind === 'atomic')
  );
}
