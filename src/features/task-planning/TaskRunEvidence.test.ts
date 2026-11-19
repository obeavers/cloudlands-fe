/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warmImport } from '../../test/warm-import';
import { retainedRuns, retainedTurn } from '../../test/fixtures/task-run-evidence';
import {
  taskEvidenceAvailabilityRequested,
  taskEvidenceReadRequested,
} from '$store/renderer/slices/task-evidence/task-evidence-slice';
const dispatch = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ value: 'original' }));
vi.mock('$store/renderer/store', () => ({ store: { dispatch } }));
vi.mock('$store/renderer/slices/principal/principal-selectors', async () => {
  const { readable } = await import('svelte/store');
  return {
    selectPrincipalActionContext: Object.assign(() => readable(identity.value), {
      select: () => identity.value,
    }),
  };
});
warmImport(() => import('./TaskRunEvidence.svelte'));
beforeEach(() => {
  identity.value = 'original';
  dispatch.mockReset();
  dispatch.mockImplementation((action) => {
    if (action.type === taskEvidenceAvailabilityRequested.type) return Promise.resolve(true);
    const [input] = action.payload;
    return Promise.resolve(input.query.kind === 'runs' ? retainedRuns() : retainedTurn());
  });
});
afterEach(cleanup);
async function openHistory() {
  const { default: View } = await import('./TaskRunEvidence.svelte');
  render(View, { workspaceId: 'w', noteId: 't', currentNoteRev: 12 });
  await fireEvent.click(await screen.findByRole('button', { name: 'Recorded work' }));
  await screen.findByRole('button', { name: 'View first turn' });
}
describe('retained original run observations', () => {
  it('withholds the normal read option when its dedicated capability is missing', async () => {
    dispatch.mockResolvedValue(false);
    const { default: View } = await import('./TaskRunEvidence.svelte');
    render(View, { workspaceId: 'w', noteId: 't' });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Recorded work' })).toBeNull();
  });
  it('reads only on explicit clicks and displays original history independently of current assignments', async () => {
    const { default: View } = await import('./TaskRunEvidence.svelte');
    render(View, { workspaceId: 'w', noteId: 't', currentNoteRev: 12 });
    await screen.findByRole('button', { name: 'Recorded work' });
    expect(
      dispatch.mock.calls.every(
        ([action]) => action.type === taskEvidenceAvailabilityRequested.type,
      ),
    ).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Recorded work' }));
    await screen.findByText('agent-original', { exact: false });
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: taskEvidenceReadRequested.type,
        payload: [
          { workspaceId: 'w', noteId: 't', query: { kind: 'runs', limit: 20 } },
          'original',
        ],
      }),
    );
    expect(
      dispatch.mock.calls.filter(([action]) => action.type === taskEvidenceReadRequested.type),
    ).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'View first turn' }));
    expect(await screen.findByText('Original task revision 7')).toBeTruthy();
    expect(screen.getByText('Current note revision: 12.')).toBeTruthy();
    expect(
      screen.getByText('The relationship to the current task source is unknown.'),
    ).toBeTruthy();
    expect(screen.getByText('Scope: the original confirmed first turn only.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /complete|accept/i })).toBeNull();
  });
  it('opens exact retained contribution/effect identities and keeps unqualified outcomes and authorship explicit', async () => {
    await openHistory();
    await fireEvent.click(screen.getByRole('button', { name: 'View first turn' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Record record-original' }));
    expect(screen.getByText('d'.repeat(64))).toBeTruthy();
    expect(screen.getByText('c'.repeat(40))).toBeTruthy();
    expect(
      screen.getByText('Shared working copy; this recording does not prove complete authorship.'),
    ).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Effect effect-original' }));
    expect(screen.getByText('grant-original')).toBeTruthy();
    expect(screen.getByText('e'.repeat(64))).toBeTruthy();
    expect(
      screen.getByText(/Checks, independent reviews, and settlement have no qualified link/),
    ).toBeTruthy();
    expect(
      dispatch.mock.calls.every(([action]) =>
        [taskEvidenceReadRequested.type, taskEvidenceAvailabilityRequested.type].includes(
          action.type,
        ),
      ),
    ).toBe(true);
  });
  it('does not offer turn details for an allocation with no first-admission claim', async () => {
    const pending = retainedRuns();
    pending.runs[0].admission = { status: 'awaitingFirstAdmission' };
    dispatch.mockImplementation((action) =>
      Promise.resolve(action.type === taskEvidenceAvailabilityRequested.type ? true : pending),
    );
    const { default: View } = await import('./TaskRunEvidence.svelte');
    render(View, { workspaceId: 'w', noteId: 't' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Recorded work' }));
    expect(
      await screen.findByText('No first admission is recorded for this confirmation.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View first turn' })).toBeNull();
  });
  it('advances category pages independently without restarting the exhausted category or automatically walking history', async () => {
    const first = retainedTurn();
    first.next = { contributions: 'next-contribution', effects: 'next-effect' };
    first.coverage.contributions.retainedPageComplete = false;
    first.coverage.effects.retainedPageComplete = false;
    dispatch.mockImplementation((action) => {
      if (action.type === taskEvidenceAvailabilityRequested.type) return Promise.resolve(true);
      const query = action.payload[0].query;
      if (query.kind === 'runs') return Promise.resolve(retainedRuns());
      if (!query.page?.after) return Promise.resolve(first);
      const page = retainedTurn();
      if (query.page.after.contributions) page.contributions[0].operationId = 'record-next';
      else page.effects[0].operationId = 'effect-next';
      return Promise.resolve(page);
    });
    await openHistory();
    await fireEvent.click(screen.getByRole('button', { name: 'View first turn' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Next contributions page' }));
    await screen.findByRole('button', { name: 'Record record-next' });
    expect(screen.queryByRole('button', { name: 'Next contributions page' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Next effects page' }));
    await screen.findByRole('button', { name: 'Effect effect-next' });
    expect(screen.getByRole('button', { name: 'Record record-next' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record record-original' })).toBeNull();
    expect(
      dispatch.mock.calls.filter(([action]) => action.type === taskEvidenceReadRequested.type),
    ).toHaveLength(4);
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: taskEvidenceReadRequested.type,
        payload: [
          {
            workspaceId: 'w',
            noteId: 't',
            query: {
              kind: 'run',
              agentId: 'agent-original',
              page: { after: { effects: 'next-effect' }, limit: 20 },
            },
          },
          'original',
        ],
      }),
    );
  });
  it('does not publish an old principal response and offers an explicit fresh read', async () => {
    const response = Promise.withResolvers<ReturnType<typeof retainedRuns>>();
    dispatch.mockImplementation((action) =>
      action.type === taskEvidenceAvailabilityRequested.type
        ? Promise.resolve(true)
        : response.promise,
    );
    const { default: View } = await import('./TaskRunEvidence.svelte');
    render(View, { workspaceId: 'w', noteId: 't' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Recorded work' }));
    identity.value = 'replacement';
    response.resolve(retainedRuns());
    expect(await screen.findByRole('status')).toBeTruthy();
    await screen.findByText(
      'The connection or account changed. Refresh to read this task on the current connection.',
    );
    expect(screen.queryByText('agent-original', { exact: false })).toBeNull();
    expect(
      dispatch.mock.calls.filter(([action]) => action.type === taskEvidenceReadRequested.type),
    ).toHaveLength(1);
  });
});
