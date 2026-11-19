import { createAsyncAction } from '@themislib/themis/utils/store/create-action';
import type { Note } from '$shared/types';
import type { TaskPlanConfiguration, TaskPlanConfirmation } from '$lib/client/app-client';

/** Saga-only triggers: drafts and review snapshots remain local to their editor. */
export const taskPlanAvailabilityRequested = createAsyncAction<[workspaceId: string], boolean>(
  'taskPlanning/availabilityRequested',
  'taskPlanning/availabilitySettled',
);
export const taskPlanOpened = createAsyncAction<
  [workspaceId: string, noteId: string, admission: string],
  Note
>('taskPlanning/opened', 'taskPlanning/openedSettled');
export const taskPlanConfirmed = createAsyncAction<
  [input: TaskPlanConfiguration, admission: string],
  TaskPlanConfirmation
>('taskPlanning/confirmed', 'taskPlanning/confirmedSettled');
