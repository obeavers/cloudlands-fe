import type { NeutralWorkspaceContext } from '$shared/types/neutral-workspace';
import type { BackendTransport } from './backend-transport-types';
import { NeutralContractError } from './neutral-client-support';
import { VcsClient } from './vcs-client';
import { WorkClient } from './work-client';
import { MemoryReadClient } from './memory-read-client';

export interface NeutralWorkspaceClients {
  vcs?: VcsClient;
  work?: WorkClient;
  memory?: MemoryReadClient;
  onRetired(handler: () => void): () => void;
  release(): Promise<void>;
}

/** Only published read-model methods are installed; authority/mutation ports remain absent. */
export async function captureNeutralWorkspaceClients(
  transport: BackendTransport,
  workspaceId: string,
): Promise<NeutralWorkspaceClients> {
  if (!transport.captureNeutralWorkspace) throw new NeutralContractError('unavailable');
  const context: NeutralWorkspaceContext = await transport.captureNeutralWorkspace(workspaceId);
  const caps = context.capabilities;
  if (
    !context.isCurrent() ||
    context.workspaceId !== workspaceId ||
    caps.eventStreamRecovery !== 1 ||
    (caps.vcs !== 1 && caps.workEvidence !== 1 && caps.experimentalMemoryRead !== 1)
  ) {
    await context.release();
    throw new NeutralContractError('unavailable');
  }
  const service = {
    isCurrent: () => context.isCurrent(),
    capabilities: () => (context.isCurrent() ? caps : null),
    readModelTransport: context,
  };
  return {
    ...(caps.vcs === 1 ? { vcs: new VcsClient(service) } : {}),
    ...(caps.workEvidence === 1 ? { work: new WorkClient(service) } : {}),
    ...(caps.experimentalMemoryRead === 1 ? { memory: new MemoryReadClient(context) } : {}),
    onRetired: (handler) => context.onRetired(handler),
    release: () => context.release(),
  };
}
