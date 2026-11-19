import type { WorkConfirmationCard } from '$shared/types/work-confirmation-card';
/** No service registration is implied by the existence of this confirmation state. */
import { createAction } from '@themislib/themis/utils/store/create-action';
import { createReducer } from '@themislib/themis/utils/store/create-reducer';
import type { ConfirmationOutcome, ConfirmationDecisionRequest } from '$shared/types/work';
import {
  backendReconnected,
  workspaceUnmounted,
  workspaceDeleted,
} from '../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../workspace/workspace-slice';
import { vcsCaptureRetired, vcsProjectionUpdated } from '../vcs/vcs-slice';
import { workCaptureRetired, workProjectionUpdated } from '../work/work-slice';

export interface ConfirmationOwner {
  workspaceId: string;
  reviewId: string;
  noteId: string;
  offerId: string;
  offerDigest: string;
  completionNoteRev: number;
}
export interface TaskConfirmationReview {
  owner: ConfirmationOwner;
  phase: 'loading' | 'unavailable' | 'ready' | 'submitting' | 'stale' | 'settled' | 'uncertain';
  card: WorkConfirmationCard | null;
  stateToken: string | null;
  reason: string;
  independentCodeReview: boolean;
  request: ConfirmationDecisionRequest | null;
  outcome: ConfirmationOutcome | null;
}
export interface TaskConfirmationState {
  byWorkspaceId: Record<string, TaskConfirmationReview>;
}
const initialState: TaskConfirmationState = { byWorkspaceId: {} };
export const taskConfirmationOpened =
  createAction<[workspaceId: string, owner: ConfirmationOwner]>('taskConfirmation/opened');
export const taskConfirmationClosed =
  createAction<[workspaceId: string, reviewId: string]>('taskConfirmation/closed');
export const taskConfirmationLoaded =
  createAction<
    [
      workspaceId: string,
      owner: ConfirmationOwner,
      card: WorkConfirmationCard,
      stateToken: string | null,
    ]
  >('taskConfirmation/loaded');
export const taskConfirmationUnavailable = createAction<
  [workspaceId: string, owner: ConfirmationOwner]
>('taskConfirmation/unavailable');
export const taskConfirmationDraftChanged = createAction<
  [workspaceId: string, owner: ConfirmationOwner, reason: string, independentCodeReview: boolean]
>('taskConfirmation/draftChanged');
export const taskConfirmationDecideRequested = createAction<
  [
    workspaceId: string,
    owner: ConfirmationOwner,
    decision: ConfirmationDecisionRequest['decision'],
    operationId: string,
  ]
>('taskConfirmation/decideRequested');
export const taskConfirmationSubmitting = createAction<
  [workspaceId: string, owner: ConfirmationOwner, request: ConfirmationDecisionRequest]
>('taskConfirmation/submitting');
export const taskConfirmationSettled = createAction<
  [workspaceId: string, owner: ConfirmationOwner, outcome: ConfirmationOutcome]
>('taskConfirmation/settled');
export const taskConfirmationUncertain = createAction<
  [workspaceId: string, owner: ConfirmationOwner]
>('taskConfirmation/uncertain');
export const taskConfirmationStale =
  createAction<[workspaceId: string, owner: ConfirmationOwner]>('taskConfirmation/stale');
export const taskConfirmationReducer = createReducer<TaskConfirmationState>(initialState);
export const sameConfirmationOwner = (a: ConfirmationOwner, b: ConfirmationOwner) =>
  a.workspaceId === b.workspaceId &&
  a.reviewId === b.reviewId &&
  a.noteId === b.noteId &&
  a.offerId === b.offerId &&
  a.offerDigest === b.offerDigest &&
  a.completionNoteRev === b.completionNoteRev;
