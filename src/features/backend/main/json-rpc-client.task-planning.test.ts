import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcClient } from './json-rpc-client';

class Socket extends EventEmitter {
  destroyed = false;
  frames: Array<{ id: number; method: string; params: unknown }> = [];
  write(line: string) {
    this.frames.push(JSON.parse(line));
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
  reply(id: number, result: unknown) {
    this.emit('data', Buffer.from(JSON.stringify({ id, result }) + '\n'));
  }
}
const clients: JsonRpcClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.dispose()));
async function connect(taskPlanning: unknown) {
  const socket = new Socket();
  const client = new JsonRpcClient({
    socketFactory: () => socket as unknown as Duplex,
    helloParams: () => ({ clientId: 'original' }),
    heartbeatIntervalMs: 0,
  });
  clients.push(client);
  client.start();
  socket.emit('connect');
  await vi.waitFor(() => expect(socket.frames).toHaveLength(1));
  socket.reply(1, { clientId: 'original', server: { capabilities: { taskPlanning } } });
  await vi.waitFor(() => expect(client.getRepositoryConnection()).not.toBeNull());
  return { socket, client };
}
const pin = { workspaceId: 'w', noteId: 't', rev: 7, digest: 'exact', projectionSchemaVersion: 1 };
describe('confirmed task operands on the actual desktop request connection', () => {
  it.each([undefined, null, false, true, '1', 0, 2])(
    'refuses unsupported capability %j without writing or fallback',
    async (flag) => {
      const { socket, client } = await connect(flag);
      await expect(
        client.request('task.configureWorkDefinition', { workspaceId: 'w' }),
      ).rejects.toMatchObject({ code: 'TASK_PLANNING_UNAVAILABLE' });
      await expect(
        client.request('agent.create', { workspaceId: 'w', expectedTaskRevision: pin }),
      ).rejects.toMatchObject({ code: 'TASK_PLANNING_UNAVAILABLE' });
      expect(socket.frames).toHaveLength(1);
    },
  );
  it('sends exact confirmed operands on the current supported connection and leaves legacy creates unchanged', async () => {
    const { socket, client } = await connect(1);
    const params = { workspaceId: 'w', metadata: { taskNoteId: 't' }, expectedTaskRevision: pin };
    const pending = client.request('agent.create', params);
    expect(socket.frames[1]).toMatchObject({ method: 'agent.create', params });
    socket.reply(2, { agent: { id: 'created' } });
    await expect(pending).resolves.toEqual({ agent: { id: 'created' } });
    const old = await connect(undefined);
    const legacy = old.client.request('agent.create', { workspaceId: 'w' });
    expect(old.socket.frames[1]).toMatchObject({
      method: 'agent.create',
      params: { workspaceId: 'w' },
    });
    old.socket.reply(2, { agent: { id: 'legacy' } });
    await expect(legacy).resolves.toEqual({ agent: { id: 'legacy' } });
  });
  it('refuses during hello replacement without queuing, while preserving a known earlier allocation exactly once', async () => {
    const { socket, client } = await connect(1);
    const created = client.request('agent.create', { workspaceId: 'w', expectedTaskRevision: pin });
    const hello = client.request('client.hello');
    await vi.waitFor(() => expect(socket.frames).toHaveLength(3));
    await expect(
      client.request('agent.create', { expectedTaskRevision: pin }),
    ).rejects.toMatchObject({ code: 'TASK_PLANNING_UNAVAILABLE' });
    expect(socket.frames).toHaveLength(3);
    socket.reply(2, { agent: { id: 'known-original-allocation' } });
    await expect(created).resolves.toEqual({ agent: { id: 'known-original-allocation' } });
    expect(socket.frames.filter((frame) => frame.method === 'agent.create')).toHaveLength(1);
    socket.reply(3, { clientId: 'replacement', server: { capabilities: {} } });
    await hello;
    await expect(
      client.request('agent.create', { expectedTaskRevision: pin }),
    ).rejects.toMatchObject({ code: 'TASK_PLANNING_UNAVAILABLE' });
    expect(socket.frames).toHaveLength(3);
  });
});
