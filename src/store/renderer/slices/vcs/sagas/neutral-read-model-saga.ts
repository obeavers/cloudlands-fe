/** Dormant with the default AppClient: no neutral ports are registered before backend readiness. */
import { buffers, eventChannel } from 'redux-saga';
import { put, take, type SagaGenerator } from 'typed-redux-saga';
import { appClient } from '$lib/client';
import type { AppClient } from '$lib/client/app-client';
import type { NeutralWorkspaceClients } from '$lib/client/live/neutral-workspace-client';
import { takeLatestByWorkspace } from '../../../utils/context-saga-effects';
import {
  workspaceMounted,
  workspaceUnmounted,
  workspaceDeleted,
} from '../../workspace-lifecycle/workspace-lifecycle-slice';
import { removeWorkspaceEntity } from '../../workspace/workspace-slice';
import { vcsCaptureStarted, vcsProjectionUpdated, vcsCaptureRetired } from '../vcs-slice';
import {
  workCaptureStarted,
  workProjectionUpdated,
  workCaptureRetired,
} from '../../work/work-slice';

type ProjectionAction =
  | ReturnType<typeof vcsCaptureRetired>
  | ReturnType<typeof workCaptureRetired>
  | ReturnType<typeof vcsCaptureStarted>
  | ReturnType<typeof vcsProjectionUpdated>
  | ReturnType<typeof workCaptureStarted>
  | ReturnType<typeof workProjectionUpdated>;
type LifecycleAction =
  | ReturnType<typeof workspaceMounted>
  | ReturnType<typeof workspaceUnmounted>
  | ReturnType<typeof workspaceDeleted>
  | ReturnType<typeof removeWorkspaceEntity>;
type Client = Pick<
  AppClient,
  'vcs' | 'work' | 'captureNeutralWorkspace' | 'onNeutralWorkspaceReady'
>;
function* forward(client: Client, action: LifecycleAction): SagaGenerator<void> {
  if (action.type !== workspaceMounted.type) return;
  if (
    !client.captureNeutralWorkspace &&
    !client.vcs?.canSubscribeReadModel &&
    !client.work?.canSubscribeReadModel
  )
    return;
  const workspaceId = action.payload[0];
  const channel = eventChannel<ProjectionAction>((emit) => {
    let generation = 0;
    let closed = false;
    let captured: NeutralWorkspaceClients | undefined;
    const disposers: (() => void)[] = [];
    let vcsId: string | undefined;
    let workId: string | undefined;
    const clear = () => {
      for (const dispose of disposers.splice(0)) dispose();
      if (vcsId) emit(vcsCaptureRetired(workspaceId, vcsId));
      if (workId) emit(workCaptureRetired(workspaceId, workId));
      vcsId = workId = undefined;
      const previous = captured;
      captured = undefined;
      void previous?.release();
    };
    const install = (ports: Pick<AppClient, 'vcs' | 'work'>) => {
      if (ports.vcs?.canSubscribeReadModel)
        disposers.push(
          ports.vcs.subscribeReadModel(workspaceId, {
            started: (ws, id) => {
              vcsId = id;
              emit(vcsCaptureStarted(ws, id));
            },
            updated: (view) => emit(vcsProjectionUpdated(view)),
          }),
        );
      if (ports.work?.canSubscribeReadModel)
        disposers.push(
          ports.work.subscribeReadModel(workspaceId, {
            started: (ws, id) => {
              workId = id;
              emit(workCaptureStarted(ws, id));
            },
            updated: (view) => emit(workProjectionUpdated(view)),
          }),
        );
    };
    const acquire = () => {
      if (closed || !client.captureNeutralWorkspace) return;
      const attempt = ++generation;
      clear();
      void client.captureNeutralWorkspace(workspaceId).then(
        (ports) => {
          if (closed || attempt !== generation) {
            void ports.release();
            return;
          }
          captured = ports;
          try {
            install(ports);
            disposers.push(
              ports.onRetired(() => {
                if (!closed && attempt === generation) acquire();
              }),
            );
          } catch {
            clear();
          }
        },
        () => {
          /* Unavailable stays dormant until a new acknowledged connection or mount. */
        },
      );
    };
    const offReady = client.onNeutralWorkspaceReady?.(acquire);
    if (client.captureNeutralWorkspace) acquire();
    else
      try {
        install(client);
      } catch {
        clear();
      }
    return () => {
      closed = true;
      generation += 1;
      offReady?.();
      clear();
    };
  }, buffers.expanding<ProjectionAction>());
  try {
    while (true) yield* put(yield* take(channel));
  } finally {
    channel.close();
  }
}
export function* neutralReadModelSaga(client: Client = appClient): SagaGenerator<void> {
  yield* takeLatestByWorkspace(
    [workspaceMounted, workspaceUnmounted, workspaceDeleted, removeWorkspaceEntity],
    forward,
    client,
  );
}