function update(
  state: TaskConfirmationState,
  workspaceId: string,
  owner: ConfirmationOwner,
  change: (review: TaskConfirmationReview) => TaskConfirmationReview,
) {
  const previous = state.byWorkspaceId[workspaceId];
  if (
    owner.workspaceId !== workspaceId ||
    !previous ||
    !sameConfirmationOwner(previous.owner, owner)
  )
    return state;
  const next = change(previous);
  return next === previous
    ? state
    : { ...state, byWorkspaceId: { ...state.byWorkspaceId, [workspaceId]: next } };
}
function clear(state: TaskConfirmationState, workspaceId: string) {
  if (!(workspaceId in state.byWorkspaceId)) return state;
  const byWorkspaceId = { ...state.byWorkspaceId };
  delete byWorkspaceId[workspaceId];
  return { ...state, byWorkspaceId };
}
taskConfirmationReducer.with(taskConfirmationOpened, (state, { payload: [workspaceId, owner] }) =>
  owner.workspaceId !== workspaceId ||
  (state.byWorkspaceId[workspaceId] &&
    sameConfirmationOwner(state.byWorkspaceId[workspaceId].owner, owner))
    ? state
    : {
        ...state,
        byWorkspaceId: {
          ...state.byWorkspaceId,
          [workspaceId]: {
            owner,
            phase: 'loading',
            card: null,
            stateToken: null,
            reason: '',
            independentCodeReview: false,
            request: null,
            outcome: null,
          },
        },
      },
);
taskConfirmationReducer.with(
  taskConfirmationLoaded,
  (state, { payload: [ws, owner, card, stateToken] }) =>
    update(state, ws, owner, (review) =>
      review.phase !== 'loading'
        ? review
        : { ...review, card, stateToken, phase: stateToken ? 'ready' : 'stale' },
    ),
);
taskConfirmationReducer.with(taskConfirmationUnavailable, (state, { payload: [ws, owner] }) =>
  update(state, ws, owner, (review) => ({
    ...review,
    phase: 'unavailable',
    card: null,
    stateToken: null,
    outcome: null,
  })),
);
taskConfirmationReducer.with(
  taskConfirmationDraftChanged,
  (state, { payload: [ws, owner, reason, independentCodeReview] }) =>
    update(state, ws, owner, (review) =>
      review.phase === 'submitting' || review.phase === 'settled' || reason.length > 4096
        ? review
        : { ...review, reason, independentCodeReview },
    ),
);
taskConfirmationReducer.with(
  taskConfirmationSubmitting,
  (state, { payload: [ws, owner, request] }) =>
    update(state, ws, owner, (review) =>
      review.phase !== 'ready' ||
      request.offerId !== owner.offerId ||
      request.offerDigest !== owner.offerDigest
        ? review
        : { ...review, phase: 'submitting', request },
    ),
);
taskConfirmationReducer.with(taskConfirmationSettled, (state, { payload: [ws, owner, outcome] }) =>
  update(state, ws, owner, (review) =>
    review.phase !== 'submitting' ||
    JSON.stringify(outcome.confirmation.request) !== JSON.stringify(review.request)
      ? review
      : { ...review, phase: 'settled', outcome },
  ),
);
taskConfirmationReducer.with(taskConfirmationUncertain, (state, { payload: [ws, owner] }) =>
  update(state, ws, owner, (review) =>
    review.phase !== 'submitting' ? review : { ...review, phase: 'uncertain' },
  ),
);
taskConfirmationReducer.with(taskConfirmationStale, (state, { payload: [ws, owner] }) =>
  update(state, ws, owner, (review) =>
    review.phase === 'ready' ? { ...review, phase: 'stale' } : review,
  ),
);
taskConfirmationReducer.with(taskConfirmationClosed, (state, { payload: [ws, reviewId] }) =>
  state.byWorkspaceId[ws]?.owner.reviewId === reviewId ? clear(state, ws) : state,
);
taskConfirmationReducer.with(workspaceUnmounted, (state, { payload: [ws] }) => clear(state, ws));
taskConfirmationReducer.with(workspaceDeleted, (state, { payload: [ws] }) => clear(state, ws));
taskConfirmationReducer.with(removeWorkspaceEntity, (state, { payload: [ws] }) => clear(state, ws));
taskConfirmationReducer.with(backendReconnected, () => initialState);
taskConfirmationReducer.with(vcsCaptureRetired, (state, { payload: [ws] }) => clear(state, ws));
taskConfirmationReducer.with(workCaptureRetired, (state, { payload: [ws] }) => clear(state, ws));
function projectionUpdated(
  state: TaskConfirmationState,
  view: import('$lib/client/live/neutral-read-model').ReadModelView,
) {
  const review = state.byWorkspaceId[view.workspaceId];
  if (
    !review ||
    review.phase !== 'ready' ||
    (view.status === 'live' && view.cursor?.stateToken === review.stateToken)
  )
    return state;
  return update(state, view.workspaceId, review.owner, (previous) => ({
    ...previous,
    phase: 'stale',
  }));
}
taskConfirmationReducer.with(vcsProjectionUpdated, (state, { payload: [view] }) =>
  projectionUpdated(state, view),
);
taskConfirmationReducer.with(workProjectionUpdated, (state, { payload: [view] }) =>
  projectionUpdated(state, view),
);
