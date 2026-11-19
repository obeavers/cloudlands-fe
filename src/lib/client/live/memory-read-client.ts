import {
  MemoryContextRequestSchema,
  MemoryListRequestSchema,
  MemoryPageSchema,
  MemoryRetrievalSchema,
  type MemoryContextRequest,
  type MemoryListRequest,
  type MemoryPage,
  type MemoryRetrieval,
} from '$shared/types/memory-read';
import type { NeutralWorkspaceContext } from '$shared/types/neutral-workspace';
import { decodeNeutral, NeutralContractError } from './neutral-client-support';

const mismatch = () => new NeutralContractError('scope-mismatch');
const sameTask = (
  left: MemoryContextRequest['taskRevision'],
  right: MemoryContextRequest['taskRevision'],
) =>
  left.workspaceId === right.workspaceId &&
  left.noteId === right.noteId &&
  left.rev === right.rev &&
  left.digest === right.digest;
const overlap = (left: string, right: string) =>
  left === '.' ||
  right === '.' ||
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

/** Reads use one original acknowledged principal/workspace lease; no mutation port exists. */
export class MemoryReadClient {
  constructor(private readonly context: NeutralWorkspaceContext) {}

  get principalId(): string {
    return this.context.principalId;
  }

  get available(): boolean {
    return this.context.isCurrent() && this.context.capabilities.experimentalMemoryRead === 1;
  }

  private check(workspaceId: string) {
    if (!this.available) throw new NeutralContractError('unavailable');
    if (workspaceId !== this.context.workspaceId) throw mismatch();
  }

  async list(input: MemoryListRequest): Promise<MemoryPage> {
    const request = decodeNeutral(MemoryListRequestSchema, input);
    this.check(request.workspaceId);
    const result = decodeNeutral(
      MemoryPageSchema,
      await this.context.request('memory.list', request),
    );
    this.check(request.workspaceId);
    const seen = new Set<string>();
    for (const memory of result.memories) {
      const id = memory.candidate.reference.memoryId;
      if (
        memory.scope.workspaceId !== request.workspaceId ||
        (!request.rootId && memory.scope.repositoryId !== null) ||
        !memory.scope.paths.some((path) =>
          (request.paths ?? ['.']).some((filter) => overlap(path, filter)),
        ) ||
        seen.has(id) ||
        (request.after !== undefined && id <= request.after)
      )
        throw mismatch();
      seen.add(id);
    }
    const last = result.memories.at(-1)?.candidate.reference.memoryId;
    if (
      result.memories.length > (request.limit ?? 20) ||
      (result.nextCursor !== null &&
        (result.nextCursor !== last || result.nextCursor === request.after))
    )
      throw mismatch();
    return result;
  }

  async contextForTask(input: MemoryContextRequest): Promise<MemoryRetrieval> {
    const request = decodeNeutral(MemoryContextRequestSchema, input);
    this.check(request.workspaceId);
    if (request.taskRevision.workspaceId !== request.workspaceId) throw mismatch();
    const result = decodeNeutral(
      MemoryRetrievalSchema,
      await this.context.request('memory.context', request),
    );
    this.check(request.workspaceId);
    const basis = result.readBasis;
    if (
      !sameTask(request.taskRevision, result.taskRevision) ||
      !sameTask(request.taskRevision, basis.scope.taskRevision) ||
      basis.workspaceId !== request.workspaceId ||
      result.candidates.length > (request.limit ?? 20) ||
      basis.coverage.returnedRecords !== result.candidates.length ||
      basis.coverage.retainedPageComplete !== !result.truncated ||
      JSON.stringify(basis.truncation) !==
        JSON.stringify(result.truncated ? ['recordLimit'] : []) ||
      new Set(result.candidates.map((candidate) => candidate.reference.memoryId)).size !==
        result.candidates.length
    )
      throw mismatch();
    return result;
  }
}
