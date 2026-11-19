import { createAction } from '@themislib/themis/utils/store/create-action';
import { createReducer } from '@themislib/themis/utils/store/create-reducer';
import {
  createCollection,
  type Collection,
} from '@themislib/themis/utils/collections/collection-utils';
import type { MemoryPage } from '$shared/types/memory-read';
import {
  workspaceDeleted,
  workspaceUnmounted,
} from '../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../workspace/workspace-slice';

interface MemoryReadView {
  viewId: string;
  principalId: string | null;
  status: 'unavailable' | 'ready' | 'reading' | 'page' | 'error' | 'retired';
  memories: Collection<{ id: string; value: MemoryPage['memories'][number] }, 'id'>;
  nextCursor: string | null;
}
export interface MemoryReadState {
  byWorkspaceId: Record<string, MemoryReadView>;
}
export const memoryReadMounted =
  createAction<[workspaceId: string, viewId: string]>('memoryRead/mounted');
export const memoryReadUnmounted =
  createAction<[workspaceId: string, viewId: string]>('memoryRead/unmounted');
export const memoryReadRequested =
  createAction<[workspaceId: string, viewId: string, after?: string]>('memoryRead/requested');
export const memoryReadReady =
  createAction<[workspaceId: string, viewId: string, principalId: string]>('memoryRead/ready');
export const memoryReadLoading =
  createAction<[workspaceId: string, viewId: string]>('memoryRead/loading');
export const memoryReadLoaded =
  createAction<[workspaceId: string, viewId: string, page: MemoryPage]>('memoryRead/loaded');
export const memoryReadFailed =
  createAction<[workspaceId: string, viewId: string]>('memoryRead/failed');
export const memoryReadRetired =
  createAction<[workspaceId: string, viewId: string]>('memoryRead/retired');
const empty = () =>
  createCollection<{ id: string; value: MemoryPage['memories'][number] }, 'id'>('id');
export const memoryReadReducer = createReducer<MemoryReadState>({ byWorkspaceId: {} });
memoryReadReducer.with(memoryReadMounted, (state, { payload: [workspaceId, viewId] }) => ({
  ...state,
  byWorkspaceId: {
    ...state.byWorkspaceId,
    [workspaceId]: {
      viewId,
      principalId: null,
      status: 'unavailable',
      memories: empty(),
      nextCursor: null,
    },
  },
}));
const update = (
  state: MemoryReadState,
  workspaceId: string,
  viewId: string,
  patch: Partial<MemoryReadView>,
) =>
  state.byWorkspaceId[workspaceId]?.viewId === viewId
    ? {
        ...state,
        byWorkspaceId: {
          ...state.byWorkspaceId,
          [workspaceId]: { ...state.byWorkspaceId[workspaceId], ...patch },
        },
      }
    : state;
memoryReadReducer.with(memoryReadReady, (state, { payload: [workspaceId, viewId, principalId] }) =>
  update(state, workspaceId, viewId, { status: 'ready', principalId }),
);
memoryReadReducer.with(memoryReadLoading, (state, { payload: [workspaceId, viewId] }) =>
  update(state, workspaceId, viewId, { status: 'reading', memories: empty(), nextCursor: null }),
);
memoryReadReducer.with(memoryReadLoaded, (state, { payload: [workspaceId, viewId, page] }) =>
  update(state, workspaceId, viewId, {
    status: 'page',
    memories: createCollection(
      'id',
      page.memories.map((value) => ({ id: value.candidate.reference.memoryId, value })),
    ),
    nextCursor: page.nextCursor,
  }),
);
memoryReadReducer.with(memoryReadFailed, (state, { payload: [workspaceId, viewId] }) =>
  update(state, workspaceId, viewId, { status: 'error', memories: empty(), nextCursor: null }),
);
memoryReadReducer.with(memoryReadRetired, (state, { payload: [workspaceId, viewId] }) =>
  update(state, workspaceId, viewId, {
    status: 'retired',
    principalId: null,
    memories: empty(),
    nextCursor: null,
  }),
);
function clear(state: MemoryReadState, workspaceId: string) {
  if (!state.byWorkspaceId[workspaceId]) return state;
  const byWorkspaceId = { ...state.byWorkspaceId };
  delete byWorkspaceId[workspaceId];
  return { ...state, byWorkspaceId };
}
memoryReadReducer.with(memoryReadUnmounted, (state, { payload: [workspaceId, viewId] }) =>
  state.byWorkspaceId[workspaceId]?.viewId === viewId ? clear(state, workspaceId) : state,
);
memoryReadReducer.with(workspaceUnmounted, (state, { payload: [workspaceId] }) =>
  clear(state, workspaceId),
);
memoryReadReducer.with(workspaceDeleted, (state, { payload: [workspaceId] }) =>
  clear(state, workspaceId),
);
memoryReadReducer.with(removeWorkspaceEntity, (state, { payload: [workspaceId] }) =>
  clear(state, workspaceId),
);
