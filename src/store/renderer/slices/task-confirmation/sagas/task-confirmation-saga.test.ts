import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSaga, stdChannel } from 'redux-saga';
import type { StoreAction } from '@themislib/themis/types';
vi.mock('$lib/client', () => ({ appClient: {} }));
import { confirmationPreviewReview } from '$features/task-confirmation/confirmation.preview-fixtures';
import { WorkClient } from '$lib/client/live/work-client';
import type { NeutralWorkspaceClients } from '$lib/client/live/neutral-workspace-client';
import { vcsReducer, vcsCaptureStarted, vcsProjectionUpdated } from '../../vcs/vcs-slice';
import { workReducer, workCaptureStarted, workProjectionUpdated } from '../../work/work-slice';
import { taskConfirmationSaga } from './task-confirmation-saga';
import {
  taskConfirmationReducer,
  taskConfirmationOpened,
  taskConfirmationClosed,
  taskConfirmationDraftChanged,
  taskConfirmationDecideRequested,
  type ConfirmationOwner,
} from '../task-confirmation-slice';
const tasks: Array<{ cancel(): void }> = [];
afterEach(() => tasks.splice(0).forEach((task) => task.cancel()));
const fixture = confirmationPreviewReview();
const owner = fixture.owner;
const workspaceId = owner.workspaceId;
function run(options: { noCard?: boolean; fail?: boolean; hold?: boolean } = {}) {
  const channel = stdChannel();
  let state = {
    vcs: vcsReducer(undefined, { type: '@@INIT' }),
    work: workReducer(undefined, { type: '@@INIT' }),
    taskConfirmation: taskConfirmationReducer(undefined, { type: '@@INIT' }),
  };
  const reduce = (action: StoreAction) => {
    state = {
      vcs: vcsReducer(state.vcs, action),
      work: workReducer(state.work, action),
      taskConfirmation: taskConfirmationReducer(state.taskConfirmation, action),
    };
  };
  function send(action: StoreAction) {
    reduce(action);
    channel.put(action);
  }
  function project(sequence = 1) {
    send(vcsCaptureStarted(workspaceId, 'vcs-capture'));
    send(workCaptureStarted(workspaceId, 'work-capture'));
    send(
      vcsProjectionUpdated({
        workspaceId,
        channel: 'vcs',
        captureId: 'vcs-capture',
        status: 'live',
        cursor: { sequence, stateToken: `token-${sequence}` },
        items: [],
      }),
    );
    send(
      workProjectionUpdated({
        workspaceId,
        channel: 'work',
        captureId: 'work-capture',
        status: 'live',
        cursor: { sequence, stateToken: `token-${sequence}` },
        items: [],
      }),
    );
  }
  project();
  let resolveDecision: (value: unknown) => void = () => {};
  const decide = vi.fn(async (_ws, request, token) => {
    expect(token).toBe('token-1');
    if (options.fail) throw new Error('transport unavailable');
    const outcome = {
      confirmation: {
        request,
        authority: fixture.card!.offer.authority,
        basis: fixture.card!.offer.basis,
        receiptDigest: 'receipt',
        decidedAt: '2026-11-13T00:00:00Z',
      },
      taskTransition: null,
    };
    return options.hold
      ? new Promise((resolve) => {
          resolveDecision = resolve;
        })
      : outcome;
  });
  const confirmationCard = vi.fn(async () => structuredClone(fixture.card));
  const work = new WorkClient({
    isCurrent: () => true,
    capabilities: () => ({ workEvidence: 1, vcs: 1 }),
    decide,
    ...(options.noCard ? {} : { confirmationCard }),
  });
  const task = runSaga({ channel, dispatch: send, getState: () => state }, taskConfirmationSaga, {
    work,
  });
  tasks.push(task);
  return {
    send,
    project,
    decide,
    confirmationCard,
    state: () => state,
    entry: () => state.taskConfirmation.byWorkspaceId[workspaceId],
    resolveDecision: (value: unknown) => resolveDecision(value),
  };
}
const open = (h: ReturnType<typeof run>, selected: ConfirmationOwner = owner) =>
  h.send(taskConfirmationOpened(workspaceId, selected));
