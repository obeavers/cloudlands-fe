import { store } from '../../store';
import { getItems } from '@themislib/themis/utils/collections/collection-utils';
export const selectMemoryReadViews = store.createSelector((state) =>
  Object.fromEntries(
    Object.entries(state.memoryRead.byWorkspaceId).map(
      ([workspaceId, view]) =>
        [
          workspaceId,
          {
            viewId: view.viewId,
            status: view.status,
            nextCursor: view.nextCursor,
            items: getItems(view.memories),
          },
        ] as const,
    ),
  ),
);
