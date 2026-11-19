import { z } from 'zod';
import type { ReadModelRpcTransport } from './neutral-read-model-rpc';
import type { ReadModelSubscriptionPort } from './neutral-read-model-subscription';
import type { NativeStateRef, RootBinding } from '$shared/types/vcs';
import { resolveVcsMode, supportsNeutralCapability } from '$lib/vcs/vcs-mode';

export interface NeutralServiceLifetime {
  readonly readModel?: ReadModelSubscriptionPort;
  readonly readModelTransport?: ReadModelRpcTransport;
  /** The original captured transport/account context, never the newly focused backend. */
  isCurrent(): boolean;
  /** Raw acknowledged capabilities; unsupported versions must not be masked to absence. */
  capabilities(): Record<string, unknown> | null;
}

export class NeutralContractError extends Error {
  constructor(readonly reason: 'unavailable' | 'malformed-response' | 'scope-mismatch') {
    super(`Neutral client contract refused: ${reason}`);
    this.name = 'NeutralContractError';
  }
}

export function decodeNeutral<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new NeutralContractError('malformed-response');
  return result.data;
}

export function assertNeutralLifetime(
  lifetime: NeutralServiceLifetime,
  root?: RootBinding,
  capability: 'vcs' | 'workEvidence' | 'knowledge' = 'vcs',
): void {
  const capabilities = lifetime.capabilities();
  if (!lifetime.isCurrent() || !supportsNeutralCapability(capabilities, capability))
    throw new NeutralContractError('unavailable');
  if (root && resolveVcsMode(root.kind, capabilities).mode !== 'native')
    throw new NeutralContractError('unavailable');
}

export function assertNativeScope(
  root: RootBinding,
  state: Pick<NativeStateRef, 'repositoryId' | 'kind'>,
): void {
  if (root.repositoryId !== state.repositoryId || root.kind !== state.kind)
    throw new NeutralContractError('scope-mismatch');
}
