import { runSaga } from 'redux-saga';
import type { StoreAction } from '@themislib/themis/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { retainedRuns } from '../../../../../test/fixtures/task-run-evidence';
const mocks = vi.hoisted(() => ({ supports: vi.fn(), read: vi.fn(), admission: 'original' }));
vi.mock('$lib/client', () => ({
  appClient: { tasks: { supportsEvidenceRead: mocks.supports, workEvidence: mocks.read } },
}));
vi.mock('../../principal/principal-selectors', () => ({
  selectPrincipalActionContext: {
    *effect() {
      return mocks.admission;
    },
  },
}));
import { readTaskRunEvidence } from './task-evidence-saga';
import { taskEvidenceReadRequested } from '../task-evidence-slice';
const input = { workspaceId: 'w', noteId: 't', query: { kind: 'runs' as const, limit: 20 } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.supports.mockResolvedValue(true);
  mocks.admission = 'original';
});
describe('one-shot evidence read ownership', () => {
  it('performs one bounded public read and returns the immutable response without updating notes or task status', async () => {
    mocks.read.mockResolvedValue(retainedRuns());
    const action = taskEvidenceReadRequested(input, 'original');
    const emitted: StoreAction<unknown>[] = [];
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      readTaskRunEvidence,
      action,
    ).toPromise();
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(input);
    expect(emitted).toEqual([action.success(retainedRuns())]);
  });
  it('refuses an unavailable capability or already retired admission before reading', async () => {
    for (const supported of [false, true]) {
      mocks.supports.mockResolvedValue(supported);
      mocks.admission = supported ? 'replacement' : 'original';
      const emitted: StoreAction<unknown>[] = [];
      const action = taskEvidenceReadRequested(input, 'original');
      await runSaga(
        { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
        readTaskRunEvidence,
        action,
      ).toPromise();
      expect(emitted[0].type).toBe(action.failure(new Error()).type);
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('withholds an old response after principal replacement and never refetches or polls', async () => {
    mocks.read.mockImplementation(async () => {
      mocks.admission = 'replacement';
      return retainedRuns();
    });
    const action = taskEvidenceReadRequested(input, 'original');
    const emitted: StoreAction<unknown>[] = [];
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      readTaskRunEvidence,
      action,
    ).toPromise();
    expect(emitted[0].type).toBe(action.failure(new Error()).type);
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
