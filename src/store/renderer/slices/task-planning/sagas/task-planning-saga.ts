import { all, call, put, takeEvery } from 'typed-redux-saga';
import { appClient } from '$lib/client';
import { m } from '$shared/paraglide/messages.js';
import { isNoteContentStale } from '$shared/utils/note-content';
import { selectHidesAgentLifecycleActions } from '../../workspace/workspace-selectors';
import { selectPrincipalActionContext } from '../../principal/principal-selectors';
import { applyNoteUpdated } from '../../workspace-notes/workspace-notes-slice';
import {
  taskPlanAvailabilityRequested,
  taskPlanConfirmed,
  taskPlanOpened,
} from '../task-planning-slice';

function* requirePlanning(workspaceId: string) {
  if (yield* selectHidesAgentLifecycleActions.effect(workspaceId)) {
    throw new Error(m.task_plan_unavailable_error());
  }
  if (
    !appClient.tasks.supportsPlanning ||
    !appClient.tasks.configureWorkDefinition ||
    !(yield* call([appClient.tasks, appClient.tasks.supportsPlanning]))
  ) {
    throw new Error(m.task_plan_unavailable_error());
  }
}

function* taskPlanAvailability(action: ReturnType<typeof taskPlanAvailabilityRequested>) {
  try {
    yield* call(requirePlanning, action.payload[0]);
    yield* put(action.success(true));
  } catch {
    yield* put(action.success(false));
  }
}

/** @internal Deterministic original-principal admission test seam. */
export function* openTaskPlan(action: ReturnType<typeof taskPlanOpened>) {
  const [workspaceId, noteId, admission] = action.payload;
  try {
    if (!admission || admission !== (yield* selectPrincipalActionContext.effect()))
      throw new Error(m.task_plan_stale_error());
    yield* call(requirePlanning, workspaceId);
    if (admission !== (yield* selectPrincipalActionContext.effect()))
      throw new Error(m.task_plan_stale_error());
    const note = yield* call([appClient.notes, appClient.notes.get], noteId, workspaceId);
    if (
      !note ||
      String(note.workspaceId) !== workspaceId ||
      note.id !== noteId ||
      !note.metadata?.task ||
      note.contentTruncated ||
      isNoteContentStale(note) ||
      admission !== (yield* selectPrincipalActionContext.effect())
    ) {
      throw new Error(m.task_plan_stale_error());
    }
    yield* put(applyNoteUpdated(workspaceId, noteId, note));
    yield* put(action.success(note));
  } catch (error) {
    yield* put(action.failure(error instanceof Error ? error : new Error(String(error))));
  }
}

/** @internal Deterministic original-principal confirmation test seam. */
export function* confirmTaskPlan(action: ReturnType<typeof taskPlanConfirmed>) {
  const [input, admission] = action.payload;
  try {
    if (!admission || admission !== (yield* selectPrincipalActionContext.effect()))
      throw new Error(m.task_plan_stale_error());
    yield* call(requirePlanning, input.workspaceId);
    if (admission !== (yield* selectPrincipalActionContext.effect()))
      throw new Error(m.task_plan_stale_error());
    const configure = appClient.tasks.configureWorkDefinition;
    if (!configure) throw new Error(m.task_plan_unavailable_error());
    const confirmation = yield* call([appClient.tasks, configure], input);
    // Keep the save receipt, but never publish an old backend's note into a replacement.
    if (admission === (yield* selectPrincipalActionContext.effect())) {
      yield* put(applyNoteUpdated(input.workspaceId, input.noteId, confirmation.note));
    }
    yield* put(action.success(confirmation));
  } catch (error) {
    yield* put(action.failure(error instanceof Error ? error : new Error(String(error))));
  }
}

export function* taskPlanningSaga() {
  yield* all([
    takeEvery(taskPlanAvailabilityRequested, taskPlanAvailability),
    takeEvery(taskPlanOpened, openTaskPlan),
    takeEvery(taskPlanConfirmed, confirmTaskPlan),
  ]);
}
