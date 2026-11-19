import { backendRequest, observeBackendNodeCapabilities } from './backend-transport';
import {
  TaskEvidenceRequestSchema,
  decodeTaskEvidence,
  type TaskEvidenceRequest,
  type TaskEvidenceResponse,
} from '$shared/types/task-run-evidence';

/** Explicit bounded reads of retained facts; no subscription, polling, or source walk. */
export async function supportsTaskEvidenceRead(): Promise<boolean> {
  const hello = (await observeBackendNodeCapabilities()) as {
    server?: { capabilities?: { taskEvidenceRead?: unknown } };
  } | null;
  return hello?.server?.capabilities?.taskEvidenceRead === 1;
}

export async function readTaskEvidence(input: TaskEvidenceRequest): Promise<TaskEvidenceResponse> {
  const request = TaskEvidenceRequestSchema.parse(input);
  return decodeTaskEvidence(request, await backendRequest('task.workEvidence', request));
}
