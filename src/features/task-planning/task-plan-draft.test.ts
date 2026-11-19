import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentType, NoteVisibility, type Note } from '$shared/types';
import { NoteId, WorkspaceId } from '$shared/types/branded-ids';
import { prepareTaskPlan, taskPlanDraft, taskPlanSourceKey } from './task-plan-draft';

function note(): Note {
  return {
    id: NoteId('planned-task'),
    workspaceId: WorkspaceId('planned-workspace'),
    rev: 7,
    title: 'Keep the exact result',
    content: 'The user’s original requested work.',
    contentType: ContentType.Markdown,
    visibility: NoteVisibility.Workspace,
    tags: [],
    isPinned: false,
    isArchived: false,
    createdAt: '2026-11-14T12:00:00Z',
    updatedAt: '2026-11-14T12:00:00Z',
    metadata: {
      task: {
        status: 'not_started',
        acceptanceCriteria: ['  Preserve café bytes.\n', 'Explain the outcome'],
        workDefinition: {
          purpose: 'source',
          criteria: [
            {
              index: 0,
              textDigest: createHash('sha256').update('  Preserve café bytes.\n').digest('hex'),
              requiredKinds: ['unit', 'round-trip'],
            },
          ],
          files: [{ rootId: 'primary', path: 'src/bytes.rs', role: 'in-scope' }],
        },
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('prospective task plan input', () => {
  it('pins exact criterion bytes and copies the confirmed snapshot independently of edits', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const source = note();
    const draft = taskPlanDraft(source);
    const original = structuredClone(source);
    const submission = await prepareTaskPlan(source, draft);
    expect(submission.expectedNoteVersion).toBe(7);
    expect(submission.acceptanceCriteria).toEqual(source.metadata!.task!.acceptanceCriteria);
    expect(submission.workDefinition.criteria[0].textDigest).toBe(
      createHash('sha256').update('  Preserve café bytes.\n').digest('hex'),
    );
    draft.criteria[0].text = 'Changed after review';
    draft.files[0].path = 'different.rs';
    expect(submission.acceptanceCriteria[0]).toBe('  Preserve café bytes.\n');
    expect(submission.workDefinition.files[0].path).toBe('src/bytes.rs');
    expect(source).toEqual(original);
  });

  it('rebinds evidence requirements to edited text instead of reusing old text pins', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const source = note();
    const draft = taskPlanDraft(source);
    draft.criteria[0].text = 'A new exact criterion';
    const submission = await prepareTaskPlan(source, draft);
    expect(submission.workDefinition.criteria[0]).toEqual({
      index: 0,
      textDigest: createHash('sha256').update('A new exact criterion').digest('hex'),
      requiredKinds: ['unit', 'round-trip'],
    });
    expect(source.metadata!.task!.acceptanceCriteria![0]).toBe('  Preserve café bytes.\n');
  });

  it('refuses duplicate or escaping file declarations and duplicate evidence kinds', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const source = note();
    for (const path of ['../escape', '/host/path', 'src//alias']) {
      const draft = taskPlanDraft(source);
      draft.files[0].path = path;
      await expect(prepareTaskPlan(source, draft)).rejects.toMatchObject({
        issue: 'invalid-input',
      });
    }
    const duplicate = taskPlanDraft(source);
    duplicate.files.push({ ...duplicate.files[0] });
    await expect(prepareTaskPlan(source, duplicate)).rejects.toMatchObject({
      issue: 'invalid-input',
    });
    const kinds = taskPlanDraft(source);
    kinds.criteria[0].requiredKinds = 'unit, unit';
    await expect(prepareTaskPlan(source, kinds)).rejects.toMatchObject({ issue: 'invalid-input' });
  });

  it('requires a known revision and complete source; UI keys change with the governing source', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const source = note();
    const draft = taskPlanDraft(source);
    await expect(prepareTaskPlan({ ...source, rev: undefined }, draft)).rejects.toMatchObject({
      issue: 'unversioned',
    });
    await expect(
      prepareTaskPlan({ ...source, contentTruncated: true }, draft),
    ).rejects.toMatchObject({
      issue: 'incomplete-source',
    });
    expect(taskPlanSourceKey(source)).not.toBe(taskPlanSourceKey({ ...source, rev: 8 }));
    expect(taskPlanSourceKey(source)).not.toBe(taskPlanSourceKey({ ...source, content: 'Edited' }));
  });
});
