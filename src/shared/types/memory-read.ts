/** Experimental read-only mirrors of intent-core::memory; references grant no authority. */
import { z } from 'zod';
import { TaskRevisionRefSchema } from './work';

const id = z.string().min(1).max(512);
const counter = z.number().int().safe().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const utf8Within = (maximum: number) => (value: string) =>
  new TextEncoder().encode(value).byteLength <= maximum;
const MemoryPathSchema = z
  .string()
  .refine(
    (path) =>
      path === '.' ||
      (path.length > 0 &&
        utf8Within(512)(path) &&
        !/[\\:\0]/.test(path) &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')),
  );
const paths = z.array(MemoryPathSchema).min(1).max(32);
const MemoryRevisionRefSchema = z.strictObject({
  memoryId: uuid,
  revision: z.number().int().safe().positive(),
  digest,
});
const kind = z.enum(['decision', 'lesson', 'constraint', 'preference', 'context']);
const candidate = z.strictObject({
  reference: MemoryRevisionRefSchema,
  kind,
  preview: z.string().refine((text) => Array.from(text).length <= 240),
});
const MemorySummarySchema = z.strictObject({
  candidate,
  status: z.enum(['proposed', 'accepted', 'superseded']),
  scope: z.strictObject({
    workspaceId: id,
    repositoryId: id.nullable(),
    paths,
    visibility: z.enum(['owner-private', 'workspace-shared']),
  }),
});
const MemoryReadScopeSchema = z.strictObject({
  workspaceId: id,
  rootId: id.optional(),
  paths: paths.optional(),
});
export const MemoryListRequestSchema = MemoryReadScopeSchema.extend({
  after: uuid.optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();
export const MemoryPageSchema = z.strictObject({
  memories: z.array(MemorySummarySchema).max(20),
  nextCursor: uuid.nullable(),
});
export const MemoryContextRequestSchema = MemoryReadScopeSchema.extend({
  taskRevision: TaskRevisionRefSchema,
  query: z.string().refine(utf8Within(512)).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();
export const MemoryRetrievalSchema = z.strictObject({
  retrievalId: uuid,
  taskRevision: TaskRevisionRefSchema,
  candidates: z.array(candidate).max(20),
  truncated: z.boolean(),
  readBasis: z.strictObject({
    workspaceId: id,
    scope: z.strictObject({
      kind: z.literal('taskLedger'),
      taskRevision: TaskRevisionRefSchema,
    }),
    sourceEventWatermark: counter,
    projectorWatermark: z.null(),
    queryVersion: z.literal(1),
    ontologyVersion: z.literal('intent-memory-ledger-v1'),
    visibilityDigest: digest,
    ignorePolicy: z.literal('notAppliedToLedgerFacts'),
    coverage: z.strictObject({
      returnedRecords: counter,
      omittedForBytes: z.literal(0),
      retainedPageComplete: z.boolean(),
    }),
    truncation: z.array(z.literal('recordLimit')).max(1),
  }),
});
export type MemoryListRequest = z.infer<typeof MemoryListRequestSchema>;
export type MemoryPage = z.infer<typeof MemoryPageSchema>;
export type MemoryContextRequest = z.infer<typeof MemoryContextRequestSchema>;
export type MemoryRetrieval = z.infer<typeof MemoryRetrievalSchema>;
