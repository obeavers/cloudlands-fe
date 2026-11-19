import { beforeEach, describe, expect, it, vi } from 'vitest';
import { retainedRuns, retainedTurn } from '../../../test/fixtures/task-run-evidence';
import type { TaskEvidenceRun, TaskEvidenceRequest } from '$shared/types/task-run-evidence';
vi.mock('./backend-transport', () => ({
  backendRequest: vi.fn(),
  observeBackendNodeCapabilities: vi.fn(),
}));
import { backendRequest, observeBackendNodeCapabilities } from './backend-transport';
import { readTaskEvidence, supportsTaskEvidenceRead } from './task-evidence-client';

const query: TaskEvidenceRequest = {
  workspaceId: 'w',
  noteId: 't',
  query: { kind: 'run', agentId: 'agent-original', page: { limit: 20 } },
};
beforeEach(() => vi.resetAllMocks());
describe('bounded original task-run reads on the actual client boundary', () => {
  it('reads the dedicated strict hello capability without issuing an RPC or enabling experimental work evidence', async () => {
    vi.mocked(observeBackendNodeCapabilities).mockResolvedValue({
      server: { capabilities: { taskEvidenceRead: 1 } },
    });
    expect(await supportsTaskEvidenceRead()).toBe(true);
    for (const capability of [undefined, true, '1', 0, 2]) {
      vi.mocked(observeBackendNodeCapabilities).mockResolvedValue({
        server: { capabilities: { taskEvidenceRead: capability, workEvidence: 1 } },
      });
      expect(await supportsTaskEvidenceRead()).toBe(false);
    }
    expect(backendRequest).not.toHaveBeenCalled();
  });
  it('sends only the explicit bounded run index query and preserves the original confirmation refs', async () => {
    const request: TaskEvidenceRequest = {
      workspaceId: 'w',
      noteId: 't',
      query: { kind: 'runs', after: 'opaque-original-cursor', limit: 20 },
    };
    vi.mocked(backendRequest).mockResolvedValue(retainedRuns());
    expect(await readTaskEvidence(request)).toEqual(retainedRuns());
    expect(backendRequest).toHaveBeenCalledExactlyOnceWith('task.workEvidence', request);
  });
  it('sends exact selected-run cursors and keeps unavailable check/review/settlement and shared provenance explicit', async () => {
    const request: TaskEvidenceRequest = {
      ...query,
      query: {
        kind: 'run',
        agentId: 'agent-original',
        page: { after: { effects: 'opaque-effect-page' }, limit: 10 },
      },
    };
    vi.mocked(backendRequest).mockResolvedValue(retainedTurn());
    const read = await readTaskEvidence(request);
    expect(backendRequest).toHaveBeenCalledExactlyOnceWith('task.workEvidence', request);
    expect(read).toEqual(retainedTurn());
  });
  it.each<[string, (value: TaskEvidenceRun) => void]>([
    [
      'workspace',
      (value) => {
        value.workspaceId = 'foreign';
      },
    ],
    [
      'note',
      (value) => {
        value.noteId = 'foreign';
      },
    ],
    [
      'original task scope',
      (value) => {
        value.run.taskRevision.noteId = 'foreign';
      },
    ],
    [
      'selected agent',
      (value) => {
        value.run.agentId = 'agent-other';
      },
    ],
    [
      'binding',
      (value) => {
        value.binding.bindingId = 'binding-other';
      },
    ],
    [
      'attempt',
      (value) => {
        value.binding.turnAttempt = 'later-attempt';
      },
    ],
    [
      'contribution binding',
      (value) => {
        value.contributions[0].bindingId = 'binding-other';
      },
    ],
    [
      'root epoch',
      (value) => {
        value.contributions[0].root.rootEpoch++;
      },
    ],
    [
      'change repository',
      (value) => {
        value.contributions[0].change.repositoryId = 'foreign';
      },
    ],
    [
      'duplicate effect',
      (value) => {
        value.effects.push({ ...value.effects[0] });
        value.coverage.effects.returnedRecords++;
      },
    ],
    [
      'invented coverage',
      (value) => {
        value.coverage.contributions.returnedRecords++;
      },
    ],
    [
      'preview omission',
      (value) => {
        if (value.source.status === 'available') value.source.criteriaOmitted++;
      },
    ],
    [
      'private locator',
      (value) => {
        Object.assign(value.binding.root!, { locator: '/private/host' });
      },
    ],
    [
      'first turn not admitted',
      (value) => {
        value.run.admission = { status: 'awaitingFirstAdmission' };
      },
    ],
  ])(
    'refuses mismatched or private %s instead of displaying a different run',
    async (_name, corrupt) => {
      const response = retainedTurn();
      corrupt(response);
      vi.mocked(backendRequest).mockResolvedValue(response);
      await expect(readTaskEvidence(query)).rejects.toThrow();
      expect(backendRequest).toHaveBeenCalledOnce();
    },
  );
  it('refuses wrong query mode, stalled cursors, and an oversized public response without a fallback read', async () => {
    vi.mocked(backendRequest).mockResolvedValueOnce(retainedRuns());
    await expect(readTaskEvidence(query)).rejects.toThrow('scope mismatch');
    const stalled = retainedTurn();
    stalled.next.effects = 'same-cursor';
    vi.mocked(backendRequest).mockResolvedValueOnce(stalled);
    await expect(
      readTaskEvidence({
        ...query,
        query: {
          kind: 'run',
          agentId: 'agent-original',
          page: { after: { effects: 'same-cursor' } },
        },
      }),
    ).rejects.toThrow('did not advance');
    const oversized = retainedTurn();
    if (oversized.source.status === 'available')
      oversized.source.titlePreview = 'x'.repeat(128 * 1024);
    vi.mocked(backendRequest).mockResolvedValueOnce(oversized);
    await expect(readTaskEvidence(query)).rejects.toThrow('byte budget');
    expect(backendRequest).toHaveBeenCalledTimes(3);
  });
});
