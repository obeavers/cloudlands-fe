import { describe, expect, it, vi } from 'vitest';
import { NativeChangeRefSchema, NativeStateRefSchema, type RootBinding } from '$shared/types/vcs';
import { ConfirmationDecisionRequestSchema, TaskRevisionRefSchema } from '$shared/types/work';
import { RetrieveResultSchema } from '$shared/types/knowledge';
import type { ReadModelView } from './neutral-read-model';
import { resolveVcsMode } from '$lib/vcs/vcs-mode';
import { VcsClient, type VcsServicePort } from './vcs-client';
import { WorkClient, type WorkServicePort } from './work-client';

const root: RootBinding = {
  workspaceId: 'workspace',
  rootId: 'primary',
  repositoryId: 'repository',
  kind: 'git',
  locator: '/working-copy',
  epoch: 1,
};
const state = {
  kind: 'git' as const,
  repositoryId: root.repositoryId,
  commit: 'commit',
  tree: 'tree',
};
const atomic = {
  kind: 'atomic' as const,
  repositoryId: root.repositoryId,
  view: 'workspace',
  effectiveState: 'closure',
  ownMerkle: 'own-merkle',
  manifest: 'manifest',
};
const revision = {
  workspaceId: root.workspaceId,
  noteId: 'task',
  rev: 2,
  digest: 'task-digest',
  projectionSchemaVersion: 1 as const,
};
const basis = {
  repositoryId: root.repositoryId,
  rootId: root.rootId,
  rootEpoch: root.epoch,
  sourceState: state,
  derivedState: atomic,
  provenance: 'importedGitSnapshot',
  indexEpoch: 3,
  taskRevision: null,
  sourceEventWatermark: null,
  projectorWatermark: null,
  queryVersion: 1,
  ontologyVersion: 'recorded-code-v1',
  visibilityDigest: 'visible',
  ignorePolicyDigest: 'ignored',
  stale: true,
  coverage: {
    candidateFiles: 2,
    readFiles: 1,
    skippedFiles: 1,
    unsupportedGrammarFiles: 0,
    sourceBytes: 4,
    complete: false,
  },
  truncation: ['sourceReadBudget'],
};
const candidate = {
  candidateId: 'candidate',
  root,
  taskRevision: revision,
  state,
  materializationId: 'materialization',
  selectionRevision: 'selection',
  compositionRevision: 'composition',
};
const vcsView: ReadModelView = {
  workspaceId: root.workspaceId,
  channel: 'vcs',
  captureId: 'capture',
  status: 'live',
  cursor: { sequence: 3, stateToken: 'token' },
  items: [],
};
const views = { vcs: vcsView, work: { ...vcsView, channel: 'work' as const } };
const request = {
  operationId: 'decision',
  offerId: 'offer',
  offerDigest: 'offer-digest',
  decision: 'accept' as const,
  reason: null,
  humanReviewScope: 'confirmation-only' as const,
};
const authority = {
  workspaceId: root.workspaceId,
  principalId: 'human',
  hostRole: 'owner',
  facts: { membershipRevision: 3 },
  digest: 'authority-digest',
};
const confirmationBasis = {
  taskRevision: revision,
  completionNoteRev: revision.rev,
  target: null,
  subjectDigest: 'subject',
  evidenceDigest: 'evidence',
  checkRevisions: [],
  reviewDigest: 'review',
  reportDigest: null,
};
const receipt = {
  request,
  authority,
  basis: confirmationBasis,
  receiptDigest: 'receipt',
  decidedAt: '2026-11-13T00:00:00Z',
};

