import { describe, expect, it } from 'vitest';
import { getItems } from '@themislib/themis/utils/collections/collection-utils';
import {
  workspaceUnmounted,
  workspaceDeleted,
} from '../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../workspace/workspace-slice';
import {
  vcsReducer,
  vcsCaptureStarted,
  vcsProjectionUpdated,
  vcsCaptureRetired,
} from './vcs-slice';
import type { ReadModelView } from '$lib/client/live/neutral-read-model';
const initialState = { byWorkspaceId: {} };
const view: ReadModelView = {
  workspaceId: 'ws',
  channel: 'vcs',
  captureId: 'capture',
  status: 'live',
  cursor: { sequence: 1, stateToken: 'token' },
  items: [],
};
describe('vcs projection reducer', () => {
  it('starts empty and requires an explicitly current capture', () => {
    expect(vcsReducer(undefined, { type: '@@INIT' })).toEqual(initialState);
    expect(vcsReducer(initialState, vcsProjectionUpdated(view))).toBe(initialState);
    const started = vcsReducer(initialState, vcsCaptureStarted('ws', 'capture'));
    expect(started.byWorkspaceId.ws.status).toBe('pending');
    expect(vcsReducer(started, vcsProjectionUpdated({ ...view, captureId: 'retired' }))).toBe(
      started,
    );
    expect(vcsReducer(started, vcsProjectionUpdated({ ...view, channel: 'work' }))).toBe(started);
    expect(vcsReducer(started, vcsCaptureStarted('ws', ''))).toBe(started);
  });
  it('stores folded rows in a Collection and retains prior state while resnapshotting', () => {
    let state = vcsReducer(initialState, vcsCaptureStarted('ws', 'capture'));
    state = vcsReducer(state, vcsProjectionUpdated(view));
    expect(getItems(state.byWorkspaceId.ws.items)).toEqual([]);
    expect(state.byWorkspaceId.ws.cursor).toEqual(view.cursor);
    state = vcsReducer(state, vcsProjectionUpdated({ ...view, status: 'resnapshot-required' }));
    expect(state.byWorkspaceId.ws.status).toBe('resnapshot-required');
    state = vcsReducer(state, vcsCaptureStarted('ws', 'replacement'));
    expect(state.byWorkspaceId.ws).toMatchObject({
      captureId: 'replacement',
      status: 'pending',
      cursor: view.cursor,
    });
    expect(vcsReducer(state, vcsProjectionUpdated(view))).toBe(state);
  });
  it('clears only the retiring capture and fences all late views', () => {
    const old = vcsReducer(initialState, vcsCaptureStarted('ws', 'capture'));
    const retired = vcsReducer(old, vcsCaptureRetired('ws', 'capture'));
    expect(retired.byWorkspaceId).toEqual({});
    expect(vcsReducer(retired, vcsProjectionUpdated(view))).toBe(retired);
    const next = vcsReducer(old, vcsCaptureStarted('ws', 'next'));
    expect(vcsReducer(next, vcsCaptureRetired('ws', 'capture'))).toBe(next);
  });
  it.each([workspaceUnmounted('ws'), workspaceDeleted('ws', []), removeWorkspaceEntity('ws')])(
    'clears workspace state on cleanup',
    (action) => {
      const state = vcsReducer(initialState, vcsCaptureStarted('ws', 'capture'));
      expect(vcsReducer(state, action).byWorkspaceId).toEqual({});
    },
  );
});
