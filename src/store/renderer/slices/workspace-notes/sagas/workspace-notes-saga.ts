import { all, call } from 'typed-redux-saga';

import { noteVersionsSaga } from './note-versions-saga';
import { notesReadSaga } from './notes-read-saga';
import { notesWriteSaga } from './notes-write-saga';
import { taskPlanningSaga } from '../../task-planning/sagas/task-planning-saga';
import { taskEvidenceSaga } from '../../task-evidence/sagas/task-evidence-saga';

export function* workspaceNotesSaga() {
  yield* all([
    call(notesReadSaga),
    call(notesWriteSaga),
    call(noteVersionsSaga),
    call(taskPlanningSaga),
    call(taskEvidenceSaga),
  ]);
}