const ready = async (h: ReturnType<typeof run>) => {
  await vi.waitFor(() => expect(h.entry()?.phase).toBe('ready'));
};
describe('captured task confirmation workflow', () => {
  it('stays unavailable without an actual authorized card port', async () => {
    const h = run({ noCard: true });
    open(h);
    await vi.waitFor(() => expect(h.entry()?.phase).toBe('unavailable'));
    expect(h.decide).not.toHaveBeenCalled();
  });
  it('refuses a loaded completion revision that differs from the captured offer summary', async () => {
    const h = run();
    const mismatched = { ...owner, completionNoteRev: 9 };
    open(h, mismatched);
    await vi.waitFor(() => expect(h.entry()?.phase).toBe('unavailable'));
    expect(h.entry().card).toBeNull();
    h.send(taskConfirmationDecideRequested(workspaceId, mismatched, 'accept', 'mismatch'));
    expect(h.decide).not.toHaveBeenCalled();
  });
  it('requires a reason, uses exact offer and state fence, and records only the actual separate receipt', async () => {
    const h = run();
    open(h);
    await ready(h);
    h.send(taskConfirmationDecideRequested(workspaceId, owner, 'request-changes', 'operation'));
    expect(h.decide).not.toHaveBeenCalled();
    h.send(
      taskConfirmationDraftChanged(workspaceId, owner, '  Include interruption coverage.  ', false),
    );
    h.send(taskConfirmationDecideRequested(workspaceId, owner, 'request-changes', 'operation'));
    await vi.waitFor(() => expect(h.entry()?.phase).toBe('settled'));
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide).toHaveBeenCalledWith(
      workspaceId,
      {
        operationId: 'operation',
        offerId: owner.offerId,
        offerDigest: owner.offerDigest,
        decision: 'request-changes',
        reason: 'Include interruption coverage.',
        humanReviewScope: 'confirmation-only',
      },
      'token-1',
    );
    expect(h.entry().outcome?.taskTransition).toBeNull();
    expect(h.entry().outcome).not.toHaveProperty('adoption');
  });
  it('does not optimistically settle, retry an uncertain mutation or mutate task/source state', async () => {
    const h = run({ fail: true });
    open(h);
    await ready(h);
    const originalWork = h.state().work,
      originalVcs = h.state().vcs;
    h.send(taskConfirmationDecideRequested(workspaceId, owner, 'accept', 'one-operation'));
    expect(h.entry().phase).toBe('submitting');
    expect(h.entry().outcome).toBeNull();
    await vi.waitFor(() => expect(h.entry().phase).toBe('uncertain'));
    h.send(taskConfirmationDecideRequested(workspaceId, owner, 'accept', 'different-operation'));
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.state().work).toBe(originalWork);
    expect(h.state().vcs).toBe(originalVcs);
  });
  it('requires explicit refresh after a projection fence changes', async () => {
    const h = run();
    open(h);
    await ready(h);
    h.project(2);
    expect(h.entry().phase).toBe('stale');
    h.send(taskConfirmationDecideRequested(workspaceId, owner, 'accept', 'stale-operation'));
    expect(h.decide).not.toHaveBeenCalled();
    const refreshed = { ...owner, reviewId: 'refreshed' };
    open(h, refreshed);
    await ready(h);
    expect(h.entry().stateToken).toBe('token-2');
    expect(h.confirmationCard).toHaveBeenCalledTimes(2);
  });
  it('ignores stale owner cleanup and duplicate opens without cancelling the successor', async () => {
    const h = run();
    open(h);
    await ready(h);
    const next = { ...owner, reviewId: 'next' };
    open(h, next);
    await ready(h);
    h.send(taskConfirmationClosed(workspaceId, owner.reviewId));
    open(h, next);
    expect(h.entry().owner).toEqual(next);
    h.send(taskConfirmationDecideRequested(workspaceId, next, 'accept', 'next-operation'));
    await vi.waitFor(() => expect(h.entry()?.phase).toBe('settled'));
    expect(h.decide).toHaveBeenCalledOnce();
  });
  it('does not resurrect a closed owner from a late decision result', async () => {
    const h = run({ hold: true });
    open(h);
    await ready(h);
    h.send(taskConfirmationDecideRequested(workspaceId, owner, 'accept', 'operation'));
    h.send(taskConfirmationClosed(workspaceId, owner.reviewId));
    h.resolveDecision({});
    await Promise.resolve();
    await Promise.resolve();
    expect(h.entry()).toBeUndefined();
  });
  it('releases a late capture acknowledgment after cancellation', async () => {
    const channel = stdChannel();
    let resolve!: (ports: NeutralWorkspaceClients) => void;
    const release = vi.fn(async () => {});
    const task = runSaga(
      {
        channel,
        dispatch: () => {},
        getState: () => ({ taskConfirmation: { byWorkspaceId: {} } }),
      },
      taskConfirmationSaga,
      {
        captureNeutralWorkspace: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    );
    channel.put(taskConfirmationOpened(workspaceId, owner));
    task.cancel();
    resolve({ release, onRetired: () => () => {} });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});