function vcsPort(kind: 'git' | 'atomic' = 'git'): VcsServicePort {
  return {
    isCurrent: () => true,
    capabilities: () => ({ vcs: 1, atomic: 1 }),
    status: vi.fn(async () => ({
      kind,
      branch: kind === 'git' ? 'main' : '',
      view: kind === 'atomic' ? 'workspace' : null,
      ahead: 0,
      behind: 0,
      diverged: false,
      files: [],
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      filesTruncated: false,
      totalFiles: 0,
      hasUpstream: false,
      unpushedCount: null,
      conflicts: null,
    })),
    history: vi.fn(async () => []),
    diff: vi.fn(async () => ({
      before: state,
      after: state,
      beforeCapture: 'a',
      afterCapture: 'b',
      files: [],
      nextToken: null,
    })),
  };
}
function workPort(): WorkServicePort {
  return {
    isCurrent: () => true,
    capabilities: () => ({ vcs: 1, workEvidence: 1, knowledge: 1 }),
    candidate: vi.fn(async () => candidate),
    offer: vi.fn(async () => ({
      inputs: {
        offerId: 'offer',
        taskRevision: revision,
        subject: { kind: 'noSource', settlementId: 'settlement' },
        expectedTarget: null,
        triageReference: null,
        reportDigest: null,
        reviewRevisions: [],
        satisfiedCriteria: [],
        outstandingCriteria: [],
      },
      authority,
      basis: confirmationBasis,
      offerDigest: 'offer-digest',
      createdAt: '2026-11-13T00:00:00Z',
    })),
    decide: vi.fn(async () => ({ confirmation: receipt, taskTransition: null })),
    context: vi.fn(async () => ({
      items: [{ file: 'source.rs', preview: 'text' }],
      readBasis: basis,
    })),
  };
}

