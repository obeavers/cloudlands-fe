/** Synthetic named-preview data only. This module installs no transport or AppClient port. */
import { WorkConfirmationCardSchema } from '$shared/types/work-confirmation-card';
import type { TaskConfirmationReview } from '$store/renderer/slices/task-confirmation/task-confirmation-slice';
import type { ConfirmationOutcome } from '$shared/types/work';
export function confirmationPreviewReview(
  scene = 'ready',
  completionNoteRev = 3,
): TaskConfirmationReview {
  const taskRevision = {
    workspaceId: 'preview-workspace',
    noteId: 'preview-task',
    rev: 3,
    digest: 'task-digest',
    projectionSchemaVersion: 1,
  };
  const authority = {
    workspaceId: 'preview-workspace',
    principalId: 'preview-human',
    hostRole: 'owner',
    facts: {},
    digest: 'authority-digest',
  };
  const check = {
    runId: 'run',
    specDigest: 'spec-digest',
    observationDigest: 'observation-digest',
    origin: scene === 'agent-claim' ? 'agent-claim' : 'runner-observation',
  };
  const basis = {
    taskRevision,
    completionNoteRev,
    target: null,
    subjectDigest: 'settlement-digest',
    evidenceDigest: 'evidence-digest',
    checkRevisions: [check],
    reviewDigest: 'review-digest',
    reportDigest: null,
  };
  const unavailable = { status: 'unavailable', reason: 'notRetainedAsTypedEvidence' };
  const card = WorkConfirmationCardSchema.parse({
    offer: {
      inputs: {
        offerId: 'offer',
        taskRevision,
        subject: { kind: 'noSource', settlementId: 'settlement' },
        expectedTarget: null,
        triageReference: null,
        reportDigest: null,
        reviewRevisions: [],
        satisfiedCriteria: ['criterion'],
        outstandingCriteria: [],
      },
      authority,
      basis,
      offerDigest: 'offer-digest',
      createdAt: '2026-11-13T00:00:00Z',
    },
    task: {
      status: 'available',
      value: {
        reference: taskRevision,
        title: 'Explain the timeout and its recovery',
        content: 'Find why the final update can disappear and describe how the client recovers.',
        taskJson: '{}',
        criteria: [
          {
            criterionId: 'criterion',
            index: 0,
            text: 'The final lost update recovers without another event.',
            textDigest: 'criterion-text-digest',
            origin: 'explicit-task-content',
            requiredKinds: ['recovery-test'],
          },
        ],
        createdAt: '2026-11-13T00:00:00Z',
      },
    },
    checks: [
      {
        revision: check,
        detail:
          scene === 'missing-evidence'
            ? { status: 'unavailable', reason: 'byteBudget' }
            : {
                status: 'available',
                value: {
                  spec: {
                    runId: 'run',
                    candidateId: 'candidate',
                    checkerId: 'recovery-checker',
                    configurationDigest: 'config-digest',
                    environmentDigest: 'environment-digest',
                    kind: 'recovery-test',
                  },
                  origin: check.origin,
                  observation: {
                    candidateId: 'candidate',
                    taskRevision,
                    state: {
                      kind: 'git',
                      repositoryId: 'repository',
                      commit: 'commit',
                      tree: 'tree',
                    },
                    materializationId: 'materialization',
                    outcome: 'passed',
                    outputDigest: 'output-digest',
                    artifactDigests: [],
                    coverage: [{ criterionId: 'criterion', evidenceKind: 'recovery-test' }],
                  },
                  startedAt: '2026-11-13T00:00:00Z',
                  completedAt: '2026-11-13T00:00:01Z',
                },
              },
      },
    ],
    staleness:
      scene === 'stale'
        ? ['taskChanged']
        : scene === 'missing-evidence'
          ? ['evidenceUnavailable']
          : [],
    actualResult: unavailable,
    reviews: unavailable,
    triage: unavailable,
    narrative: unavailable,
    readBasis: {
      workspaceId: 'preview-workspace',
      scope: { kind: 'taskLedger', taskRevision },
      sourceEventWatermark: 7,
      projectorWatermark: null,
      queryVersion: 1,
      ontologyVersion: 'intent-confirmation-card/v1',
      visibilityDigest: 'visible',
      ignorePolicy: 'notAppliedToLedgerFacts',
      coverage: { returnedRecords: 1, omittedForBytes: 0, retainedPageComplete: true },
      truncation: [],
    },
  });
  const request = {
    operationId: 'decision',
    offerId: 'offer',
    offerDigest: 'offer-digest',
    decision: scene === 'changes-requested' ? ('request-changes' as const) : ('accept' as const),
    reason:
      scene === 'changes-requested'
        ? 'Include the interrupted capture case before confirming.'
        : null,
    humanReviewScope: 'confirmation-only' as const,
  };
  const outcome: ConfirmationOutcome = {
    confirmation: {
      request,
      authority: card.offer.authority,
      basis: card.offer.basis,
      receiptDigest: 'confirmation-digest',
      decidedAt: '2026-11-13T00:01:00Z',
    },
    taskTransition:
      scene === 'confirmed'
        ? {
            operationId: 'decision',
            completionKind: 'confirmed',
            taskRevision: card.offer.inputs.taskRevision,
            principalId: 'preview-human',
            noteRevAfter: completionNoteRev + 1,
            noteVersion: completionNoteRev + 1,
            createdAt: '2026-11-13T00:01:00Z',
          }
        : null,
  };
  return {
    owner: {
      workspaceId: 'preview-workspace',
      reviewId: 'preview-review',
      completionNoteRev,
      noteId: 'preview-task',
      offerId: 'offer',
      offerDigest: 'offer-digest',
    },
    phase:
      scene === 'unavailable'
        ? 'unavailable'
        : scene === 'uncertain'
          ? 'uncertain'
          : ['confirmed', 'confirmation-only', 'changes-requested'].includes(scene)
            ? 'settled'
            : card.staleness.length
              ? 'stale'
              : 'ready',
    card: scene === 'unavailable' ? null : card,
    stateToken: 'state-token',
    reason: '',
    independentCodeReview: false,
    request:
      scene === 'uncertain' ||
      ['confirmed', 'confirmation-only', 'changes-requested'].includes(scene)
        ? request
        : null,
    outcome: ['confirmed', 'confirmation-only', 'changes-requested'].includes(scene)
      ? outcome
      : null,
  };
}
