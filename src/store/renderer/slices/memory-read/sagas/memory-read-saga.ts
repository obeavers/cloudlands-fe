import { buffers, eventChannel } from 'redux-saga';
import { call, cancel, put, race, take, takeEvery, type SagaGenerator } from 'typed-redux-saga';
import { appClient } from '$lib/client';
import type { AppClient } from '$lib/client/app-client';
import type { NeutralWorkspaceClients } from '$lib/client/live/neutral-workspace-client';
import { takeLatestByWorkspace } from '../../../utils/context-saga-effects';
import {
  workspaceDeleted,
  workspaceUnmounted,
} from '../../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../../workspace/workspace-slice';
import {
  memoryReadMounted,
  memoryReadUnmounted,
  memoryReadRequested,
  memoryReadReady,
  memoryReadLoaded,
  memoryReadLoading,
  memoryReadFailed,
  memoryReadRetired,
} from '../memory-read-slice';

type Client = Pick<AppClient, 'captureNeutralWorkspace'>;
function* viewer(
  client: Client,
  action: ReturnType<typeof memoryReadMounted>,
): SagaGenerator<void> {
  if (!client.captureNeutralWorkspace) return;
  const [workspaceId, viewId] = action.payload;
  let captured: NeutralWorkspaceClients | undefined;
  let published = false;
  let stop = () => {};
  const retired = eventChannel<true>((emit) => {
    stop = () => emit(true);
    return () => {};
  }, buffers.sliding(1));
  const unmounted = yield* takeEvery(memoryReadUnmounted, function* (closed) {
    if (closed.payload[0] === workspaceId && closed.payload[1] === viewId) stop();
  });
  const removed = yield* takeEvery(
    [workspaceUnmounted, workspaceDeleted, removeWorkspaceEntity],
    function* (closed) {
      if (closed.payload[0] === workspaceId) stop();
    },
  );
  try {
    // A capture completing after saga cancellation must release its original owner.
    let accepting = true;
    const capture = client.captureNeutralWorkspace(workspaceId).then((ports) => {
      if (!accepting) void ports.release();
      return ports;
    });
    try {
      const result = yield* race({ captured: call(() => capture), retired: take(retired) });
      if (result.retired || !result.captured) return;
      captured = result.captured;
    } finally {
      accepting = false;
    }
    const memory = captured.memory;
    if (!memory?.available) return;
    const off = captured.onRetired(stop);
    try {
      if (!memory.available) return;
      published = true;
      yield* put(memoryReadReady(workspaceId, viewId, memory.principalId));
      while (true) {
        const next = yield* race({
          request: take(memoryReadRequested),
          retired: take(retired),
        });
        if (next.retired || !memory.available) break;
        const request = next.request as ReturnType<typeof memoryReadRequested>;
        if (request.payload[0] !== workspaceId || request.payload[1] !== viewId) continue;
        yield* put(memoryReadLoading(workspaceId, viewId));
        try {
          const result = yield* race({
            page: call([memory, memory.list], {
              workspaceId,
              limit: 20,
              ...(request.payload[2] ? { after: request.payload[2] } : {}),
            }),
            retired: take(retired),
          });
          if (result.retired || !memory.available) break;
          if (result.page) yield* put(memoryReadLoaded(workspaceId, viewId, result.page));
        } catch {
          if (!memory.available) break;
          yield* put(memoryReadFailed(workspaceId, viewId));
        }
      }
    } finally {
      off();
    }
  } catch {
    // Missing/unsupported opt-in stays hidden; no legacy or current-backend retry.
  } finally {
    yield* cancel(unmounted);
    yield* cancel(removed);
    retired.close();
    if (published) yield* put(memoryReadRetired(workspaceId, viewId));
    if (captured) yield* call([captured, captured.release]);
  }
}
export function* memoryReadSaga(client: Client = appClient): SagaGenerator<void> {
  yield* takeLatestByWorkspace(memoryReadMounted, viewer, client);
}
