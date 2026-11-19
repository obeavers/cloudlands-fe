import { createAsyncAction } from '@themislib/themis/utils/store/create-action';
import type { TaskEvidenceRequest, TaskEvidenceResponse } from '$shared/types/task-run-evidence';

/** Saga-only triggers. Explicit read snapshots stay local to their mounted viewer. */
export const taskEvidenceAvailabilityRequested = createAsyncAction<[], boolean>(
  'taskEvidence/availabilityRequested',
  'taskEvidence/availabilitySettled',
);
export const taskEvidenceReadRequested = createAsyncAction<
  [request: TaskEvidenceRequest, admission: string],
  TaskEvidenceResponse
>('taskEvidence/readRequested', 'taskEvidence/readSettled');
