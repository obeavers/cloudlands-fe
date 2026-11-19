import { describe, expect, it, vi } from 'vitest';
import { confirmationPreviewReview } from '$features/task-confirmation/confirmation.preview-fixtures';
import { WorkClient } from './work-client';
import { WorkConfirmationCardSchema } from '$shared/types/work-confirmation-card';
import { ReadModelItemSchema } from '$shared/types/work-read-model';
const fixture = () => structuredClone(confirmationPreviewReview().card!);
function client(
  card: unknown,
  capabilities: Record<string, unknown> = { vcs: 1, workEvidence: 1 },
) {
  const read = vi.fn(async () => card);
  return {
    read,
    work: new WorkClient({
      isCurrent: () => true,
      capabilities: () => capabilities,
      confirmationCard: read,
      decide: vi.fn(),
    }),
  };
}
describe('authoritative confirmation card adapter', () => {
  it.each([undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '7'])(
    'requires a safe nonnegative server completion revision: %o',
    async (value) => {
      const card = fixture();
      const malformed = {
        ...card,
        offer: { ...card.offer, basis: { ...card.offer.basis, completionNoteRev: value } },
      };
      await expect(
        client(malformed).work.confirmationCard('preview-workspace', 'offer'),
      ).rejects.toThrow('malformed-response');
      const summary = {
        kind: 'offer',
        value: {
          id: 'offer:one',
          offerId: 'offer',
          taskRevision: card.offer.inputs.taskRevision,
          offerDigest: card.offer.offerDigest,
          createdAt: card.offer.createdAt,
          completionNoteRev: value,
        },
      };
      expect(ReadModelItemSchema.safeParse(summary).success).toBe(false);
    },
  );
  it('validates completion receipts against server CAS revision while preserving original work revision', async () => {
    const review = confirmationPreviewReview('confirmed', 7);
    const outcome = review.outcome!;
    const workspaceId = review.owner.workspaceId;
    const request = outcome.confirmation.request;
    const view = {
      workspaceId,
      captureId: 'capture',
      status: 'live' as const,
      cursor: { sequence: 1, stateToken: 'state' },
      items: [],
    };
    const views = {
      vcs: { ...view, channel: 'vcs' as const },
      work: { ...view, channel: 'work' as const },
    };
    const service = {
      isCurrent: () => true,
      capabilities: () => ({ vcs: 1, workEvidence: 1 }),
      decide: vi.fn(async () => outcome),
    };
    await expect(new WorkClient(service).decide(workspaceId, request, views)).resolves.toEqual(
      outcome,
    );
    expect(outcome.confirmation.basis.taskRevision.rev).toBe(3);
    expect(outcome.confirmation.basis.completionNoteRev).toBe(7);
    expect(outcome.taskTransition?.noteRevAfter).toBe(8);
    const wrong = structuredClone(outcome);
    wrong.taskTransition!.noteRevAfter = 4;
    await expect(
      new WorkClient({ ...service, decide: async () => wrong }).decide(workspaceId, request, views),
    ).rejects.toThrow('scope-mismatch');
  });
  it('preserves rootless task basis and exact backend-joined check pins without source or pass inference', async () => {
    const card = fixture();
    const h = client(card);
    expect(h.work.canReviewConfirmation).toBe(true);
    await expect(h.work.confirmationCard('preview-workspace', 'offer')).resolves.toEqual(card);
    expect(card.readBasis.scope.kind).toBe('taskLedger');
    expect(card.readBasis).not.toHaveProperty('repositoryId');
    expect(card.actualResult).toEqual({
      status: 'unavailable',
      reason: 'notRetainedAsTypedEvidence',
    });
    const changed = { ...card, staleness: ['authorityChanged'] };
    expect(WorkConfirmationCardSchema.parse(changed).staleness).toEqual(['authorityChanged']);
  });
  it.each([
    (card: ReturnType<typeof fixture>) => {
      if (card.task.status === 'available') card.task.value.reference.rev += 1;
    },
    (card: ReturnType<typeof fixture>) => {
      card.checks[0].revision.specDigest = 'different';
    },
    (card: ReturnType<typeof fixture>) => {
      if (card.checks[0].detail.status === 'available')
        card.checks[0].detail.value.spec.runId = 'different';
    },
    (card: ReturnType<typeof fixture>) => {
      if (card.checks[0].detail.status === 'available' && card.checks[0].detail.value.observation)
        card.checks[0].detail.value.observation.taskRevision.rev += 1;
    },
    (card: ReturnType<typeof fixture>) => {
      if (card.readBasis.scope.kind === 'taskLedger')
        card.readBasis.scope.taskRevision.digest = 'different';
    },
    (card: ReturnType<typeof fixture>) => {
      card.offer.authority.workspaceId = 'different';
    },
  ])(
    'refuses a changed task/check/basis/scope instead of joining it to the offer',
    async (change) => {
      const card = fixture();
      change(card);
      await expect(
        client(card).work.confirmationCard('preview-workspace', 'offer'),
      ).rejects.toThrow('scope-mismatch');
    },
  );
  it('refuses known Atomic source when its exact engine capability is absent', async () => {
    const card = fixture();
    const state = {
      kind: 'atomic' as const,
      repositoryId: 'repository',
      view: 'view',
      effectiveState: 'effective',
      ownMerkle: 'merkle',
      manifest: 'manifest',
    };
    card.offer.inputs.subject = {
      kind: 'source',
      candidate: {
        candidateId: 'candidate',
        root: {
          kind: 'atomic',
          workspaceId: 'preview-workspace',
          rootId: 'root',
          repositoryId: 'repository',
          locator: '/source',
          epoch: 1,
        },
        taskRevision: card.offer.inputs.taskRevision,
        state,
        materializationId: 'materialization',
        selectionRevision: 'selection',
        compositionRevision: 'composition',
      },
      selectedChanges: [],
      dependencyChanges: [],
      closureDigest: 'closure',
    };
    if (card.checks[0].detail.status === 'available' && card.checks[0].detail.value.observation)
      card.checks[0].detail.value.observation.state = state;
    await expect(client(card).work.confirmationCard('preview-workspace', 'offer')).rejects.toThrow(
      'unavailable',
    );
    await expect(
      client(card, { vcs: 1, workEvidence: 1, atomic: 2 }).work.confirmationCard(
        'preview-workspace',
        'offer',
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      client(card, { vcs: 1, workEvidence: 1, atomic: 1 }).work.confirmationCard(
        'preview-workspace',
        'offer',
      ),
    ).resolves.toEqual(card);
  });
  it('keeps unavailable typed evidence explicit and refuses unknown basis versions or fields', async () => {
    const card = fixture();
    card.checks[0].detail = { status: 'unavailable', reason: 'byteBudget' };
    await expect(client(card).work.confirmationCard('preview-workspace', 'offer')).resolves.toEqual(
      card,
    );
    await expect(
      client({ ...card, readBasis: { ...card.readBasis, queryVersion: 2 } }).work.confirmationCard(
        'preview-workspace',
        'offer',
      ),
    ).rejects.toThrow('malformed-response');
    await expect(
      client({ ...card, inventedReviewer: 'reviewer' }).work.confirmationCard(
        'preview-workspace',
        'offer',
      ),
    ).rejects.toThrow('malformed-response');
  });
  it('does not register a review feature from absent, unknown or read-model-only service ports', () => {
    expect(
      new WorkClient({ isCurrent: () => true, capabilities: () => ({ vcs: 1, workEvidence: 1 }) })
        .canReviewConfirmation,
    ).toBe(false);
    expect(client(fixture(), { vcs: 1, workEvidence: 2 }).work.canReviewConfirmation).toBe(false);
    expect(client(fixture(), {}).work.canReviewConfirmation).toBe(false);
  });
});
