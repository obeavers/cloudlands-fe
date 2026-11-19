/** Inactive until the authorized channel owner supplies validated projection views. */
import { createAction } from '@themislib/themis/utils/store/create-action';
import { createReducer } from '@themislib/themis/utils/store/create-reducer';
import {
  createCollection,
  type Collection,
} from '@themislib/themis/utils/collections/collection-utils';
import type { ReadModelCursor, ReadModelItem } from '$shared/types/work-read-model';
import type { ReadModelView } from '$lib/client/live/neutral-read-model';
import { createWorkspaceScopedHelpers } from '../../utils/workspace-scoped';
import {
  workspaceUnmounted,
  workspaceDeleted,
} from '../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../workspace/workspace-slice';

type ProjectionRow = { id: string; row: ReadModelItem };
interface WorkWorkspaceState {
  captureId: string | null;
  status: ReadModelView['status'];
  cursor: ReadModelCursor | null;
  items: Collection<ProjectionRow, 'id'>;
}
export interface WorkState {
  byWorkspaceId: Record<string, WorkWorkspaceState>;
}
const emptyState: WorkWorkspaceState = {
  captureId: null,
  status: 'pending',
  cursor: null,
  items: createCollection<ProjectionRow, 'id'>('id'),
};
const initialState: WorkState = { byWorkspaceId: {} };
const { getWorkspaceState, setWorkspaceState, clearWorkspaceState } =
  createWorkspaceScopedHelpers(emptyState);
export const workCaptureStarted =
  createAction<[workspaceId: string, captureId: string]>('work/captureStarted');
export const workCaptureRetired =
  createAction<[workspaceId: string, captureId: string]>('work/captureRetired');
export const workProjectionUpdated = createAction<[view: ReadModelView]>('work/projectionUpdated');
export const workReducer = createReducer<WorkState>(initialState);
workReducer.with(workCaptureStarted, (state, { payload: [workspaceId, captureId] }) => {
  if (!captureId) return state;
  return setWorkspaceState(state, workspaceId, {
    ...getWorkspaceState(state, workspaceId),
    captureId,
    status: 'pending',
  });
});
workReducer.with(workCaptureRetired, (state, { payload: [workspaceId, captureId] }) =>
  state.byWorkspaceId[workspaceId]?.captureId === captureId
    ? clearWorkspaceState(state, workspaceId)
    : state,
);
workReducer.with(workProjectionUpdated, (state, { payload: [view] }) => {
  const previous = state.byWorkspaceId[view.workspaceId];
  if (!previous || previous.captureId !== view.captureId || view.channel !== 'work') return state;
  return setWorkspaceState(state, view.workspaceId, {
    captureId: view.captureId,
    status: view.status,
    cursor: view.cursor,
    items: createCollection<ProjectionRow, 'id'>(
      'id',
      view.items.map((row) => ({ id: row.value.id, row })),
    ),
  });
});
workReducer.with(workspaceUnmounted, (state, { payload: [workspaceId] }) =>
  clearWorkspaceState(state, workspaceId),
);
workReducer.with(workspaceDeleted, (state, { payload: [workspaceId] }) =>
  clearWorkspaceState(state, workspaceId),
);
workReducer.with(removeWorkspaceEntity, (state, { payload: [workspaceId] }) =>
  clearWorkspaceState(state, workspaceId),
);
