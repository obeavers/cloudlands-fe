/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warmImport } from '../../test/warm-import';
import {
  memoryReadMounted,
  memoryReadUnmounted,
  memoryReadReady,
  memoryReadLoaded,
  memoryReadRequested,
  memoryReadRetired,
} from '$store/renderer/slices/memory-read/memory-read-slice';

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  reset: () => {},
  onAction: (_action: { type: string; payload: unknown[] }) => {},
}));
vi.mock('$store/renderer/store', async () => {
  const { memoryReadReducer } =
    await import('$store/renderer/slices/memory-read/memory-read-slice');
  let state = { memoryRead: memoryReadReducer(undefined, { type: '@@INIT' }) };
  const listeners = new Set<() => void>();
  harness.reset = () => {
    state = { memoryRead: memoryReadReducer(undefined, { type: '@@INIT' }) };
  };
  harness.dispatch.mockImplementation((action) => {
    state = { memoryRead: memoryReadReducer(state.memoryRead, action) };
    for (const listener of [...listeners]) listener();
    harness.onAction(action);
    return action;
  });
  return {
    store: {
      dispatch: harness.dispatch,
      createSelector: (select: (input: typeof state) => unknown) => () => ({
        subscribe: (notify: (value: unknown) => void) => {
          const update = () => notify(select(state));
          listeners.add(update);
          update();
          return () => listeners.delete(update);
        },
      }),
    },
  };
});
warmImport(() => import('./ExperimentalMemorySection.svelte'));
const memoryId = '11111111-1111-4111-8111-111111111111';
const retainedPage = () => ({
  memories: [
    {
      candidate: {
        reference: { memoryId, revision: 3, digest: 'a'.repeat(64) },
        kind: 'decision' as const,
        preview: 'Private original decision',
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
  nextCursor: memoryId,
});
beforeEach(() => {
  harness.reset();
  harness.dispatch.mockClear();
  harness.onAction = (action) => {
    if (action.type === memoryReadMounted.type)
      harness.dispatch(memoryReadReady(action.payload[0], action.payload[1], 'principal-A'));
    if (action.type === memoryReadRequested.type)
      harness.dispatch(memoryReadLoaded(action.payload[0], action.payload[1], retainedPage()));
  };
});
afterEach(cleanup);
describe('experimental memory preview entry', () => {
  it('remains hidden when the actual owner supplies no capability-backed read port', async () => {
    harness.onAction = () => {};
    const { default: View } = await import('./ExperimentalMemorySection.svelte');
    render(View, { workspaceId: 'ws' });
    await vi.waitFor(() => expect(harness.dispatch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Experimental memory' })).toBeNull();
  });
  it('requests a bounded page only on expansion, renders provenance and offers only reads', async () => {
    const { default: View } = await import('./ExperimentalMemorySection.svelte');
    const rendered = render(View, { workspaceId: 'ws' });
    const open = await screen.findByRole('button', { name: 'Experimental memory' });
    expect(
      harness.dispatch.mock.calls.some(([action]) => action.type === memoryReadRequested.type),
    ).toBe(false);
    await fireEvent.click(open);
    expect(await screen.findByText('Private original decision')).toBeTruthy();
    expect(screen.getByText('Revision 3', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Reading a memory does not accept it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /accept|deliver|select/i })).toBeNull();
    const mounted = harness.dispatch.mock.calls.find(
      ([action]) => action.type === memoryReadMounted.type,
    )![0];
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(harness.dispatch).toHaveBeenCalledWith(
      memoryReadRequested('ws', mounted.payload[1], memoryId),
    );
    rendered.unmount();
    expect(harness.dispatch).toHaveBeenLastCalledWith(
      memoryReadUnmounted('ws', mounted.payload[1]),
    );
  });
  it('removes protected previews immediately when the owning lease retires', async () => {
    const { default: View } = await import('./ExperimentalMemorySection.svelte');
    render(View, { workspaceId: 'ws' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Experimental memory' }));
    await screen.findByText('Private original decision');
    const mounted = harness.dispatch.mock.calls.find(
      ([action]) => action.type === memoryReadMounted.type,
    )![0];
    harness.dispatch(memoryReadRetired('ws', mounted.payload[1]));
    expect(
      await screen.findByText(/The original connection or workspace access changed/),
    ).toBeTruthy();
    expect(screen.queryByText('Private original decision')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });
});

it('collapses on a workspace prop change and waits for a deliberate new read', async () => {
  const { default: View } = await import('./ExperimentalMemorySection.svelte');
  const rendered = render(View, { workspaceId: 'ws' });
  await fireEvent.click(await screen.findByRole('button', { name: 'Experimental memory' }));
  await screen.findByText('Private original decision');
  await rendered.rerender({ workspaceId: 'ws-B' });
  const header = await screen.findByRole('button', { name: 'Experimental memory' });
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Private original decision')).toBeNull();
  expect(
    harness.dispatch.mock.calls.some(
      ([action]) => action.type === memoryReadRequested.type && action.payload[0] === 'ws-B',
    ),
  ).toBe(false);
});
