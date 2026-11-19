import { createReadModelRpcPort } from './neutral-read-model-rpc';
import type { ReadModelSubscriptionPort } from './neutral-read-model-subscription';
import type { Unsubscribe } from '../app-client';
import { subscribeNeutralReadModel } from './neutral-read-model-subscription';
import { supportsNeutralCapability } from '$lib/vcs/vcs-mode';
/**
 * Normalized internal service adapter. No backendRequest method names live here:
 * the authorized RPC owner supplies ports only after protocol and router readiness.
 */
import { z } from 'zod';
import {
  DiffPageSchema,
  DiffQuerySchema,
  HistoryEntrySchema,
  HistoryReadSchema,
  NativeStateRefSchema,
  RootBindingSchema,
  VcsStatusSchema,
  VcsCapabilitiesSchema,
  type VcsCapabilities,
  type DiffPage,
  type DiffQuery,
  type HistoryEntry,
  type HistoryRead,
  type NativeStateRef,
  type RootBinding,
  type VcsStatus,
} from '$shared/types/vcs';
import {
  assertNativeScope,
  assertNeutralLifetime,
  decodeNeutral,
  NeutralContractError,
  type NeutralServiceLifetime,
} from './neutral-client-support';

export interface VcsServicePort extends NeutralServiceLifetime {
  engineCapabilities?(root: RootBinding): Promise<unknown>;
  status?(root: RootBinding): Promise<unknown>;
  history?(root: RootBinding, read: HistoryRead): Promise<unknown>;
  diff?(
    root: RootBinding,
    before: NativeStateRef,
    after: NativeStateRef,
    query: DiffQuery,
    nextToken?: string,
  ): Promise<unknown>;
}

import { NeutralReadModel, type ReadModelSink } from './neutral-read-model';

export class VcsClient {
  private readonly projectionPort: ReadModelSubscriptionPort | undefined;
  constructor(private readonly service: VcsServicePort) {
    this.projectionPort =
      service.readModel ??
      (service.readModelTransport
        ? createReadModelRpcPort('vcs', service.readModelTransport, service)
        : undefined);
  }

  get canSubscribeReadModel(): boolean {
    return Boolean(
      this.projectionPort &&
      this.service.isCurrent() &&
      supportsNeutralCapability(this.service.capabilities(), 'vcs'),
    );
  }

  subscribeReadModel(workspaceId: string, sink: ReadModelSink): Unsubscribe {
    if (!this.canSubscribeReadModel || !this.projectionPort)
      throw new NeutralContractError('unavailable');
    return subscribeNeutralReadModel(
      workspaceId,
      this.readModel(workspaceId, sink),
      this.projectionPort,
    );
  }

  readModel(workspaceId: string, sink: ReadModelSink): NeutralReadModel {
    assertNeutralLifetime(this.service, undefined, 'vcs');
    return new NeutralReadModel(workspaceId, 'vcs', this.service, sink);
  }

  async capabilities(binding: RootBinding): Promise<VcsCapabilities> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root);
    if (!this.service.engineCapabilities) throw new NeutralContractError('unavailable');
    const result = decodeNeutral(
      VcsCapabilitiesSchema,
      await this.service.engineCapabilities(root),
    );
    assertNeutralLifetime(this.service, root);
    return result;
  }

  async status(binding: RootBinding): Promise<VcsStatus> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root);
    if (!this.service.status) throw new NeutralContractError('unavailable');
    const result = decodeNeutral(VcsStatusSchema, await this.service.status(root));
    assertNeutralLifetime(this.service, root);
    if (
      result.kind !== root.kind ||
      result.files.some(
        (file) =>
          (file.oldObject && file.oldObject.kind !== root.kind) ||
          (file.newObject && file.newObject.kind !== root.kind),
      )
    )
      throw new NeutralContractError('scope-mismatch');
    return result;
  }

  async history(binding: RootBinding, input: HistoryRead): Promise<HistoryEntry[]> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root);
    const read = decodeNeutral(HistoryReadSchema, input);
    if (read.mode === 'bounded' && read.boundary) assertNativeScope(root, read.boundary);
    if (read.mode === 'snapshot') {
      assertNativeScope(root, read.snapshot.head);
      if (read.snapshot.boundary) assertNativeScope(root, read.snapshot.boundary);
      if (read.snapshot.upstream) assertNativeScope(root, read.snapshot.upstream);
    }
    if (!this.service.history) throw new NeutralContractError('unavailable');
    const rows = decodeNeutral(z.array(HistoryEntrySchema), await this.service.history(root, read));
    assertNeutralLifetime(this.service, root);
    for (const row of rows) assertNativeScope(root, row.change);
    return rows;
  }

  async diff(
    binding: RootBinding,
    before: NativeStateRef,
    after: NativeStateRef,
    query: DiffQuery,
    nextToken?: string,
  ): Promise<DiffPage> {
    const root = decodeNeutral(RootBindingSchema, binding);
    assertNeutralLifetime(this.service, root);
    const from = decodeNeutral(NativeStateRefSchema, before);
    const to = decodeNeutral(NativeStateRefSchema, after);
    assertNativeScope(root, from);
    assertNativeScope(root, to);
    if (!this.service.diff) throw new NeutralContractError('unavailable');
    const result = decodeNeutral(
      DiffPageSchema,
      await this.service.diff(root, from, to, decodeNeutral(DiffQuerySchema, query), nextToken),
    );
    assertNeutralLifetime(this.service, root);
    assertNativeScope(root, result.before);
    assertNativeScope(root, result.after);
    if (
      JSON.stringify(result.before) !== JSON.stringify(from) ||
      JSON.stringify(result.after) !== JSON.stringify(to)
    )
      throw new NeutralContractError('scope-mismatch');
    for (const { file } of result.files)
      if (
        (file.oldObject && file.oldObject.kind !== root.kind) ||
        (file.newObject && file.newObject.kind !== root.kind)
      )
        throw new NeutralContractError('scope-mismatch');
    return result;
  }
}
