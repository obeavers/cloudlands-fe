import { buffers, eventChannel } from 'redux-saga';
import { actionChannel, call, put, race, take, type SagaGenerator } from 'typed-redux-saga';
import { appClient } from '$lib/client';
import type { AppClient } from '$lib/client/app-client';
import type { NeutralWorkspaceClients } from '$lib/client/live/neutral-workspace-client';
import { readModelMutationFence } from '$lib/client/live/neutral-read-model';
import { takeLeadingInContext } from '../../../utils/context-saga-effects';
import {
  backendReconnected,
  workspaceDeleted,
  workspaceUnmounted,
} from '../../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../../workspace/workspace-slice';
import {
  sameConfirmationOwner,
  taskConfirmationClosed,
  taskConfirmationDecideRequested,
  taskConfirmationLoaded,
  taskConfirmationOpened,
  taskConfirmationSettled,
  taskConfirmationStale,
  taskConfirmationSubmitting,
  taskConfirmationUnavailable,
  taskConfirmationUncertain,
} from '../task-confirmation-slice';

import {
  selectTaskConfirmationReview,
  selectTaskConfirmationViews,
} from '../task-confirmation-selectors';

type Client = Pick<AppClient, 'work' | 'captureNeutralWorkspace'>;
type Action = ReturnType<typeof taskConfirmationOpened>;

function* review(client: Client, action: Action): SagaGenerator<void> {
  if (action.type !== taskConfirmationOpened.type) return;
  const [workspaceId, owner] = action.payload;
  if (workspaceId !== owner.workspaceId) return;
  const stopping = yield* actionChannel((message: { type: string; payload?: unknown }) => {
    const payload = Array.isArray(message.payload) ? message.payload : [];
    if (message.type === backendReconnected.type) return true;
    if (message.type === taskConfirmationClosed.type)
      return payload[0] === workspaceId && payload[1] === owner.reviewId;
    if (message.type === taskConfirmationOpened.type)
      return (
        payload[0] === workspaceId &&
        typeof payload[1] === 'object' &&
        payload[1] !== null &&
        !sameConfirmationOwner(payload[1] as typeof owner, owner)
      );
    return (
      [workspaceDeleted.type, workspaceUnmounted.type, removeWorkspaceEntity.type].includes(
        message.type,
      ) && payload[0] === workspaceId
    );
  }, buffers.sliding(1));
  let closed = false;
  let captured: NeutralWorkspaceClients | undefined;
  const acquisition = client.captureNeutralWorkspace?.(workspaceId);
  // A cancelled owner still releases a late capture acknowledgment on its original route.
  void acquisition?.then(
    (ports) => {
      if (closed) void ports.release();
    },
    () => {},
  );
  const retired = eventChannel<boolean>((emit) => {
    let off = () => {};
    void acquisition?.then(
      (ports) => {
        if (!closed) off = ports.onRetired(() => emit(true));
      },
      () => {},
    );
    return () => off();
  }, buffers.sliding(1));
  try {
    if (acquisition) captured = yield* call(() => acquisition);
    const active = yield* selectTaskConfirmationReview.effect(workspaceId);
    if (!active || !sameConfirmationOwner(active.owner, owner)) return;
    const work = acquisition ? captured?.work : client.work;
    if (!work?.canReviewConfirmation) {
      yield* put(taskConfirmationUnavailable(workspaceId, owner));
      return;
    }
    const before = yield* selectTaskConfirmationViews.effect(workspaceId);
    const beforeToken = before && readModelMutationFence(before.vcs, before.work);
    const loaded = yield* race({
      card: call(() => work.confirmationCard(workspaceId, owner.offerId)),
      retired: take(retired),
      replaced: take(stopping),
    });
    if (!loaded.card) {
      yield* put(taskConfirmationUnavailable(workspaceId, owner));
      return;
    }
    const card = loaded.card;
    const after = yield* selectTaskConfirmationViews.effect(workspaceId);
    const afterToken = after && readModelMutationFence(after.vcs, after.work);
    if (
      card.offer.inputs.taskRevision.noteId !== owner.noteId ||
      card.offer.offerDigest !== owner.offerDigest ||
      card.offer.basis.completionNoteRev !== owner.completionNoteRev
    ) {
      yield* put(taskConfirmationUnavailable(workspaceId, owner));
      return;
    }
    const token =
      beforeToken &&
      beforeToken === afterToken &&
      card.staleness.length === 0 &&
      card.task.status === 'available'
        ? beforeToken
        : null;
    yield* put(taskConfirmationLoaded(workspaceId, owner, card, token));
    while (true) {
      const event = yield* race({
        decision: take(taskConfirmationDecideRequested),
        retired: take(retired),
        replaced: take(stopping),
      });
      if (!event.decision) {
        yield* put(taskConfirmationUnavailable(workspaceId, owner));
        return;
      }
      const [ws, selected, decision, operationId] = event.decision.payload;
      if (ws !== workspaceId || !sameConfirmationOwner(selected, owner)) continue;
      const entry = yield* selectTaskConfirmationReview.effect(workspaceId);
      if (
        !entry ||
        entry.phase !== 'ready' ||
        !sameConfirmationOwner(entry.owner, owner) ||
        !entry.card ||
        !operationId
      )
        continue;
      const current = yield* selectTaskConfirmationViews.effect(workspaceId);
      const currentToken = current && readModelMutationFence(current.vcs, current.work);
      if (!current || !currentToken || currentToken !== entry.stateToken) {
        yield* put(taskConfirmationStale(workspaceId, owner));
        continue;
      }
      const reason = entry.reason.trim();
      if (decision !== 'accept' && !reason) continue;
      const request = {
        operationId,
        offerId: owner.offerId,
        offerDigest: owner.offerDigest,
        decision,
        reason: reason || null,
        humanReviewScope:
          entry.independentCodeReview && card.offer.inputs.subject.kind === 'source'
            ? ('independent-code-review' as const)
            : ('confirmation-only' as const),
      };
      yield* put(taskConfirmationSubmitting(workspaceId, owner, request));
      try {
        const result = yield* race({
          outcome: call(() => work.decide(workspaceId, request, current)),
          retired: take(retired),
          replaced: take(stopping),
        });
        if (!result.outcome) {
          yield* put(taskConfirmationUnavailable(workspaceId, owner));
          return;
        }
        yield* put(taskConfirmationSettled(workspaceId, owner, result.outcome));
      } catch {
        // The backend may have committed. Never automatically submit another operation.
        yield* put(taskConfirmationUncertain(workspaceId, owner));
      }
    }
  } catch {
    yield* put(taskConfirmationUnavailable(workspaceId, owner));
  } finally {
    closed = true;
    retired.close();
    stopping.close();
    const original = captured;
    if (original) yield* call(() => original.release());
  }
}
export function* taskConfirmationSaga(client: Client = appClient): SagaGenerator<void> {
  yield* takeLeadingInContext(
    [taskConfirmationOpened],
    (action) => JSON.stringify([action.payload[0], action.payload[1].reviewId]),
    review,
    client,
  );
}
