import { all, call, put, takeEvery } from 'typed-redux-saga';
import { appClient } from '$lib/client';
import { selectPrincipalActionContext } from '../../principal/principal-selectors';
import { m } from '$shared/paraglide/messages.js';
import {
  taskEvidenceAvailabilityRequested,
  taskEvidenceReadRequested,
} from '../task-evidence-slice';

function* supportsEvidence() {
  return !!(
    appClient.tasks.supportsEvidenceRead &&
    appClient.tasks.workEvidence &&
    (yield* call([appClient.tasks, appClient.tasks.supportsEvidenceRead]))
  );
}

function* availability(action: ReturnType<typeof taskEvidenceAvailabilityRequested>) {
  try {
    yield* put(action.success(yield* call(supportsEvidence)));
  } catch {
    yield* put(action.success(false));
  }
}

/** @internal Deterministic captured-principal evidence-read test seam. */
export function* readTaskRunEvidence(action: ReturnType<typeof taskEvidenceReadRequested>) {
  const [request, admission] = action.payload;
  try {
    if (
      !admission ||
      admission !== (yield* selectPrincipalActionContext.effect()) ||
      !(yield* call(supportsEvidence))
    )
      throw new Error(m.task_evidence_unavailable_error());
    if (admission !== (yield* selectPrincipalActionContext.effect()))
      throw new Error(m.task_evidence_retired_error());
    const read = appClient.tasks.workEvidence;
    if (!read) throw new Error(m.task_evidence_unavailable_error());
    const response = yield* call([appClient.tasks, read], request);
    if (admission !== (yield* selectPrincipalActionContext.effect()))
      throw new Error(m.task_evidence_retired_error());
    yield* put(action.success(response));
  } catch (error) {
    yield* put(action.failure(error instanceof Error ? error : new Error(String(error))));
  }
}

export function* taskEvidenceSaga() {
  yield* all([
    takeEvery(taskEvidenceAvailabilityRequested, availability),
    takeEvery(taskEvidenceReadRequested, readTaskRunEvidence),
  ]);
}
