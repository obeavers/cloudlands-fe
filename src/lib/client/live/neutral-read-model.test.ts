import { describe, expect, it, vi } from 'vitest';
import type { ReadModelFrame, ReadModelItem } from '$shared/types/work-read-model';
import { NeutralReadModel, readModelMutationFence, type ReadModelView } from './neutral-read-model';

const root = {
  workspaceId: 'ws',
  rootId: 'root',
  repositoryId: 'repo',
  kind: 'git' as const,
  epoch: 1,
};
const change: ReadModelItem = {
  kind: 'change',
  value: {
    id: 'change:one',
    root,
    change: { kind: 'git', repositoryId: 'repo', commit: 'same-text' },
    turnAttempt: 'turn',
    agentId: 'agent',
    model: 'model',
    files: [{ path: 'source.rs', oldPath: null, added: 2, removed: 1 }],
    state: 'recorded',
  },
};
const dirty: ReadModelItem = {
  kind: 'dirtySet',
  value: { id: 'dirty:root', root, paths: ['source.rs'] },
};
const snapshot = (items: ReadModelItem[] = [change], sequence = 3): ReadModelFrame => ({
  type: 'snapshot',
  workspaceId: 'ws',
  channel: 'vcs',
  sequence,
  stateToken: `token-${sequence}`,
  items,
});
const delta = (
  upserts: ReadModelItem[] = [],
  removedIds: string[] = [],
  previousSequence = 3,
): ReadModelFrame => ({
  type: 'delta',
  workspaceId: 'ws',
  channel: 'vcs',
  previousSequence,
  sequence: previousSequence + 1,
  stateToken: `token-${previousSequence + 1}`,
  upserts,
  removedIds,
});
function setup(channel: 'vcs' | 'work' = 'vcs') {
  const views: ReadModelView[] = [];
  const lifetime = {
    isCurrent: vi.fn(() => true),
    capabilities: vi.fn(() => ({ vcs: 1, workEvidence: 1, atomic: 1 })),
  };
  const started = vi.fn();
  const stream = new NeutralReadModel('ws', channel, lifetime, {
    started,
    updated: (view) => views.push(view),
  });
  return { stream, lifetime, views, started, last: () => views.at(-1)! };
}

