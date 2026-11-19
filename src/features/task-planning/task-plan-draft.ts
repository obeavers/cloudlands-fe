/** Ephemeral form drafts; only the daemon can admit governing task requirements. */
import type { Note } from '$shared/types';
import { isNoteContentStale } from '$shared/utils/note-content';
import { TaskWorkDefinitionSchema, type TaskWorkDefinition } from '$shared/types/work';

interface CriterionDraft {
  text: string;
  requiredKinds: string;
}

interface FileReferenceDraft {
  rootId: string;
  path: string;
  role: TaskWorkDefinition['files'][number]['role'];
}

export interface TaskPlanDraft {
  purpose: TaskWorkDefinition['purpose'];
  criteria: CriterionDraft[];
  files: FileReferenceDraft[];
}

export interface TaskPlanSubmission {
  expectedNoteVersion: number;
  acceptanceCriteria: string[];
  workDefinition: TaskWorkDefinition;
}

type TaskPlanInputIssue = 'unversioned' | 'incomplete-source' | 'invalid-input';

class TaskPlanInputError extends Error {
  constructor(readonly issue: TaskPlanInputIssue) {
    super(issue);
  }
}

/** Copy incoming source rather than sharing the daemon projection with form edits. */
export function taskPlanDraft(note: Note): TaskPlanDraft {
  const task = note.metadata?.task;
  return {
    purpose: task?.workDefinition?.purpose ?? 'source',
    criteria: (task?.acceptanceCriteria ?? []).map((text, index) => ({
      text,
      requiredKinds:
        task?.workDefinition?.criteria
          .find((criterion) => criterion.index === index)
          ?.requiredKinds.join(', ') ?? '',
    })),
    files: task?.workDefinition?.files.map((file) => ({ ...file })) ?? [],
  };
}

/** UI staleness only. This value never grants dispatch or substitutes for server CAS. */
export function taskPlanSourceKey(note: Note): string {
  return JSON.stringify([
    note.workspaceId,
    note.id,
    note.rev,
    note.title,
    note.content,
    note.metadata?.task,
    note.contentTruncated,
  ]);
}

async function textDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Build transport input pinned to exact criterion text. Text is never trimmed or
 * reworded; each hash is checked again by the daemon against that exact source.
 * The returned arrays are independent of the editable draft.
 */
export async function prepareTaskPlan(
  note: Note,
  draft: TaskPlanDraft,
): Promise<TaskPlanSubmission> {
  if (typeof note.rev !== 'number' || !Number.isSafeInteger(note.rev) || note.rev < 0) {
    throw new TaskPlanInputError('unversioned');
  }
  if (!note.metadata?.task || note.contentTruncated || isNoteContentStale(note)) {
    throw new TaskPlanInputError('incomplete-source');
  }
  const expectedNoteVersion = note.rev;
  // Freeze all editable inputs before the first asynchronous digest.
  const frozen = {
    purpose: draft.purpose,
    criteria: draft.criteria.map((criterion) => ({ ...criterion })),
    files: draft.files.map((file) => ({ ...file })),
  };
  const acceptanceCriteria = frozen.criteria.map((criterion) => criterion.text);
  if (
    acceptanceCriteria.length > 128 ||
    acceptanceCriteria.some((text) => text.trim().length === 0)
  ) {
    throw new TaskPlanInputError('invalid-input');
  }
  const criteria: TaskWorkDefinition['criteria'] = [];
  for (const [index, criterion] of frozen.criteria.entries()) {
    if (!criterion.requiredKinds.trim()) continue;
    const requiredKinds = criterion.requiredKinds.split(',').map((kind) => kind.trim());
    if (new Set(requiredKinds).size !== requiredKinds.length) {
      throw new TaskPlanInputError('invalid-input');
    }
    criteria.push({ index, textDigest: await textDigest(criterion.text), requiredKinds });
  }
  const workDefinition = TaskWorkDefinitionSchema.safeParse({
    purpose: frozen.purpose,
    criteria,
    files: frozen.files,
  });
  if (
    !workDefinition.success ||
    new Set(frozen.files.map((file) => JSON.stringify([file.rootId, file.path]))).size !==
      frozen.files.length ||
    (workDefinition.success &&
      new TextEncoder().encode(JSON.stringify(workDefinition.data)).length > 64 * 1024)
  ) {
    throw new TaskPlanInputError('invalid-input');
  }
  return {
    expectedNoteVersion,
    acceptanceCriteria,
    workDefinition: workDefinition.data,
  };
}
