import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC_CHANNELS } from '$shared/ipc-registry';
import { captureNeutralWorkspaceSession } from '$shared/neutral-workspace-session';
import {
  neutralCapabilities,
  NeutralWorkspaceBoundSchema,
  NeutralWorkspaceInvokeSchema,
  NeutralWorkspaceQuerySchema,
  type NeutralWorkspaceContext,
} from '$shared/types/neutral-workspace';
import {
  getStrictBackendBindingForWebContents,
  onStrictBackendBindingRetired,
} from '../../../main/window-backend';
import type { JsonRpcClient } from './json-rpc-client';

/** Never dials, switches backend, or renegotiates identity to satisfy a capture. */
export function registerNeutralWorkspaceHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  deps: { readBackend(id: string): JsonRpcClient | undefined },
) {
  const channels = IPC_CHANNELS.BACKEND.NEUTRAL_WORKSPACE;
  type Binding = NonNullable<ReturnType<typeof getStrictBackendBindingForWebContents>>;
  type Owner = {
    id: string;
    sender: WebContents;
    binding: Binding;
    client: JsonRpcClient;
    connection: NonNullable<ReturnType<JsonRpcClient['getRepositoryConnection']>>;
    workspaceId: string;
    retired: boolean;
    sequence: number;
    session?: NeutralWorkspaceContext;
    stop: () => void;
  };
  const owners = new Map<string, Owner>();
  let disposed = false;
  const refused = () => ({
    ok: false as const,
    error: { code: 'NEUTRAL_WORKSPACE_UNAVAILABLE', message: 'NEUTRAL_WORKSPACE_UNAVAILABLE' },
  });
  const current = (owner: Owner) =>
    !disposed &&
    !owner.retired &&
    getStrictBackendBindingForWebContents(owner.sender) === owner.binding &&
    deps.readBackend(owner.binding.backendId) === owner.client &&
    owner.client.getRepositoryConnection() === owner.connection;
  function send(
    owner: Owner,
    item:
      | { type: 'notification'; notification: { method: string; params?: unknown } }
      | { type: 'barrier' | 'retired' },
  ) {
    if (owner.sender.isDestroyed() || owner.sender.mainFrame !== owner.binding.frame) return;
    try {
      owner.binding.frame.send(channels.INGRESS, {
        ...item,
        id: owner.id,
        sequence: ++owner.sequence,
      });
    } catch {
      retire(owner);
    }
  }
  function retire(owner: Owner) {
    if (owner.retired) return;
    owner.retired = true;
    owners.delete(owner.id);
    owner.stop();
    send(owner, { type: 'retired' });
    void owner.session?.release();
  }
  ipc.handle(channels.CAPTURE, async (event, raw: unknown) => {
    const query = NeutralWorkspaceQuerySchema.safeParse(raw);
    const binding = getStrictBackendBindingForWebContents(event.sender);
    if (
      !query.success ||
      disposed ||
      !binding ||
      binding.frame !== event.senderFrame ||
      owners.size >= 64
    )
      return refused();
    const client = deps.readBackend(binding.backendId);
    const connection = client?.getRepositoryConnection();
    const hello = client?.getAcknowledgedHello();
    if (
      !client ||
      !connection ||
      !neutralCapabilities(hello) ||
      !client.getAcknowledgedHelloIdentity(connection) ||
      client.getAcknowledgedHelloIdentity(connection)?.connectionRole !== undefined
    )
      return refused();
    const producer = client.beginOriginalProducer();
    let producerFinished = false;
    const finishProducer = () => {
      if (producerFinished) return;
      producerFinished = true;
      client.finishOriginalProducer(producer);
    };
    const owner: Owner = {
      id: randomUUID(),
      sender: event.sender,
      binding,
      client,
      connection,
      workspaceId: query.data.workspaceId,
      retired: false,
      sequence: 0,
      stop: () => {},
    };
    owners.set(owner.id, owner);
    const offBinding = onStrictBackendBindingRetired(owner.sender, () => retire(owner));
    const physicalRetired = new Set<() => void>();
    const notifications = new Set<(notification: { method: string; params?: unknown }) => void>();
    const offPhysical = client.onRepositoryConnectionEvent((item) => {
      if (
        item.type === 'notification' &&
        item.incarnation === connection.incarnation &&
        current(owner)
      ) {
        for (const handler of [...notifications]) handler(item.notification);
      } else if (
        (item.type === 'closed' && item.incarnation === connection.incarnation) ||
        (item.type === 'identity-retired' && item.connection === connection)
      )
        retire(owner);
    });
    owner.stop = () => {
      offBinding();
      offPhysical();
      for (const handler of [...physicalRetired]) handler();
      physicalRetired.clear();
      notifications.clear();
    };
    if (owner.retired) owner.stop();
    try {
      const session = await captureNeutralWorkspaceSession(owner.workspaceId, {
        hello,
        isCurrent: () => current(owner),
        request: (method, params) =>
          client.requestOnCapturedConnection(connection, method, params, undefined, producer),
        onNotification(handler) {
          notifications.add(handler);
          return () => {
            notifications.delete(handler);
          };
        },
        onRetired(handler) {
          physicalRetired.add(handler);
          if (!current(owner)) handler();
          return () => {
            physicalRetired.delete(handler);
          };
        },
      });
      owner.session = session;
      // Release the enrolled producer only after all original requests and lease cleanup join.
      session.onRetired(() => {
        retire(owner);
        void session.release().finally(finishProducer);
      });
      if (!current(owner) || !session.isCurrent()) {
        await session.release();
        finishProducer();
        return refused();
      }
      session.onNotification((notification) => send(owner, { type: 'notification', notification }));
      return {
        ok: true as const,
        result: {
          id: owner.id,
          workspaceId: owner.workspaceId,
          principalId: session.principalId,
          capabilities: session.capabilities,
        },
      };
    } catch {
      retire(owner);
      finishProducer();
      return refused();
    }
  });
  function owned(event: IpcMainInvokeEvent, raw: unknown) {
    const query = NeutralWorkspaceBoundSchema.safeParse(raw);
    if (!query.success) return undefined;
    const owner = owners.get(query.data.id);
    if (
      !owner ||
      owner.sender !== event.sender ||
      owner.binding.frame !== event.senderFrame ||
      owner.workspaceId !== query.data.workspaceId ||
      !current(owner) ||
      !owner.session?.isCurrent()
    )
      return undefined;
    return owner;
  }
  ipc.handle(channels.REQUEST, async (event, raw: unknown) => {
    const query = NeutralWorkspaceInvokeSchema.safeParse(raw);
    if (!query.success) return refused();
    const owner = owned(event, { id: query.data.id, workspaceId: query.data.workspaceId });
    if (!owner?.session) return refused();
    try {
      const result = await owner.session.request(
        query.data.request.method,
        query.data.request.params,
      );
      if (!current(owner)) return refused();
      if (query.data.request.method === 'events.fence') {
        send(owner, { type: 'barrier' });
        return { ok: true as const, result, barrier: owner.sequence };
      }
      return { ok: true as const, result };
    } catch {
      return refused();
    }
  });
  ipc.handle(channels.RELEASE, async (event, raw: unknown) => {
    const owner = owned(event, raw);
    if (owner) {
      retire(owner);
      await owner.session?.release();
    }
    return { ok: true as const, result: {} };
  });
  return {
    retireBackend(id: string) {
      for (const owner of [...owners.values()]) if (owner.binding.backendId === id) retire(owner);
    },
    dispose() {
      disposed = true;
      for (const owner of [...owners.values()]) retire(owner);
    },
  };
}
