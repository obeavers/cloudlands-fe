import type { Unsubscribe } from '../app-client';
import type { ReadModelCursor } from '$shared/types/work-read-model';
import { NeutralContractError } from './neutral-client-support';
import { NeutralReadModel } from './neutral-read-model';

/** Internal transport port, supplied by the authorized router adapter once published. */
export interface ReadModelSubscriptionPort {
  subscribe(
    workspaceId: string,
    cursor: ReadModelCursor | null,
    push: (frame: unknown) => void,
    onInvalidated: () => void,
  ): Promise<Unsubscribe>;
  onReconnect(handler: () => void): Unsubscribe;
}

/** One captured registration, bounded recovery failures, and late-ack disposal. */
export function subscribeNeutralReadModel(
  workspaceId: string,
  model: NeutralReadModel,
  port: ReadModelSubscriptionPort,
): Unsubscribe {
  let closed = false,
    generation = 0,
    failures = 0;
  let dispose: Unsubscribe | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastStart = -Infinity;
  const prefix = crypto.randomUUID();
  const register = async () => {
    if (closed) return;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    dispose?.();
    dispose = undefined;
    const current = ++generation;
    lastStart = Date.now();
    const capture = model.capture(`${prefix}:${current}`);
    let requested = false,
      settled = false,
      scheduled = false;
    const schedule = (delay: number) => {
      if (closed || current !== generation || scheduled) return;
      scheduled = true;
      retry = setTimeout(
        () => {
          void register();
        },
        Math.max(delay, 250 - (Date.now() - lastStart)),
      );
    };
    const recover = () => {
      if (closed || current !== generation || requested) return;
      requested = true;
      capture.failed();
      if (settled) schedule(250);
    };
    try {
      const unsubscribe = await port.subscribe(
        workspaceId,
        capture.cursor,
        (frame) => {
          if (closed || current !== generation) return;
          if (capture.push(frame) === 'resnapshot') recover();
        },
        recover,
      );
      settled = true;
      if (closed || current !== generation) unsubscribe();
      else if (requested) {
        unsubscribe();
        schedule(250);
      } else {
        dispose = unsubscribe;
        capture.confirmed();
        failures = 0;
      }
    } catch (error) {
      settled = true;
      if (closed || current !== generation) return;
      capture.failed();
      if (error instanceof NeutralContractError && error.reason === 'unavailable') return;
      if (requested) {
        schedule(250);
        return;
      }
      failures += 1;
      if (failures <= 2) schedule(failures === 1 ? 1000 : 4000);
    }
  };
  const stopReconnect = port.onReconnect(() => {
    failures = 0;
    void register();
  });
  void register();
  return () => {
    closed = true;
    generation += 1;
    if (retry !== undefined) clearTimeout(retry);
    dispose?.();
    stopReconnect();
  };
}
