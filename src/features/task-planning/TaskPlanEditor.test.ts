/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '$shared/types';
import { warmImport } from '../../test/warm-import';
import {
  taskPlanConfirmed,
  taskPlanOpened,
  taskPlanAvailabilityRequested,
} from '$store/renderer/slices/task-planning/task-planning-slice';
import { runAgentForNoteRequested } from '$store/renderer/slices/workspace-agents/workspace-agents-slice';

const dispatch = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ value: 'original-principal' }));
vi.mock('$store/renderer/store', () => ({ store: { dispatch } }));
vi.mock('$store/renderer/slices/principal/principal-selectors', async () => {
  const { readable } = await import('svelte/store');
  return {
    selectPrincipalActionContext: Object.assign(() => readable(identity.value), {
      select: () => identity.value,
    }),
  };
});
warmImport(() => import('./TaskPlanEditor.svelte'));

const source = {
  workspaceId: 'w',
  id: 't',
  rev: 7,
  title: 'Exact task',
  content: 'Original source body',
  metadata: { task: { status: 'not_started', acceptanceCriteria: ['Preserve bytes'] } },
} as Note;
const reference = {
  workspaceId: 'w',
  noteId: 't',
  rev: 8,
  digest: 'server-digest',
  projectionSchemaVersion: 1 as const,
};
let saved: Note;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  dispatch.mockReset();
  identity.value = 'original-principal';
  dispatch.mockImplementation((action) => {
    if (action.type === taskPlanAvailabilityRequested.type) return Promise.resolve(true);
    if (action.type === taskPlanOpened.type) return Promise.resolve(structuredClone(source));
    if (action.type === taskPlanConfirmed.type) {
      const [input] = action.payload;
      saved = {
        ...source,
        rev: 8,
        metadata: {
          task: {
            ...source.metadata!.task!,
            acceptanceCriteria: input.acceptanceCriteria,
            workDefinition: input.workDefinition,
          },
        },
      };
      return Promise.resolve({ note: saved, taskRevision: reference });
    }
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('human task plan confirmation', () => {
  it('reviews exact source and saves only after explicit confirmation, then forwards the returned pin on explicit Run', async () => {
    const { default: View } = await import('./TaskPlanEditor.svelte');
    const view = render(View, { note: source, workspaceId: 'w' });
    expect(
      dispatch.mock.calls.every(([action]) => action.type === taskPlanAvailabilityRequested.type),
    ).toBe(true);
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit task plan' }));
    await fireEvent.input(await screen.findByLabelText('Required evidence kinds'), {
      target: { value: 'unit, round-trip' },
    });
    await fireEvent.input(screen.getByLabelText('Acceptance criterion'), {
      target: { value: '  Exact café bytes.\n' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Review plan' }));
    expect(await screen.findByText('Original source body')).toBeTruthy();
    expect(dispatch.mock.calls.some(([action]) => action.type === taskPlanConfirmed.type)).toBe(
      false,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm plan' }));
    await vi.waitFor(() => expect(saved).toBeDefined());
    const [confirmationAction] = dispatch.mock.calls.find(
      ([action]) => action.type === taskPlanConfirmed.type,
    )!;
    expect(confirmationAction.payload[0]).toEqual({
      workspaceId: 'w',
      noteId: 't',
      expectedNoteVersion: 7,
      acceptanceCriteria: ['  Exact café bytes.\n'],
      workDefinition: {
        purpose: 'source',
        criteria: [
          {
            index: 0,
            textDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            requiredKinds: ['unit', 'round-trip'],
          },
        ],
        files: [],
      },
    });
    expect(
      dispatch.mock.calls.some(([action]) => action.type === runAgentForNoteRequested.type),
    ).toBe(false);
    await view.rerender({ note: saved, workspaceId: 'w' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Run confirmed task' }));
    expect(dispatch).toHaveBeenLastCalledWith(
      runAgentForNoteRequested('w', 't', 'Exact task', reference, 'original-principal'),
    );
    expect(saved.metadata!.task!.status).toBe('not_started');
    expect(source.metadata!.task!.acceptanceCriteria).toEqual(['Preserve bytes']);
  });

  it('invalidates the review when task source changes and never submits a new snapshot implicitly', async () => {
    const { default: View } = await import('./TaskPlanEditor.svelte');
    const view = render(View, { note: source, workspaceId: 'w' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit task plan' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Review plan' }));
    await screen.findByRole('button', { name: 'Confirm plan' });
    await view.rerender({ note: { ...source, rev: 9, content: 'Changed body' }, workspaceId: 'w' });
    expect(screen.getByRole('status').textContent).toContain('task changed');
    expect(screen.queryByRole('button', { name: 'Confirm plan' })).toBeNull();
    expect(dispatch.mock.calls.some(([action]) => action.type === taskPlanConfirmed.type)).toBe(
      false,
    );
  });

  it('withholds planning inputs and actions when the acknowledged daemon lacks the capability', async () => {
    dispatch.mockResolvedValue(false);
    const { default: View } = await import('./TaskPlanEditor.svelte');
    render(View, { note: source, workspaceId: 'w' });
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: taskPlanAvailabilityRequested.type }),
      ),
    );
    expect(screen.queryByRole('button', { name: 'Edit task plan' })).toBeNull();
    expect(screen.queryByLabelText('Acceptance criterion')).toBeNull();
  });

  it('refuses a reviewed snapshot after the principal or backend lifetime changes even before rendering updates', async () => {
    const { default: View } = await import('./TaskPlanEditor.svelte');
    render(View, { note: source, workspaceId: 'w' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit task plan' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Review plan' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm plan' });
    identity.value = 'replacement-principal';
    await fireEvent.click(confirm);
    expect(dispatch.mock.calls.some(([action]) => action.type === taskPlanConfirmed.type)).toBe(
      false,
    );
  });

  it('retains the exact proposed draft after an uncertain save and requires fresh review after reload', async () => {
    const { default: View } = await import('./TaskPlanEditor.svelte');
    const view = render(View, { note: source, workspaceId: 'w' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit task plan' }));
    await fireEvent.input(await screen.findByLabelText('Acceptance criterion'), {
      target: { value: '  Keep this proposed wording.\n' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Review plan' }));
    dispatch.mockRejectedValueOnce(new Error('connection dropped after possible commit'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Run confirmed task' })).toBeNull();
    const refreshed = {
      ...source,
      rev: 9,
      metadata: {
        task: {
          ...source.metadata!.task!,
          acceptanceCriteria: ['A different canonical criterion'],
        },
      },
    };
    dispatch.mockResolvedValueOnce(refreshed);
    await fireEvent.click(screen.getByRole('button', { name: 'Reload task' }));
    await view.rerender({ note: refreshed, workspaceId: 'w' });
    expect(
      ((await screen.findByLabelText('Acceptance criterion')) as HTMLTextAreaElement).value,
    ).toBe('  Keep this proposed wording.\n');
    expect(screen.queryByRole('button', { name: 'Confirm plan' })).toBeNull();
    expect(
      dispatch.mock.calls.filter(([action]) => action.type === taskPlanConfirmed.type),
    ).toHaveLength(1);
    expect(
      dispatch.mock.calls.some(([action]) => action.type === runAgentForNoteRequested.type),
    ).toBe(false);
  });
});
