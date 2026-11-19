import { describe, expect, it } from 'vitest';
import { getItems } from '@themislib/themis/utils/collections/collection-utils';
import {
  workspaceUnmounted,
  workspaceDeleted,
} from '../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../workspace/workspace-slice';
import {
  workReducer,
  workCaptureStarted,
  workProjectionUpdated,
  workCaptureRetired,
} from './work-slice';
import type { ReadModelView } from '$lib/client/live/neutral-read-model';
const initialState = { byWorkspaceId: {} };
const view: ReadModelView = {
  workspaceId: 'ws',
  channel: 'work',
  captureId: 'capture',
  status: 'live',
  cursor: { sequence: 1, stateToken: 'token' },
  items: [],
};
describe('work projection reducer', () => {
  it('starts empty and requires an explicitly current capture', () => {
    expect(workReducer(undefined, { type: '@@INIT' })).toEqual(initialState);
    expect(workReducer(initialState, workProjectionUpdated(view))).toBe(initialState);
    const started = workReducer(initialState, workCaptureStarted('ws', 'capture'));
    expect(started.byWorkspaceId.ws.status).toBe('pending');
    expect(workReducer(started, workProjectionUpdated({ ...view, captureId: 'retired' }))).toBe(
      started,
    );
    expect(workReducer(started, workProjectionUpdated({ ...view, channel: 'vcs' }))).toBe(started);
    expect(workReducer(started, workCaptureStarted('ws', ''))).toBe(started);
  });
  it('stores folded rows in a Collection and retains prior state while resnapshotting', () => {
    let state = workReducer(initialState, workCaptureStarted('ws', 'capture'));
    state = workReducer(state, workProjectionUpdated(view));
    expect(getItems(state.byWorkspaceId.ws.items)).toEqual([]);
    expect(state.byWorkspaceId.ws.cursor).toEqual(view.cursor);
    state = workReducer(state, workProjectionUpdated({ ...view, status: 'resnapshot-required' }));
    expect(state.byWorkspaceId.ws.status).toBe('resnapshot-required');
    state = workReducer(state, workCaptureStarted('ws', 'replacement'));
    expect(state.byWorkspaceId.ws).toMatchObject({
      captureId: 'replacement',
      status: 'pending',
      cursor: view.cursor,
    });
    expect(workReducer(state, workProjectionUpdated(view))).toBe(state);
  });
  it('clears only the retiring capture and fences all late views', () => {
    const old = workReducer(initialState, workCaptureStarted('ws', 'capture'));
    const retired = workReducer(old, workCaptureRetired('ws', 'capture'));
    expect(retired.byWorkspaceId).toEqual({});
    expect(workReducer(retired, workProjectionUpdated(view))).toBe(retired);
    const next = workReducer(old, workCaptureStarted('ws', 'next'));
    expect(workReducer(next, workCaptureRetired('ws', 'capture'))).toBe(next);
  });
  it.each([workspaceUnmounted('ws'), workspaceDeleted('ws', []), removeWorkspaceEntity('ws')])(
    'clears workspace state on cleanup',
    (action) => {
      const state = workReducer(initialState, workCaptureStarted('ws', 'capture'));
      expect(workReducer(state, action).byWorkspaceId).toEqual({});
    },
  );
});
