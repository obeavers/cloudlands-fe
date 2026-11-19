import {
  WorkConfirmationCardSchema,
  type WorkConfirmationCard,
} from '$shared/types/work-confirmation-card';
import { readModelItemRequiresAtomic } from '$shared/types/work-read-model';
import { createReadModelRpcPort } from './neutral-read-model-rpc';
import type { ReadModelSubscriptionPort } from './neutral-read-model-subscription';
import type { Unsubscribe } from '../app-client';
import { subscribeNeutralReadModel } from './neutral-read-model-subscription';
import { supportsNeutralCapability } from '$lib/vcs/vcs-mode';
import { z } from 'zod';
/** Work evidence cannot grant authority; only an injected authorized service may decide. */
import { RootBindingSchema, sameRootBinding, type RootBinding } from '$shared/types/vcs';
import {
  RetrieveResultSchema,
  type RetrieveResult,
  type QueryReadBasis,
} from '$shared/types/knowledge';
import {
  ConfirmationDecisionRequestSchema,
  ConfirmationOfferSchema,
  ConfirmationOutcomeSchema,
  WorkCandidateSchema,
  CandidateCheckRunSchema,
  type CandidateCheckRun,
  type ConfirmationDecisionRequest,
  type ConfirmationOffer,
  type ConfirmationOutcome,
  type WorkCandidate,
} from '$shared/types/work';
import {
  assertNativeScope,
  assertNeutralLifetime,
  decodeNeutral,
  NeutralContractError,
  type NeutralServiceLifetime,
} from './neutral-client-support';

export interface WorkServicePort extends NeutralServiceLifetime {
  confirmationCard?(workspaceId: string, offerId: string): Promise<unknown>;
  checks?(root: RootBinding, candidateId: string): Promise<unknown>;
  candidate?(root: RootBinding, candidateId: string): Promise<unknown>;
  offer?(workspaceId: string, offerId: string): Promise<unknown>;
  decide?(
    workspaceId: string,
    request: ConfirmationDecisionRequest,
    expectedStateToken: string,
  ): Promise<unknown>;
  context?(root: RootBinding, query: string): Promise<unknown>;
}

import {
  NeutralReadModel,
  readModelMutationFence,
  type ReadModelView,
  type ReadModelSink,
} from './neutral-read-model';

export class WorkClient {
  private readonly projectionPort: ReadModelSubscriptionPort | undefined;
  constructor(private readonly service: WorkServicePort) {
    this.projectionPort =
      service.readModel ??
      (service.readModelTransport
        ? createReadModelRpcPort('work', service.readModelTransport, service)
        : undefined);
  }

  get canReviewConfirmation(): boolean {
    return Boolean(
      this.service.isCurrent() &&
      supportsNeutralCapability(this.service.capabilities(), 'workEvidence') &&
      supportsNeutralCapability(this.service.capabilities(), 'vcs') &&
      this.service.confirmationCard &&
      this.service.decide,
    );
  }

