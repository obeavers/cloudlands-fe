import { getItems } from '@themislib/themis/utils/collections/collection-utils';
import { store } from '../../store';
import type { ReadModelView } from '$lib/client/live/neutral-read-model';
export const selectTaskConfirmationReview = store.createSelector(
  (state, workspaceId: string) => state.taskConfirmation.byWorkspaceId[workspaceId] ?? null,
);
export const selectTaskConfirmationViews = store.createSelector(
  (state, workspaceId: string): { vcs: ReadModelView; work: ReadModelView } | null => {
    const vcs = state.vcs.byWorkspaceId[workspaceId],
      work = state.work.byWorkspaceId[workspaceId];
    if (!vcs?.captureId || !work?.captureId) return null;
    return {
      vcs: {
        workspaceId,
        channel: 'vcs',
        captureId: vcs.captureId,
        status: vcs.status,
        cursor: vcs.cursor,
        items: getItems(vcs.items).map((entry) => entry.row),
      },
      work: {
        workspaceId,
        channel: 'work',
        captureId: work.captureId,
        status: work.status,
        cursor: work.cursor,
        items: getItems(work.items).map((entry) => entry.row),
      },
    };
  },
);
export const selectTaskConfirmationOffer = store.createSelector(
  (state, workspaceId: string, noteId: string, noteRev: number | undefined) => {
    const workspace = state.work.byWorkspaceId[workspaceId];
    if (!workspace || workspace.status !== 'live' || noteRev === undefined) return null;
    const offers = getItems(workspace.items)
      .map((entry) => entry.row)
      .filter(
        (row) =>
          row.kind === 'offer' &&
          row.value.taskRevision.noteId === noteId &&
          row.value.completionNoteRev === noteRev,
      );
    // Multiple retained offers need an explicit prepared selection owner.
    return offers.length === 1 && offers[0].kind === 'offer' ? offers[0].value : null;
  },
);
