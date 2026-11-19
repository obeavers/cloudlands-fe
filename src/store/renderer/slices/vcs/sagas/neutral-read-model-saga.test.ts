import { describe, expect, it, vi } from 'vitest';
import { runSaga, stdChannel } from 'redux-saga';
import { getItems } from '@themislib/themis/utils/collections/collection-utils';
vi.mock('$lib/client', () => ({ appClient: {} }));
import { VcsClient, type VcsServicePort } from '$lib/client/live/vcs-client';
import { vcsReducer } from '../vcs-slice';
import { workReducer } from '../../work/work-slice';
import { neutralReadModelSaga } from './neutral-read-model-saga';
import {
  workspaceMounted,
  workspaceUnmounted,
  workspaceDeleted,
} from '../../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../../workspace/workspace-slice';

describe('neutral projection saga', () => {
  it('does no registration or dispatch without injected ports', () => {
    const channel = stdChannel();
    const dispatch = vi.fn();
    const task = runSaga({ channel, dispatch }, neutralReadModelSaga, {});
    channel.put(workspaceMounted('ws'));
    expect(dispatch).not.toHaveBeenCalled();
    task.cancel();
  });
  it.each([workspaceUnmounted, workspaceDeleted, removeWorkspaceEntity])(
    'folds directly into the slice and disposes on cleanup',
    async (cleanup) => {
      const channel = stdChannel();
      const stop = vi.fn();
      let push!: (frame: unknown) => void;
      const service: VcsServicePort = {
        isCurrent: () => true,
        capabilities: () => ({ vcs: 1 }),
        status: vi.fn(),
        history: vi.fn(),
        diff: vi.fn(),
        readModel: {
          subscribe: vi.fn(async (_ws, _cursor, callback) => {
            push = callback;
            return stop;
          }),
          onReconnect: () => vi.fn(),
        },
      };
      const client = { vcs: new VcsClient(service) };
      let state = {
        vcs: vcsReducer(undefined, { type: '@@INIT' }),
        work: workReducer(undefined, { type: '@@INIT' }),
      };
      const task = runSaga(
        {
          channel,
          dispatch: (action) => {
            state = { vcs: vcsReducer(state.vcs, action), work: workReducer(state.work, action) };
          },
        },
        neutralReadModelSaga,
        client,
      );
      channel.put(workspaceMounted('ws'));
      await Promise.resolve();
      push({
        type: 'snapshot',
        workspaceId: 'ws',
        channel: 'vcs',
        sequence: 1,
        stateToken: 'token',
        items: [
          {
            kind: 'dirtySet',
            value: {
              id: 'dirty:root',
              root: {
                workspaceId: 'ws',
                rootId: 'root',
                repositoryId: 'repo',
                kind: 'git',
                epoch: 1,
              },
              paths: ['source.rs'],
            },
          },
        ],
      });
      expect(getItems(state.vcs.byWorkspaceId.ws.items)).toHaveLength(1);
      expect(state.vcs.byWorkspaceId.ws.cursor).toEqual({ sequence: 1, stateToken: 'token' });
      channel.put(cleanup('ws', []));
      expect(stop).toHaveBeenCalledOnce();
      task.cancel();
    },
  );
});
