import { runSaga } from 'redux-saga';
import type { StoreAction } from '@themislib/themis/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '$shared/types';
import type { TaskPlanConfiguration } from '$lib/client/app-client';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  supports: vi.fn(),
  configure: vi.fn(),
  admission: 'original',
}));
vi.mock('../../principal/principal-selectors', () => ({
  selectPrincipalActionContext: {
    *effect() {
      return mocks.admission;
    },
  },
}));
vi.mock('$lib/client', () => ({
  appClient: {
    notes: { get: mocks.get },
    tasks: { supportsPlanning: mocks.supports, configureWorkDefinition: mocks.configure },
  },
}));
vi.mock('../../workspace/workspace-selectors', () => ({
  selectHidesAgentLifecycleActions: {
    *effect() {
      return false;
    },
  },
}));
import { confirmTaskPlan, openTaskPlan } from './task-planning-saga';
import { taskPlanOpened, taskPlanConfirmed } from '../task-planning-slice';
import { applyNoteUpdated } from '../../workspace-notes/workspace-notes-slice';

const note = {
  id: 't',
  workspaceId: 'w',
  rev: 2,
  content: 'full source',
  metadata: { task: { status: 'not_started' } },
} as Note;
const input: TaskPlanConfiguration = {
  workspaceId: 'w',
  noteId: 't',
  expectedNoteVersion: 1,
  acceptanceCriteria: ['exact'],
  workDefinition: { purpose: 'source', criteria: [], files: [] },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.supports.mockResolvedValue(true);
  mocks.admission = 'original';
});
describe('task planning persistence', () => {
  it('loads complete canonical source once after checking the acknowledged capability', async () => {
    mocks.get.mockResolvedValue(note);
    const action = taskPlanOpened('w', 't', 'original');
    const emitted: StoreAction<unknown>[] = [];
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      openTaskPlan,
      action,
    ).toPromise();
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('t', 'w');
    expect(emitted).toEqual([applyNoteUpdated('w', 't', note), action.success(note)]);
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it('updates the store from the returned note and never creates an agent during confirmation', async () => {
    const confirmation = {
      note,
      taskRevision: {
        workspaceId: 'w',
        noteId: 't',
        rev: 2,
        digest: 'retained',
        projectionSchemaVersion: 1 as const,
      },
    };
    mocks.configure.mockResolvedValue(confirmation);
    const action = taskPlanConfirmed(input, 'original');
    const emitted: StoreAction<unknown>[] = [];
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      confirmTaskPlan,
      action,
    ).toPromise();
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith(input);
    expect(emitted).toEqual([applyNoteUpdated('w', 't', note), action.success(confirmation)]);
  });
  it('refuses an older daemon before reading or writing and preserves CAS conflicts', async () => {
    mocks.supports.mockResolvedValue(false);
    const emitted: StoreAction<unknown>[] = [];
    const open = taskPlanOpened('w', 't', 'original');
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      openTaskPlan,
      open,
    ).toPromise();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(emitted[0].type).toBe(open.failure(new Error()).type);
    mocks.supports.mockResolvedValue(true);
    const conflict = new Error('source changed');
    mocks.configure.mockRejectedValue(conflict);
    const confirm = taskPlanConfirmed(input, 'original');
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      confirmTaskPlan,
      confirm,
    ).toPromise();
    expect(emitted.at(-1)).toEqual(confirm.failure(conflict));
    expect(emitted.some((action) => action.type === applyNoteUpdated.type)).toBe(false);
  });

  it('refuses an already replaced review before mutation and retains a successful old-owner save without publishing it', async () => {
    mocks.admission = 'replacement';
    const stale = taskPlanConfirmed(input, 'original');
    const emitted: StoreAction<unknown>[] = [];
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      confirmTaskPlan,
      stale,
    ).toPromise();
    expect(mocks.configure).not.toHaveBeenCalled();
    mocks.admission = 'original';
    const confirmation = {
      note,
      taskRevision: {
        workspaceId: 'w',
        noteId: 't',
        rev: 2,
        digest: 'saved',
        projectionSchemaVersion: 1 as const,
      },
    };
    mocks.configure.mockImplementation(async () => {
      mocks.admission = 'replacement';
      return confirmation;
    });
    const action = taskPlanConfirmed(input, 'original');
    emitted.length = 0;
    await runSaga(
      { dispatch: (value: StoreAction<unknown>) => emitted.push(value) },
      confirmTaskPlan,
      action,
    ).toPromise();
    expect(emitted).toEqual([action.success(confirmation)]);
    expect(mocks.configure).toHaveBeenCalledOnce();
  });
});
