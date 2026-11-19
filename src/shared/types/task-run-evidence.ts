/** Public retained observations. These read models grant no execution or completion authority. */
import { z } from 'zod';
import { TaskRevisionRefSchema } from './work';
import { NativeChangeRefSchema, VcsKindSchema } from './vcs';

const id = z.string().min(1).max(4096);
const counter = z.number().int().safe().nonnegative();
const cursor = z.string().min(1).max(4096);
const publicRoot = z.strictObject({
  repositoryId: id,
  rootId: id,
  rootEpoch: counter,
  kind: VcsKindSchema,
});
const originalRun = z.strictObject({
  agentId: id,
  taskRevision: TaskRevisionRefSchema,
  confirmedAt: z.string(),
  admission: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('awaitingFirstAdmission') }),
    z.strictObject({
      status: z.literal('admitted'),
      bindingId: id,
      turnAttempt: id,
      admittedAt: z.string(),
    }),
  ]),
});
const categoryCoverage = z.strictObject({
  returnedRecords: counter,
  retainedPageComplete: z.boolean(),
  byteLimited: z.boolean(),
});
const unavailable = z.strictObject({
  status: z.literal('unavailable'),
  reason: z.literal('noQualifiedRunLinkage'),
});
const readBasis = z.strictObject({
  queryVersion: z.literal(1),
  sourceEventWatermark: counter,
  scope: z.enum(['confirmedRuns', 'firstConfirmedTurnOnly']),
});
const next = z.strictObject({ contributions: cursor.nullable(), effects: cursor.nullable() });

export const TaskEvidenceRequestSchema = z.strictObject({
  workspaceId: id,
  noteId: id,
  query: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('runs'),
      after: cursor.optional(),
      limit: counter.min(1).max(20).optional(),
    }),
    z.strictObject({
      kind: z.literal('run'),
      agentId: id,
      page: z
        .strictObject({
          after: z
            .strictObject({ contributions: cursor.optional(), effects: cursor.optional() })
            .optional(),
          limit: counter.min(1).max(20).optional(),
        })
        .optional(),
    }),
  ]),
});
export type TaskEvidenceRequest = z.infer<typeof TaskEvidenceRequestSchema>;

const TaskEvidenceResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('runs'),
    workspaceId: id,
    noteId: id,
    runs: z.array(originalRun).max(20),
    next: cursor.nullable(),
    coverage: categoryCoverage,
    readBasis,
  }),
  z.strictObject({
    kind: z.literal('run'),
    workspaceId: id,
    noteId: id,
    run: originalRun,
    source: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('available'),
        titlePreview: z.string(),
        titleTruncated: z.boolean(),
        purpose: z.enum(['source', 'research', 'review']).nullable(),
        criteria: z
          .array(
            z.strictObject({
              index: counter,
              textPreview: z.string(),
              textTruncated: z.boolean(),
              textDigest: id,
              requiredKinds: z.array(id).max(16),
            }),
          )
          .max(128),
        criteriaTotal: counter,
        criteriaOmitted: counter,
      }),
      z.strictObject({
        status: z.literal('unavailable'),
        reason: z.enum(['sourceNotRetained', 'sourceByteBudget']),
      }),
    ]),
    binding: z.strictObject({
      bindingId: id,
      turnAttempt: id,
      root: publicRoot.nullable(),
      nativeState: z.enum(['not-required', 'pending', 'acknowledged']),
      admissionActive: z.boolean(),
      createdAt: z.string(),
    }),
    contributions: z
      .array(
        z.strictObject({
          operationId: id,
          bindingId: id,
          root: publicRoot,
          change: NativeChangeRefSchema,
          provenance: z.enum([
            'historicalAssociationUnproven',
            'recordingGovernanceOnlySharedWorkingCopy',
          ]),
          receiptDigest: id,
          recordedAt: z.string(),
        }),
      )
      .max(20),
    effects: z
      .array(
        z.strictObject({ operationId: id, grantId: id, effectDigest: id, committedAt: z.string() }),
      )
      .max(20),
    next,
    checks: unavailable,
    reviews: unavailable,
    settlement: unavailable,
    coverage: z.strictObject({ contributions: categoryCoverage, effects: categoryCoverage }),
    readBasis,
  }),
]);
export type TaskEvidenceResponse = z.infer<typeof TaskEvidenceResponseSchema>;
export type TaskEvidenceRun = Extract<TaskEvidenceResponse, { kind: 'run' }>;

/** Validate exact response association; task digests and DTOs are never permission. */
export function decodeTaskEvidence(input: TaskEvidenceRequest, raw: unknown): TaskEvidenceResponse {
  if (new TextEncoder().encode(JSON.stringify(raw)).length > 128 * 1024)
    throw new Error('Task evidence exceeds the public byte budget');
  const response = TaskEvidenceResponseSchema.parse(raw);
  if (
    response.kind !== input.query.kind ||
    response.workspaceId !== input.workspaceId ||
    response.noteId !== input.noteId
  )
    throw new Error('Task evidence scope mismatch');
  const runs = response.kind === 'runs' ? response.runs : [response.run];
  if (
    runs.some(
      (run) =>
        run.taskRevision.workspaceId !== input.workspaceId ||
        run.taskRevision.noteId !== input.noteId,
    ) ||
    new Set(runs.map((run) => run.agentId)).size !== runs.length
  )
    throw new Error('Task evidence run mismatch');
  if (response.kind === 'runs') {
    if (
      response.readBasis.scope !== 'confirmedRuns' ||
      response.coverage.returnedRecords !== response.runs.length ||
      (input.query.kind === 'runs' && response.next !== null && response.next === input.query.after)
    )
      throw new Error('Task evidence page mismatch');
    return response;
  }
  if (
    input.query.kind !== 'run' ||
    response.run.agentId !== input.query.agentId ||
    response.run.admission.status !== 'admitted' ||
    response.readBasis.scope !== 'firstConfirmedTurnOnly' ||
    response.binding.bindingId !== response.run.admission.bindingId ||
    response.binding.turnAttempt !== response.run.admission.turnAttempt
  )
    throw new Error('Task evidence binding mismatch');
  const root = response.binding.root;
  if (
    response.contributions.some(
      (item) =>
        item.bindingId !== response.binding.bindingId ||
        !root ||
        JSON.stringify(item.root) !== JSON.stringify(root) ||
        item.change.kind !== item.root.kind ||
        item.change.repositoryId !== item.root.repositoryId,
    )
  )
    throw new Error('Task evidence contribution mismatch');
  if (
    new Set(response.contributions.map((item) => item.operationId)).size !==
      response.contributions.length ||
    new Set(response.effects.map((item) => item.operationId)).size !== response.effects.length ||
    response.coverage.contributions.returnedRecords !== response.contributions.length ||
    response.coverage.effects.returnedRecords !== response.effects.length
  )
    throw new Error('Task evidence coverage mismatch');
  if (
    response.source.status === 'available' &&
    (response.source.criteria.length + response.source.criteriaOmitted !==
      response.source.criteriaTotal ||
      new Set(response.source.criteria.map((item) => item.index)).size !==
        response.source.criteria.length)
  )
    throw new Error('Task evidence source preview mismatch');
  for (const category of ['contributions', 'effects'] as const) {
    const after = input.query.page?.after?.[category];
    if (after && response.next[category] === after)
      throw new Error('Task evidence cursor did not advance');
  }
  return response;
}
