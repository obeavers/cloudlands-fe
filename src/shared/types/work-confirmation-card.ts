/** Exact intent-core confirmation_card + LedgerReadBasis mirrors; no RPC registration. */
import { z } from 'zod';
import {
  ConfirmationOfferSchema,
  CandidateCheckRunSchema,
  TaskRevisionRefSchema,
  TaskRevisionSchema,
} from './work';
import { NativeChangeRefSchema, NativeStateRefSchema } from './vcs';
const id = z.string().min(1);
const counter = z.number().int().safe().nonnegative();
const root = z.strictObject({ repositoryId: id, rootId: id, rootEpoch: counter });
const LedgerReadBasisSchema = z.strictObject({
  workspaceId: id,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('taskLedger'), taskRevision: TaskRevisionRefSchema }),
    z.strictObject({
      kind: z.literal('candidateLedger'),
      candidateId: id,
      taskRevision: TaskRevisionRefSchema,
      compositionRevision: id,
    }),
    z.strictObject({ kind: z.literal('recordedChange'), root, change: NativeChangeRefSchema }),
    z.strictObject({
      kind: z.literal('recordedLine'),
      root,
      state: NativeStateRefSchema,
      path: z.string(),
      line: counter,
    }),
  ]),
  sourceEventWatermark: counter,
  projectorWatermark: counter.nullable(),
  queryVersion: z.literal(1),
  ontologyVersion: z.literal('intent-confirmation-card/v1'),
  visibilityDigest: id,
  ignorePolicy: z.literal('notAppliedToLedgerFacts'),
  coverage: z.strictObject({
    returnedRecords: counter,
    omittedForBytes: counter,
    retainedPageComplete: z.boolean(),
  }),
  truncation: z.array(z.enum(['recordLimit', 'byteLimit'])),
});
const unavailableReason = z.enum([
  'missing',
  'changed',
  'byteBudget',
  'notRetainedAsTypedEvidence',
]);
const unavailable = z.strictObject({ status: z.literal('unavailable'), reason: unavailableReason });
const detail = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), value }),
    unavailable,
  ]);
const revision = z.strictObject({
  runId: id,
  specDigest: id,
  observationDigest: id.nullable(),
  origin: z.enum(['runner-observation', 'agent-claim']),
});
export const WorkConfirmationCardSchema = z.strictObject({
  offer: ConfirmationOfferSchema,
  task: detail(TaskRevisionSchema),
  checks: z.array(z.strictObject({ revision, detail: detail(CandidateCheckRunSchema) })),
  staleness: z.array(
    z.enum([
      'taskMissing',
      'taskChanged',
      'checkMissing',
      'checkChanged',
      'rootChanged',
      'targetNotReobserved',
      'evidenceUnavailable',
      'authorityNotRevalidated',
      'authorityChanged',
    ]),
  ),
  actualResult: unavailable,
  reviews: unavailable,
  triage: unavailable,
  narrative: unavailable,
  readBasis: LedgerReadBasisSchema,
});
export type WorkConfirmationCard = z.infer<typeof WorkConfirmationCardSchema>;
