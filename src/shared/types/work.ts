/** Internal mirrors of intent-core::work_evidence; no authority is inferred from evidence. */
import { z } from 'zod';
import { NativeChangeRefSchema, NativeStateRefSchema, RootBindingSchema } from './vcs';

const id = z.string().min(1);
const integer = z.number().int().safe();
/** Prospective requirements; paths are declarations, never access grants. */
export const TaskWorkDefinitionSchema = z.strictObject({
  purpose: z.enum(['source', 'research', 'review']),
  criteria: z
    .array(
      z.strictObject({
        index: integer.nonnegative(),
        textDigest: z.string().regex(/^[a-f0-9]{64}$/),
        requiredKinds: z
          .array(
            z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z0-9-]+$/),
          )
          .min(1)
          .max(16),
      }),
    )
    .max(128),
  files: z
    .array(
      z.strictObject({
        rootId: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[a-zA-Z0-9_-]+$/),
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (path) =>
              path === '.' ||
              (!/[\\:\u0000-\u001f\u007f]/.test(path) &&
                path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')),
          ),
        role: z.enum(['reference', 'in-scope', 'out-of-scope']),
      }),
    )
    .max(512),
});
export type TaskWorkDefinition = z.infer<typeof TaskWorkDefinitionSchema>;
export const TaskRevisionRefSchema = z.strictObject({
  workspaceId: id,
  noteId: id,
  rev: integer,
  digest: id,
  projectionSchemaVersion: z.literal(1),
});
export type TaskRevisionRef = z.infer<typeof TaskRevisionRefSchema>;

/** Exact retained task text, not the current mutable note projection. */
export const TaskRevisionSchema = z.strictObject({
  reference: TaskRevisionRefSchema,
  title: z.string(),
  content: z.string(),
  taskJson: z.string(),
  criteria: z.array(
    z.strictObject({
      criterionId: id,
      index: integer.nonnegative(),
      text: z.string(),
      textDigest: id,
      origin: z.enum(['explicit-task-content', 'deterministic-parse', 'model-proposal']),
      requiredKinds: z.array(id),
    }),
  ),
  createdAt: z.string(),
});

export const WorkCandidateSchema = z.strictObject({
  candidateId: id,
  root: RootBindingSchema,
  taskRevision: TaskRevisionRefSchema,
  state: NativeStateRefSchema,
  materializationId: id,
  selectionRevision: id,
  compositionRevision: id,
});
export type WorkCandidate = z.infer<typeof WorkCandidateSchema>;

const EvidenceOriginSchema = z.enum(['runner-observation', 'agent-claim']);
const CandidateCheckSpecSchema = z.strictObject({
  runId: id,
  candidateId: id,
  checkerId: id,
  configurationDigest: id,
  environmentDigest: id,
  kind: id,
});
const CheckObservationSchema = z.strictObject({
  candidateId: id,
  taskRevision: TaskRevisionRefSchema,
  state: NativeStateRefSchema,
  materializationId: id,
  outcome: z.enum(['passed', 'failed', 'cancelled', 'error', 'uncertain']),
  outputDigest: id,
  artifactDigests: z.array(id),
  coverage: z.array(z.strictObject({ criterionId: id, evidenceKind: id })),
});
export const CandidateCheckRunSchema = z.strictObject({
  spec: CandidateCheckSpecSchema,
  origin: EvidenceOriginSchema,
  observation: CheckObservationSchema.nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type CandidateCheckRun = z.infer<typeof CandidateCheckRunSchema>;

const HumanAuthoritySnapshotSchema = z.strictObject({
  workspaceId: id,
  principalId: id,
  hostRole: z.enum(['owner', 'member', 'guest']),
  facts: z.json(),
  digest: id,
});
const ConfirmationTargetSchema = z.strictObject({
  root: RootBindingSchema,
  state: NativeStateRefSchema,
  workingDigest: id,
});
const ConfirmationSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('source'),
    candidate: WorkCandidateSchema,
    selectedChanges: z.array(NativeChangeRefSchema),
    dependencyChanges: z.array(NativeChangeRefSchema),
    closureDigest: id,
  }),
  z.strictObject({ kind: z.literal('noSource'), settlementId: id }),
]);
const ConfirmationOfferInputsSchema = z.strictObject({
  offerId: id,
  taskRevision: TaskRevisionRefSchema,
  subject: ConfirmationSubjectSchema,
  expectedTarget: ConfirmationTargetSchema.nullable(),
  triageReference: z.string().nullable(),
  reportDigest: id.nullable(),
  reviewRevisions: z.array(id),
  satisfiedCriteria: z.array(id),
  outstandingCriteria: z.array(id),
});
const ConfirmationReadBasisSchema = z.strictObject({
  taskRevision: TaskRevisionRefSchema,
  completionNoteRev: integer.nonnegative(),
  target: ConfirmationTargetSchema.nullable(),
  subjectDigest: id,
  evidenceDigest: id,
  checkRevisions: z.array(
    z.strictObject({
      runId: id,
      specDigest: id,
      observationDigest: id.nullable(),
      origin: EvidenceOriginSchema,
    }),
  ),
  reviewDigest: id,
  reportDigest: id.nullable(),
});
export const ConfirmationOfferSchema = z.strictObject({
  inputs: ConfirmationOfferInputsSchema,
  authority: HumanAuthoritySnapshotSchema,
  basis: ConfirmationReadBasisSchema,
  offerDigest: id,
  createdAt: z.string(),
});
export type ConfirmationOffer = z.infer<typeof ConfirmationOfferSchema>;

export const ConfirmationDecisionRequestSchema = z.strictObject({
  operationId: id,
  offerId: id,
  offerDigest: id,
  decision: z.enum(['accept', 'request-changes', 'reject']),
  reason: z.string().nullable(),
  humanReviewScope: z.enum(['confirmation-only', 'independent-code-review']),
});
export type ConfirmationDecisionRequest = z.infer<typeof ConfirmationDecisionRequestSchema>;
const ConfirmationReceiptSchema = z.strictObject({
  request: ConfirmationDecisionRequestSchema,
  authority: HumanAuthoritySnapshotSchema,
  basis: ConfirmationReadBasisSchema,
  receiptDigest: id,
  decidedAt: z.string(),
});

const TaskTransitionReceiptSchema = z.strictObject({
  operationId: id,
  completionKind: z.enum(['confirmed', 'completed-without-confirmation']),
  taskRevision: TaskRevisionRefSchema,
  principalId: id,
  noteRevAfter: integer,
  noteVersion: integer,
  createdAt: z.string(),
});
export const ConfirmationOutcomeSchema = z.strictObject({
  confirmation: ConfirmationReceiptSchema,
  taskTransition: TaskTransitionReceiptSchema.nullable(),
});
export type ConfirmationOutcome = z.infer<typeof ConfirmationOutcomeSchema>;
