import { describe, expect, it, vi } from 'vitest';
import { runSaga, stdChannel } from 'redux-saga';
import { getItems } from '@themislib/themis/utils/collections/collection-utils';
vi.mock('$lib/client', () => ({ appClient: {} }));
import { MemoryReadClient } from '$lib/client/live/memory-read-client';
import type { NeutralWorkspaceContext } from '$shared/types/neutral-workspace';
import type { NeutralWorkspaceClients } from '$lib/client/live/neutral-workspace-client';
import { memoryReadSaga } from './memory-read-saga';
import {
  memoryReadReducer,
  memoryReadMounted,
  memoryReadUnmounted,
  memoryReadRequested,
  memoryReadLoaded,
} from '../memory-read-slice';
import { workspaceDeleted } from '../../workspace-lifecycle/workspace-lifecycle-slice';

const memoryId = '11111111-1111-4111-8111-111111111111';
const page = {
  memories: [
    {
      candidate: {
        reference: { memoryId, revision: 1, digest: 'a'.repeat(64) },
        kind: 'decision' as const,
        preview: 'Private retained preview',
      },
      status: 'accepted' as const,
      scope: {
        workspaceId: 'ws',
        repositoryId: null,
        paths: ['.'],
        visibility: 'owner-private' as const,
      },
    },
  ],
  nextCursor: null,
};
function ports() {
  let alive = true;
  const listeners = new Set<() => void>();
  const request = vi.fn(async () => page as unknown);
  const context = {
    workspaceId: 'ws',
    principalId: 'principal-A',
    capabilities: { experimentalMemoryRead: 1 },
    isCurrent: () => alive,
    request,
  } as unknown as NeutralWorkspaceContext;
  const owner: NeutralWorkspaceClients = {
    memory: new MemoryReadClient(context),
    onRetired: (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    release: vi.fn(async () => {
      alive = false;
    }),
  };
  return {
    owner,
    request,
    retire: () => {
      alive = false;
      for (const listener of [...listeners]) listener();
    },
  };
}
function start(capture: (workspaceId: string) => Promise<NeutralWorkspaceClients>) {
  const channel = stdChannel();
  let state = memoryReadReducer(undefined, { type: '@@INIT' });
  const dispatch = (action: { type: string }) => {
    state = memoryReadReducer(state, action as never);
    channel.put(action);
    return action;
  };
  const task = runSaga({ channel, dispatch }, memoryReadSaga, { captureNeutralWorkspace: capture });
  return { task, dispatch, state: () => state };
}
describe('owned experimental memory viewer', () => {
  it('reads only on explicit action, purges private previews on actual lease retirement, and releases', async () => {
    const f = ports();
    const s = start(async () => f.owner);
    s.dispatch(memoryReadMounted('ws', 'view-A'));
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('ready'));
    expect(f.request).not.toHaveBeenCalled();
    s.dispatch(memoryReadRequested('ws', 'view-A'));
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('page'));
    expect(getItems(s.state().byWorkspaceId.ws.memories)[0].value.candidate.preview).toBe(
      'Private retained preview',
    );
    expect(f.request).toHaveBeenCalledExactlyOnceWith('memory.list', {
      workspaceId: 'ws',
      limit: 20,
    });
    f.retire();
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('retired'));
    expect(getItems(s.state().byWorkspaceId.ws.memories)).toEqual([]);
    expect(s.state().byWorkspaceId.ws.principalId).toBeNull();
    await vi.waitFor(() => expect(f.owner.release).toHaveBeenCalledOnce());
    s.dispatch(memoryReadRequested('ws', 'view-A'));
    expect(f.request).toHaveBeenCalledOnce();
    s.task.cancel();
    await s.task.toPromise();
  });
  it('refuses a late original page and an old unmount after a replacement view', async () => {
    const first = ports();
    const second = ports();
    let finish!: (value: unknown) => void;
    first.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const capture = vi.fn().mockResolvedValueOnce(first.owner).mockResolvedValueOnce(second.owner);
    const s = start(capture);
    s.dispatch(memoryReadMounted('ws', 'view-A'));
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('ready'));
    s.dispatch(memoryReadRequested('ws', 'view-A'));
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledOnce());
    s.dispatch(memoryReadMounted('ws', 'view-B'));
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('ready'));
    s.dispatch(memoryReadUnmounted('ws', 'view-A'));
    finish(page);
    s.dispatch(memoryReadLoaded('ws', 'view-A', page));
    expect(s.state().byWorkspaceId.ws.viewId).toBe('view-B');
    expect(getItems(s.state().byWorkspaceId.ws.memories)).toEqual([]);
    s.dispatch(memoryReadRequested('ws', 'view-B'));
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('page'));
    expect(second.request).toHaveBeenCalledOnce();
    expect(second.owner.release).not.toHaveBeenCalled();
    s.dispatch(memoryReadUnmounted('ws', 'view-B'));
    await vi.waitFor(() => expect(second.owner.release).toHaveBeenCalledOnce());
    expect(s.state().byWorkspaceId).toEqual({});
    s.task.cancel();
    await s.task.toPromise();
  });
  it('releases a capture completing after its viewer was cancelled', async () => {
    const f = ports();
    let finish!: (value: NeutralWorkspaceClients) => void;
    const s = start(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    s.dispatch(memoryReadMounted('ws', 'view-A'));
    s.dispatch(memoryReadUnmounted('ws', 'view-A'));
    finish(f.owner);
    await vi.waitFor(() => expect(f.owner.release).toHaveBeenCalledOnce());
    expect(s.state().byWorkspaceId).toEqual({});
    expect(f.request).not.toHaveBeenCalled();
    s.task.cancel();
    await s.task.toPromise();
  });
  it('cleans its exact lease and state on workspace access removal', async () => {
    const f = ports();
    const s = start(async () => f.owner);
    s.dispatch(memoryReadMounted('ws', 'view-A'));
    await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('ready'));
    s.dispatch(workspaceDeleted('ws', [], 'unshared'));
    await vi.waitFor(() => expect(f.owner.release).toHaveBeenCalledOnce());
    expect(s.state().byWorkspaceId).toEqual({});
    s.task.cancel();
    await s.task.toPromise();
  });
});

it('purges private retained data when the renderer root cancels its attached viewer', async () => {
  const f = ports();
  const s = start(async () => f.owner);
  s.dispatch(memoryReadMounted('ws', 'view-A'));
  await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('ready'));
  s.dispatch(memoryReadRequested('ws', 'view-A'));
  await vi.waitFor(() => expect(s.state().byWorkspaceId.ws.status).toBe('page'));
  s.task.cancel();
  await s.task.toPromise();
  expect(s.state().byWorkspaceId.ws.status).toBe('retired');
  expect(getItems(s.state().byWorkspaceId.ws.memories)).toEqual([]);
  expect(f.owner.release).toHaveBeenCalledOnce();
});
