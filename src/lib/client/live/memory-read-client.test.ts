import { describe, expect, it, vi } from 'vitest';
import { MemoryReadClient } from './memory-read-client';
import type { NeutralWorkspaceContext } from '$shared/types/neutral-workspace';
import { MemoryContextRequestSchema, MemoryListRequestSchema } from '$shared/types/memory-read';

const task = {
  workspaceId: 'ws',
  noteId: 'note',
  rev: 4,
  digest: 'a'.repeat(64),
  projectionSchemaVersion: 1 as const,
};
const memoryId = '11111111-1111-4111-8111-111111111111';
const summary = () => ({
  candidate: {
    reference: { memoryId, revision: 1, digest: 'b'.repeat(64) },
    kind: 'decision' as const,
    preview: 'Retained decision',
  },
  status: 'accepted' as const,
  scope: {
    workspaceId: 'ws',
    repositoryId: null,
    paths: ['.'],
    visibility: 'workspace-shared' as const,
  },
});
const page = () => ({ memories: [summary()], nextCursor: null });
function retrieval() {
  return {
    retrievalId: '22222222-2222-4222-8222-222222222222',
    taskRevision: task,
    candidates: [summary().candidate],
    truncated: false,
    readBasis: {
      workspaceId: 'ws',
      scope: { kind: 'taskLedger', taskRevision: task },
      sourceEventWatermark: 7,
      projectorWatermark: null,
      queryVersion: 1,
      ontologyVersion: 'intent-memory-ledger-v1',
      visibilityDigest: 'c'.repeat(64),
      ignorePolicy: 'notAppliedToLedgerFacts',
      coverage: { returnedRecords: 1, omittedForBytes: 0, retainedPageComplete: true },
      truncation: [] as string[],
    },
  };
}
function fixture(result: unknown = page(), capability: unknown = 1) {
  let current = true;
  const request = vi.fn(async () => result);
  const context = {
    workspaceId: 'ws',
    principalId: 'principal-A',
    capabilities: { experimentalMemoryRead: capability },
    isCurrent: () => current,
    request,
  } as unknown as NeutralWorkspaceContext;
  return {
    client: new MemoryReadClient(context),
    context,
    request,
    retire: () => {
      current = false;
    },
  };
}

describe('experimental memory read contract', () => {
  it('sends exact read-only documented methods and preserves unknown projector progress', async () => {
    const list = fixture();
    expect(await list.client.list({ workspaceId: 'ws', limit: 20 })).toEqual(page());
    expect(list.request).toHaveBeenCalledExactlyOnceWith('memory.list', {
      workspaceId: 'ws',
      limit: 20,
    });
    const context = fixture(retrieval());
    const query = {
      workspaceId: 'ws',
      taskRevision: task,
      paths: ['src'],
      query: 'decision',
      limit: 5,
    };
    expect((await context.client.contextForTask(query)).readBasis.projectorWatermark).toBeNull();
    expect(context.request).toHaveBeenCalledExactlyOnceWith('memory.context', query);
  });
  it.each([undefined, false, true, '1', 0, 2])(
    'refuses unsupported capability %s before wire',
    async (capability) => {
      const f = fixture(page(), capability);
      // A default parameter intentionally cannot represent an absent capability.
      f.context.capabilities.experimentalMemoryRead = capability;
      await expect(f.client.list({ workspaceId: 'ws' })).rejects.toMatchObject({
        reason: 'unavailable',
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it('rejects scope, task and unsafe filter inputs without a request', async () => {
    const f = fixture();
    await expect(f.client.list({ workspaceId: 'foreign' })).rejects.toMatchObject({
      reason: 'scope-mismatch',
    });
    await expect(
      f.client.contextForTask({
        workspaceId: 'ws',
        taskRevision: { ...task, workspaceId: 'foreign' },
      }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
    for (const path of ['../secret', '/outside', 'a//b', 'a/./b', 'C:drive', 'a\\b'])
      expect(MemoryListRequestSchema.safeParse({ workspaceId: 'ws', paths: [path] }).success).toBe(
        false,
      );
    expect(
      MemoryContextRequestSchema.safeParse({
        workspaceId: 'ws',
        taskRevision: task,
        query: 'é'.repeat(257),
      }).success,
    ).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects a late reply after its original session retires', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.client.list({ workspaceId: 'ws' });
    f.retire();
    finish(page());
    await expect(pending).rejects.toMatchObject({ reason: 'unavailable' });
    expect(f.request).toHaveBeenCalledOnce();
  });
  it.each([
    (value: ReturnType<typeof page>) => {
      value.memories[0].scope.workspaceId = 'foreign';
    },
    (value: ReturnType<typeof page>) => {
      Object.assign(value.memories[0].scope, { repositoryId: 'foreign' });
    },
    (value: ReturnType<typeof page>) => {
      value.memories.push(summary());
    },
    (value: ReturnType<typeof page>) => {
      Object.assign(value, { nextCursor: '22222222-2222-4222-8222-222222222222' });
    },
  ])('rejects foreign or inconsistent memory pages', async (mutate) => {
    const value = page();
    mutate(value);
    await expect(fixture(value).client.list({ workspaceId: 'ws' })).rejects.toMatchObject({
      reason: 'scope-mismatch',
    });
  });
  it('does not silently drop an unknown result field or invent a read basis', async () => {
    await expect(
      fixture({ ...page(), delivered: true }).client.list({ workspaceId: 'ws' }),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
    const value = retrieval();
    delete (value as Partial<typeof value>).readBasis;
    await expect(
      fixture(value).client.contextForTask({ workspaceId: 'ws', taskRevision: task }),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
  });
  it.each([
    (value: ReturnType<typeof retrieval>) => {
      value.taskRevision = { ...task, rev: 5 };
    },
    (value: ReturnType<typeof retrieval>) => {
      value.readBasis.scope.taskRevision = { ...task, digest: 'd'.repeat(64) };
    },
    (value: ReturnType<typeof retrieval>) => {
      value.readBasis.coverage.returnedRecords = 0;
    },
    (value: ReturnType<typeof retrieval>) => {
      value.truncated = true;
    },
    (value: ReturnType<typeof retrieval>) => {
      value.readBasis.truncation = ['recordLimit'];
    },
  ])('refuses mismatched retained retrieval basis', async (mutate) => {
    const value = retrieval();
    mutate(value);
    await expect(
      fixture(value).client.contextForTask({ workspaceId: 'ws', taskRevision: task }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
  });
});
