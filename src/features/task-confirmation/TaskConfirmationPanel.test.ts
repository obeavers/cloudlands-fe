import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { initAppStore, store } from '$store/renderer/store';
import { taskConfirmationSaga } from '$store/renderer/slices/task-confirmation/sagas/task-confirmation-saga';
import { vcsCaptureStarted, vcsProjectionUpdated } from '$store/renderer/slices/vcs/vcs-slice';
import {
  workCaptureStarted,
  workCaptureRetired,
  workProjectionUpdated,
} from '$store/renderer/slices/work/work-slice';
import { WorkClient } from '$lib/client/live/work-client';
import { confirmationPreviewReview } from './confirmation.preview-fixtures';
import TaskConfirmationPanel from './TaskConfirmationPanel.svelte';
let dispose = () => {};
let stop = () => {};
beforeEach(() => {
  dispose = initAppStore(store).dispose;
});
afterEach(() => {
  cleanup();
  stop();
  dispose();
});
function setup(staleRequirement = false) {
  const fixture = confirmationPreviewReview('ready', 7);
  if (staleRequirement) fixture.card!.staleness = ['taskChanged'];
  const card = fixture.card!;
  const decide = vi.fn(async (_ws, request) => ({
    confirmation: {
      request,
      authority: card.offer.authority,
      basis: card.offer.basis,
      receiptDigest: 'actual-confirmation',
      decidedAt: '2026-11-13T00:00:00Z',
    },
    taskTransition: {
      operationId: request.operationId,
      completionKind: 'confirmed',
      taskRevision: card.offer.inputs.taskRevision,
      principalId: card.offer.authority.principalId,
      noteRevAfter: 8,
      noteVersion: 8,
      createdAt: '2026-11-13T00:00:00Z',
    },
  }));
  const work = new WorkClient({
    isCurrent: () => true,
    capabilities: () => ({ vcs: 1, workEvidence: 1 }),
    confirmationCard: async () => card,
    decide,
  });
  stop = store.runSaga(function* () {
    yield* taskConfirmationSaga({ work });
  });
  const workspaceId = fixture.owner.workspaceId;
  store.dispatch(vcsCaptureStarted(workspaceId, 'vcs'));
  store.dispatch(workCaptureStarted(workspaceId, 'work'));
  store.dispatch(
    vcsProjectionUpdated({
      workspaceId,
      channel: 'vcs',
      captureId: 'vcs',
      status: 'live',
      cursor: { sequence: 1, stateToken: 'token' },
      items: [],
    }),
  );
  store.dispatch(
    workProjectionUpdated({
      workspaceId,
      channel: 'work',
      captureId: 'work',
      status: 'live',
      cursor: { sequence: 1, stateToken: 'token' },
      items: [
        {
          kind: 'offer',
          value: {
            id: 'offer:actual',
            offerId: fixture.owner.offerId,
            offerDigest: fixture.owner.offerDigest,
            taskRevision: card.offer.inputs.taskRevision,
            completionNoteRev: 7,
            createdAt: card.offer.createdAt,
          },
        },
      ],
    }),
  );
  return {
    fixture,
    card,
    decide,
    props: { workspaceId, noteId: fixture.owner.noteId, noteRev: 7 },
  };
}
const confirmButton = () =>
  screen.getByRole('button', { name: 'Confirm result', exact: true }) as HTMLButtonElement;
describe('server-derived completion revision association', () => {
  it('opens original work after lifecycle-only note revision changes without rebinding the original prose/evidence', async () => {
    const h = setup();
    render(TaskConfirmationPanel, h.props);
    expect(h.card.offer.inputs.taskRevision.rev).toBe(3);
    expect(h.card.offer.basis.completionNoteRev).toBe(7);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm the task result' }));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(
      screen.getByText(
        'Find why the final update can disappear and describe how the client recovers.',
      ),
    ).toBeTruthy();
    expect(h.card.task.status === 'available' && h.card.task.value.reference.rev).toBe(3);
    expect(
      h.card.checks[0].detail.status === 'available' &&
        h.card.checks[0].detail.value.observation?.taskRevision.rev,
    ).toBe(3);
  });
  it('keeps requirement edits stale even when the live note matches the observed completion revision', async () => {
    const h = setup(true);
    render(TaskConfirmationPanel, h.props);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm the task result' }));
    await screen.findByText('This offer changed. Refresh before deciding.');
    expect(confirmButton().disabled).toBe(true);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it('requires refresh after an additional note edit and retains the captured original task', async () => {
    const h = setup();
    const mounted = render(TaskConfirmationPanel, h.props);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm the task result' }));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    await mounted.rerender({ ...h.props, noteRev: 8 });
    await screen.findByText('This offer changed. Refresh before deciding.');
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText('Explain the timeout and its recovery')).toBeTruthy();
  });
  it('closes the protected card when its read-model owner retires', async () => {
    const h = setup();
    render(TaskConfirmationPanel, h.props);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm the task result' }));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    store.dispatch(workCaptureRetired(h.props.workspaceId, 'work'));
    await waitFor(() =>
      expect(screen.queryByText('Explain the timeout and its recovery')).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Confirm result', exact: true })).toBeNull();
  });
  it('retains the actual post-decision receipt after completion advances the live note revision', async () => {
    const h = setup();
    const mounted = render(TaskConfirmationPanel, h.props);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm the task result' }));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    await fireEvent.click(confirmButton());
    await screen.findByText('Confirmation recorded');
    await mounted.rerender({ ...h.props, noteRev: 8 });
    expect(screen.getByText('Confirmation recorded')).toBeTruthy();
    expect(screen.getByText('Task completion recorded')).toBeTruthy();
    expect(screen.getByText('Source adoption and publication were not requested.')).toBeTruthy();
    expect(
      store.state.taskConfirmation.byWorkspaceId[h.props.workspaceId].outcome?.confirmation.basis
        .completionNoteRev,
    ).toBe(7);
    expect(
      store.state.taskConfirmation.byWorkspaceId[h.props.workspaceId].outcome?.taskTransition
        ?.noteRevAfter,
    ).toBe(8);
  });
});
