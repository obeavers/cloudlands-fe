/** Public protocol-shaped task.workEvidence examples, without private execution facts. */
import type { TaskEvidenceRun, TaskEvidenceResponse } from '$shared/types/task-run-evidence';

const evidenceRun = {
  agentId: 'agent-original',
  taskRevision: {
    workspaceId: 'w',
    noteId: 't',
    rev: 7,
    digest: 'a'.repeat(64),
    projectionSchemaVersion: 1 as const,
  },
  confirmedAt: '2026-11-15T12:00:00Z',
  admission: {
    status: 'admitted' as const,
    bindingId: 'binding-first',
    turnAttempt: 'attempt-first',
    admittedAt: '2026-11-15T12:00:01Z',
  },
};
export function retainedRuns(): Extract<TaskEvidenceResponse, { kind: 'runs' }> {
  return {
    kind: 'runs',
    workspaceId: 'w',
    noteId: 't',
    runs: structuredClone([evidenceRun]),
    next: null,
    coverage: { returnedRecords: 1, retainedPageComplete: true, byteLimited: false },
    readBasis: { queryVersion: 1, sourceEventWatermark: 20, scope: 'confirmedRuns' },
  };
}
export function retainedTurn(): TaskEvidenceRun {
  const root = {
    repositoryId: 'repository-original',
    rootId: 'primary',
    rootEpoch: 2,
    kind: 'git' as const,
  };
  return {
    kind: 'run',
    workspaceId: 'w',
    noteId: 't',
    run: structuredClone(evidenceRun),
    source: {
      status: 'available',
      titlePreview: 'Original requested work',
      titleTruncated: false,
      criteria: [
        {
          index: 0,
          textPreview: 'Keep the exact result',
          textTruncated: false,
          textDigest: 'b'.repeat(64),
          requiredKinds: ['unit'],
        },
      ],
      criteriaTotal: 1,
      criteriaOmitted: 0,
      purpose: 'source',
    },
    binding: {
      bindingId: 'binding-first',
      turnAttempt: 'attempt-first',
      root,
      nativeState: 'not-required',
      admissionActive: false,
      createdAt: '2026-11-15T12:00:01Z',
    },
    contributions: [
      {
        operationId: 'record-original',
        bindingId: 'binding-first',
        root: { ...root },
        change: { kind: 'git', repositoryId: root.repositoryId, commit: 'c'.repeat(40) },
        provenance: 'recordingGovernanceOnlySharedWorkingCopy',
        receiptDigest: 'd'.repeat(64),
        recordedAt: '2026-11-15T12:01:00Z',
      },
    ],
    effects: [
      {
        operationId: 'effect-original',
        grantId: 'grant-original',
        effectDigest: 'e'.repeat(64),
        committedAt: '2026-11-15T12:00:30Z',
      },
    ],
    next: { contributions: null, effects: null },
    coverage: {
      contributions: { returnedRecords: 1, retainedPageComplete: true, byteLimited: false },
      effects: { returnedRecords: 1, retainedPageComplete: true, byteLimited: false },
    },
    checks: { status: 'unavailable', reason: 'noQualifiedRunLinkage' },
    reviews: { status: 'unavailable', reason: 'noQualifiedRunLinkage' },
    settlement: { status: 'unavailable', reason: 'noQualifiedRunLinkage' },
    readBasis: { queryVersion: 1, sourceEventWatermark: 20, scope: 'firstConfirmedTurnOnly' },
  };
}