describe('neutral snapshot and delta fold', () => {
  it('starts inactive, applies deltas and removals without a refetch', () => {
    const s = setup();
    const capture = s.stream.capture('capture');
    expect(capture.cursor).toBeNull();
    expect(s.last().status).toBe('pending');
    expect(capture.push(snapshot())).toBe('applied');
    expect(capture.push(delta([dirty]))).toBe('applied');
    expect(s.last().items).toEqual([change, dirty]);
    expect(capture.push(delta([], ['change:one'], 4))).toBe('applied');
    expect(s.last().items).toEqual([dirty]);
    expect(s.last().cursor).toEqual({ sequence: 5, stateToken: 'token-5' });
  });
  it('retains unknown line counts as null', () => {
    const s = setup();
    const capture = s.stream.capture('capture');
    const unknown: ReadModelItem = {
      ...change,
      value: {
        ...change.value,
        files: [{ path: 'binary', oldPath: null, added: null, removed: null }],
      },
    };
    expect(capture.push(snapshot([unknown]))).toBe('applied');
    expect(s.last().items).toEqual([unknown]);
  });
  it('preserves Atomic identifiers rather than mapping them into Git commits', () => {
    const s = setup();
    const capture = s.stream.capture('capture');
    const item: ReadModelItem = {
      ...change,
      value: {
        ...change.value,
        root: { ...root, kind: 'atomic' },
        change: { kind: 'atomic', repositoryId: 'repo', change: 'same-text' },
      },
    };
    expect(capture.push(snapshot([item]))).toBe('applied');
    expect(s.last().items).toEqual([item]);
  });
  it('keeps the prior view on a gap until a new capture receives a full snapshot', () => {
    const s = setup();
    const old = s.stream.capture('old');
    old.push(snapshot());
    expect(old.push(delta([dirty], [], 5))).toBe('resnapshot');
    expect(s.last()).toMatchObject({
      status: 'resnapshot-required',
      items: [change],
      cursor: { sequence: 3 },
    });
    expect(old.push(delta([dirty]))).toBe('resnapshot');
    const fresh = s.stream.capture('fresh');
    expect(fresh.cursor).toEqual({ sequence: 3, stateToken: 'token-3' });
    expect(old.push(snapshot([], 9))).toBe('ignored');
    expect(fresh.push(snapshot([dirty], 9))).toBe('applied');
    expect(s.last().items).toEqual([dirty]);
  });
  it('resumes a contiguous retained delta and ignores duplicate delivery', () => {
    const s = setup();
    s.stream.capture('old').push(snapshot());
    const fresh = s.stream.capture('fresh');
    expect(fresh.push(delta([dirty]))).toBe('applied');
    expect(fresh.push(delta([], ['dirty:root']))).toBe('ignored');
    expect(s.last().items).toEqual([change, dirty]);
  });
  it.each([
    {
      type: 'snapshot',
      workspaceId: 'ws',
      channel: 'vcs',
      sequence: 0,
      stateToken: 'token',
      items: [{ kind: 'future', value: { id: 'future' } }],
    },
    { ...snapshot(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot(), items: [change, change] },
    { ...snapshot(), workspaceId: 'other' },
    { ...snapshot(), channel: 'work' },
    {
      ...snapshot(),
      items: [{ ...change, value: { ...change.value, root: { ...root, workspaceId: 'other' } } }],
    },
    {
      ...snapshot(),
      items: [
        {
          ...change,
          value: {
            ...change.value,
            change: { kind: 'atomic', repositoryId: 'repo', change: 'native' },
          },
        },
      ],
    },
    {
      ...snapshot(),
      items: [{ ...change, value: { ...change.value, root: { ...root, kind: 'future' } } }],
    },
    { ...snapshot(), stateToken: '' },
    { ...snapshot(), unexpected: 'field' },
  ])('refuses malformed/scoped input before advancing state: %#', (input) => {
    const s = setup();
    const capture = s.stream.capture('capture');
    capture.push(snapshot());
    expect(capture.push(input)).toBe('resnapshot');
    expect(s.last()).toMatchObject({
      status: 'resnapshot-required',
      items: [change],
      cursor: { sequence: 3, stateToken: 'token-3' },
    });
  });
  it('refuses an unseeded delta and ambiguous remove/upsert', () => {
    const s = setup();
    expect(s.stream.capture('empty').push(delta())).toBe('resnapshot');
    const capture = s.stream.capture('seeded');
    capture.push(snapshot());
    expect(capture.push(delta([change], ['change:one']))).toBe('resnapshot');
  });
  it('ignores retired transport callbacks and refuses known Atomic without its capability', () => {
    const s = setup();
    const capture = s.stream.capture('capture');
    s.lifetime.isCurrent.mockReturnValue(false);
    expect(capture.push(snapshot())).toBe('ignored');
    s.lifetime.isCurrent.mockReturnValue(true);
    s.lifetime.capabilities.mockReturnValue({ vcs: 1, workEvidence: 1, atomic: 0 });
    const item: ReadModelItem = {
      ...change,
      value: { ...change.value, root: { ...root, kind: 'atomic' }, change: null },
    };
    expect(capture.push(snapshot([item]))).toBe('resnapshot');
  });
  it('requires both paired channels at the same live fence', () => {
    const s = setup();
    s.stream.capture('vcs').push(snapshot());
    const w = setup('work');
    const capture = w.stream.capture('work');
    capture.push({ ...snapshot([], 3), channel: 'work' });
    expect(readModelMutationFence(s.last(), w.last())).toBe('token-3');
    capture.push({ ...delta(), channel: 'work' });
    expect(readModelMutationFence(s.last(), w.last())).toBeNull();
    s.stream.capture('replacement');
    expect(readModelMutationFence(s.last(), w.last())).toBeNull();
  });
});

describe('task transition evidence row', () => {
  const item: ReadModelItem = {
    kind: 'taskTransition',
    value: {
      id: 'task-transition:completion',
      operationId: 'completion',
      taskRevision: {
        workspaceId: 'ws',
        noteId: 'task',
        rev: 1,
        digest: 'task-digest',
        projectionSchemaVersion: 1,
      },
      completionKind: 'completed-without-confirmation',
      receiptDigest: 'effect-digest',
      completedAt: '2026-11-13T00:00:00Z',
    },
  };
  it('preserves completed-without-confirmation as its distinct backend receipt', () => {
    const s = setup('work');
    const capture = s.stream.capture('task-effect');
    expect(capture.push({ ...snapshot([item]), channel: 'work' })).toBe('applied');
    expect(s.last().items).toEqual([item]);
    expect(s.last().items.some((row) => row.kind === 'receipt')).toBe(false);
  });
  it.each([
    { ...item, value: { ...item.value, id: 'task-transition:other' } },
    { ...item, value: { ...item.value, completionKind: 'complete' } },
    {
      ...item,
      value: { ...item.value, taskRevision: { ...item.value.taskRevision, workspaceId: 'other' } },
    },
    { ...item, value: { ...item.value, credentialRef: 'private' } },
  ])('refuses malformed or cross-scope task receipts before advancing cursor', (row) => {
    const s = setup('work');
    const capture = s.stream.capture('task-effect');
    expect(capture.push({ ...snapshot(), channel: 'work', items: [row] })).toBe('resnapshot');
    expect(s.last().cursor).toBeNull();
  });
});