  async confirmationCard(workspaceId: string, offerId: string): Promise<WorkConfirmationCard> {
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    if (!this.service.confirmationCard) throw new NeutralContractError('unavailable');
    const card = decodeNeutral(
      WorkConfirmationCardSchema,
      await this.service.confirmationCard(workspaceId, offerId),
    );
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    const offer = card.offer;
    if (
      offer.inputs.offerId !== offerId ||
      offer.inputs.taskRevision.workspaceId !== workspaceId ||
      offer.authority.workspaceId !== workspaceId ||
      JSON.stringify(offer.inputs.taskRevision) !== JSON.stringify(offer.basis.taskRevision) ||
      card.readBasis.workspaceId !== workspaceId ||
      card.readBasis.scope.kind !== 'taskLedger' ||
      JSON.stringify(card.readBasis.scope.taskRevision) !==
        JSON.stringify(offer.inputs.taskRevision)
    )
      throw new NeutralContractError('scope-mismatch');
    const subject = offer.inputs.subject;
    if (subject.kind === 'source') {
      assertNeutralLifetime(this.service, subject.candidate.root, 'workEvidence');
      assertNativeScope(subject.candidate.root, subject.candidate.state);
      if (
        subject.candidate.root.workspaceId !== workspaceId ||
        JSON.stringify(subject.candidate.taskRevision) !== JSON.stringify(offer.inputs.taskRevision)
      )
        throw new NeutralContractError('scope-mismatch');
      for (const change of [...subject.selectedChanges, ...subject.dependencyChanges])
        assertNativeScope(subject.candidate.root, change);
    }
    if (offer.inputs.expectedTarget) {
      const target = offer.inputs.expectedTarget;
      assertNeutralLifetime(this.service, target.root, 'workEvidence');
      assertNativeScope(target.root, target.state);
      if (target.root.workspaceId !== workspaceId) throw new NeutralContractError('scope-mismatch');
    }
    if (
      card.task.status === 'available' &&
      JSON.stringify(card.task.value.reference) !== JSON.stringify(offer.inputs.taskRevision)
    )
      throw new NeutralContractError('scope-mismatch');
    if (
      card.checks.length !== offer.basis.checkRevisions.length ||
      new Set(card.checks.map((check) => check.revision.runId)).size !== card.checks.length
    )
      throw new NeutralContractError('scope-mismatch');
    for (const check of card.checks) {
      const expected = offer.basis.checkRevisions.find((pin) => pin.runId === check.revision.runId);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(check.revision))
        throw new NeutralContractError('scope-mismatch');
      if (check.detail.status === 'available') {
        const run = check.detail.value;
        if (
          run.spec.runId !== check.revision.runId ||
          run.origin !== check.revision.origin ||
          (run.observation === null) !== (check.revision.observationDigest === null) ||
          (run.observation &&
            JSON.stringify(run.observation.taskRevision) !==
              JSON.stringify(offer.inputs.taskRevision))
        )
          throw new NeutralContractError('scope-mismatch');
        if (
          subject.kind === 'source' &&
          (run.spec.candidateId !== subject.candidate.candidateId ||
            (run.observation &&
              (run.observation.candidateId !== subject.candidate.candidateId ||
                run.observation.materializationId !== subject.candidate.materializationId ||
                JSON.stringify(run.observation.state) !== JSON.stringify(subject.candidate.state) ||
                JSON.stringify(run.observation.taskRevision) !==
                  JSON.stringify(offer.inputs.taskRevision))))
        )
          throw new NeutralContractError('scope-mismatch');
      }
    }
    return card;
  }

  get canSubscribeReadModel(): boolean {
    return Boolean(
      this.projectionPort &&
      this.service.isCurrent() &&
      supportsNeutralCapability(this.service.capabilities(), 'workEvidence'),
    );
  }

  subscribeReadModel(workspaceId: string, sink: ReadModelSink): Unsubscribe {
    if (!this.canSubscribeReadModel || !this.projectionPort)
      throw new NeutralContractError('unavailable');
    return subscribeNeutralReadModel(
      workspaceId,
      this.readModel(workspaceId, sink),
      this.projectionPort,
    );
  }

  readModel(workspaceId: string, sink: ReadModelSink): NeutralReadModel {
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    return new NeutralReadModel(workspaceId, 'work', this.service, sink);
  }

  async candidate(binding: RootBinding, candidateId: string): Promise<WorkCandidate> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root, 'workEvidence');
    if (!this.service.candidate) throw new NeutralContractError('unavailable');
    const candidate = decodeNeutral(
      WorkCandidateSchema,
      await this.service.candidate(root, candidateId),
    );
    assertNeutralLifetime(this.service, root, 'workEvidence');
    if (
      !sameRootBinding(root, candidate.root) ||
      candidate.candidateId !== candidateId ||
      candidate.taskRevision.workspaceId !== root.workspaceId
    )
      throw new NeutralContractError('scope-mismatch');
    assertNativeScope(root, candidate.state);
    return candidate;
  }

  async checks(binding: RootBinding, candidateId: string): Promise<CandidateCheckRun[]> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root, 'workEvidence');
    if (!this.service.checks) throw new NeutralContractError('unavailable');
    const runs = decodeNeutral(
      z.array(CandidateCheckRunSchema),
      await this.service.checks(root, candidateId),
    );
    assertNeutralLifetime(this.service, root, 'workEvidence');
    for (const run of runs) {
      if (
        run.spec.candidateId !== candidateId ||
        (run.observation &&
          (run.observation.candidateId !== candidateId ||
            run.observation.taskRevision.workspaceId !== root.workspaceId))
      )
        throw new NeutralContractError('scope-mismatch');
      if (run.observation) assertNativeScope(root, run.observation.state);
    }
    return runs;
  }

  async offer(workspaceId: string, offerId: string): Promise<ConfirmationOffer> {
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    if (!this.service.offer) throw new NeutralContractError('unavailable');
    const offer = decodeNeutral(
      ConfirmationOfferSchema,
      await this.service.offer(workspaceId, offerId),
    );
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    if (
      offer.inputs.offerId !== offerId ||
      offer.inputs.taskRevision.workspaceId !== workspaceId ||
      offer.authority.workspaceId !== workspaceId ||
      offer.basis.taskRevision.workspaceId !== workspaceId
    )
      throw new NeutralContractError('scope-mismatch');
    return offer;
  }

  async decide(
    workspaceId: string,
    input: ConfirmationDecisionRequest,
    views: { vcs: ReadModelView; work: ReadModelView },
  ): Promise<ConfirmationOutcome> {
    // offerDigest is the immutable state/evidence fence. There is no unfenced overload.
    const request = decodeNeutral(ConfirmationDecisionRequestSchema, input);
    const expectedStateToken = readModelMutationFence(views.vcs, views.work);
    const capabilities = this.service.capabilities();
    if (
      !supportsNeutralCapability(capabilities, 'vcs') ||
      ([...views.vcs.items, ...views.work.items].some(readModelItemRequiresAtomic) &&
        !supportsNeutralCapability(capabilities, 'atomic'))
    )
      throw new NeutralContractError('unavailable');
    if (!expectedStateToken || views.vcs.workspaceId !== workspaceId)
      throw new NeutralContractError('scope-mismatch');
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    if (!this.service.decide) throw new NeutralContractError('unavailable');
    const outcome = decodeNeutral(
      ConfirmationOutcomeSchema,
      await this.service.decide(workspaceId, request, expectedStateToken),
    );
    assertNeutralLifetime(this.service, undefined, 'workEvidence');
    const receipt = outcome.confirmation;
    if (
      receipt.authority.workspaceId !== workspaceId ||
      receipt.basis.taskRevision.workspaceId !== workspaceId ||
      JSON.stringify(receipt.request) !== JSON.stringify(request)
    )
      throw new NeutralContractError('scope-mismatch');
    if (
      outcome.taskTransition &&
      (JSON.stringify(outcome.taskTransition.taskRevision) !==
        JSON.stringify(receipt.basis.taskRevision) ||
        outcome.taskTransition.operationId !== request.operationId ||
        outcome.taskTransition.principalId !== receipt.authority.principalId ||
        outcome.taskTransition.completionKind !== 'confirmed' ||
        outcome.taskTransition.noteRevAfter !== receipt.basis.completionNoteRev + 1 ||
        request.decision !== 'accept')
    )
      throw new NeutralContractError('scope-mismatch');
    return outcome;
  }

  async context(binding: RootBinding, query: string): Promise<RetrieveResult> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root, 'knowledge');
    if (!this.service.context) throw new NeutralContractError('unavailable');
    const result = decodeNeutral(RetrieveResultSchema, await this.service.context(root, query));
    assertNeutralLifetime(this.service, root, 'knowledge');
    if (result.readBasis) {
      const basis: QueryReadBasis = result.readBasis;
      if (
        basis.repositoryId !== root.repositoryId ||
        basis.rootId !== root.rootId ||
        basis.rootEpoch !== root.epoch ||
        (basis.taskRevision !== null && basis.taskRevision.workspaceId !== root.workspaceId)
      )
        throw new NeutralContractError('scope-mismatch');
      assertNativeScope(root, basis.sourceState);
      // A derived Atomic index may describe a Git source; its tag is not rewritten.
      if (basis.derivedState && basis.derivedState.repositoryId !== root.repositoryId)
        throw new NeutralContractError('scope-mismatch');
    }
    return result;
  }
}