describe('neutral client preparation contracts', () => {
  it('refuses a cross-repository history boundary before reading and binds diff pages to captures', async () => {
    const service = vcsPort();
    const client = new VcsClient(service);
    await expect(
      client.history(root, {
        mode: 'bounded',
        boundary: { kind: 'git', repositoryId: 'other', commit: 'commit' },
        limit: 10,
        includeOlder: false,
        includeFiles: true,
      }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
    expect(service.history).not.toHaveBeenCalled();
    await expect(
      client.diff(root, state, state, { paths: ['source.rs'], maxBytes: 1024 }),
    ).resolves.toMatchObject({ beforeCapture: 'a', afterCapture: 'b', nextToken: null });
    service.diff = vi.fn(async () => ({
      before: state,
      after: { ...state, tree: 'different' },
      beforeCapture: 'a',
      afterCapture: 'b',
      files: [],
      nextToken: null,
    }));
    await expect(
      client.diff(root, state, state, { paths: [], maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
  });

  it('does not register a provided projection port without exact capability admission', () => {
    const subscribe = vi.fn();
    const service = {
      ...vcsPort(),
      readModel: { subscribe, onReconnect: () => vi.fn() },
      capabilities: () => ({ vcs: 2 }),
    };
    const client = new VcsClient(service);
    expect(client.canSubscribeReadModel).toBe(false);
    expect(() =>
      client.subscribeReadModel('workspace', { started: vi.fn(), updated: vi.fn() }),
    ).toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it('preserves both identity namespaces and refuses unknown/mixed backends', () => {
    expect(NativeStateRefSchema.parse(state)).toEqual(state);
    expect(NativeStateRefSchema.parse(atomic)).toEqual(atomic);
    for (const value of [
      { ...atomic, commit: 'not-a-projection' },
      { ...state, kind: 'future' },
      { kind: 'git', repositoryId: 'repository', change: 'native-hash' },
    ])
      expect(NativeChangeRefSchema.safeParse(value).success).toBe(false);
  });

  it('keeps absence on legacy Git and refuses unknown capability versions or Atomic without admission', () => {
    expect(resolveVcsMode(undefined, null)).toEqual({ mode: 'legacy-git', kind: 'git' });
    expect(resolveVcsMode('atomic', null).mode).toBe('unavailable');
    expect(resolveVcsMode('git', { vcs: 2 }).mode).toBe('unavailable');
    expect(resolveVcsMode('atomic', { vcs: 1, atomic: true }).mode).toBe('unavailable');
    expect(resolveVcsMode('atomic', { vcs: 1, atomic: 1 })).toEqual({
      mode: 'native',
      kind: 'atomic',
    });
  });

  it('does not round numeric identities or accept unknown task/query schemas', () => {
    expect(
      RetrieveResultSchema.shape.readBasis
        .unwrap()
        .safeParse({ ...basis, rootEpoch: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(
      RetrieveResultSchema.shape.readBasis.unwrap().safeParse({ ...basis, queryVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      TaskRevisionRefSchema.safeParse({ ...revision, projectionSchemaVersion: 2 }).success,
    ).toBe(false);
  });

  it.each(['git', 'atomic'] as const)(
    'normalizes %s status without inventing known conflicts',
    async (kind) => {
      const port = vcsPort(kind);
      const result = await new VcsClient(port).status({ ...root, kind });
      expect(result.kind).toBe(kind);
      expect(result.conflicts).toBeNull();
      expect(port.status).toHaveBeenCalledWith({ ...root, kind });
    },
  );

  it('does not turn malformed reads into empty/clean status or call an absent capability', async () => {
    const port = vcsPort();
    port.status = vi.fn(async () => ({ kind: 'git', files: [] }));
    await expect(new VcsClient(port).status(root)).rejects.toMatchObject({
      reason: 'malformed-response',
    });
    port.capabilities = () => ({});
    await expect(new VcsClient(port).status(root)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(port.status).toHaveBeenCalledTimes(1);
  });

  it('fences replies to a replaced transport and rejects cross-repository history', async () => {
    const port = vcsPort();
    let current = true;
    port.isCurrent = () => current;
    const read = port.status;
    port.status = async (binding) => {
      const result = await read(binding);
      current = false;
      return result;
    };
    await expect(new VcsClient(port).status(root)).rejects.toMatchObject({ reason: 'unavailable' });
    const other = vcsPort();
    other.history = async () => [
      {
        change: { kind: 'git', repositoryId: 'other', commit: 'commit' },
        message: '',
        author: '',
        authorEmail: '',
        date: '',
        files: null,
        filesChanged: 0,
        published: false,
        agentId: null,
        linkedNoteId: null,
      },
    ];
    await expect(
      new VcsClient(other).history(root, {
        mode: 'since',
        baseRef: null,
        limit: 10,
        includeFiles: false,
      }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
  });

  it('retains optional read-basis envelopes, stale/partial coverage and unknown watermarks', async () => {
    expect(RetrieveResultSchema.parse({ items: [] })).toEqual({ items: [] });
    const result = await new WorkClient(workPort()).context(root, 'recorded source');
    expect(result.readBasis).toEqual(basis);
    expect(result.readBasis?.sourceEventWatermark).toBeNull();
    expect(result.readBasis?.derivedState?.kind).toBe('atomic');
    const port = workPort();
    port.context = async () => ({ items: [], readBasis: { ...basis, rootEpoch: 2 } });
    await expect(new WorkClient(port).context(root, 'recorded source')).rejects.toMatchObject({
      reason: 'scope-mismatch',
    });
  });

  it('requires the exact offer fence before calling the decision service and preserves separate receipt facts', async () => {
    const port = workPort();
    const client = new WorkClient(port);
    expect((await client.offer(root.workspaceId, 'offer')).offerDigest).toBe('offer-digest');
    await expect(client.decide(root.workspaceId, request, views)).resolves.toEqual({
      confirmation: receipt,
      taskTransition: null,
    });
    const { offerDigest: _digest, ...unfenced } = request;
    expect(ConfirmationDecisionRequestSchema.safeParse(unfenced).success).toBe(false);
    await expect(
      client.decide(root.workspaceId, unfenced as typeof request, views),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
    await expect(
      client.decide(root.workspaceId, request, {
        ...views,
        work: { ...views.work, status: 'pending' },
      }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
    expect(port.decide).toHaveBeenCalledWith(root.workspaceId, request, 'token');
    expect(port.decide).toHaveBeenCalledTimes(1);
  });
});
