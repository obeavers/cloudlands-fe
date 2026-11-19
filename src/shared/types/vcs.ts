/**
 * Internal mirror of intent-core::vcs. No RPC registration or engine availability
 * follows from importing these contracts. Native identities retain their tags.
 */
import { z } from 'zod';

const identity = z.string().min(1);
const integer = z.number().int().safe();
const counter = integer.nonnegative();
const u32 = counter.max(0xffff_ffff);

export const VcsKindSchema = z.enum(['git', 'atomic']);

export const RootBindingSchema = z.strictObject({
  workspaceId: identity,
  rootId: identity,
  repositoryId: identity,
  kind: VcsKindSchema,
  locator: identity,
  epoch: counter,
});
export type RootBinding = z.infer<typeof RootBindingSchema>;

export const NativeChangeRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git'), repositoryId: identity, commit: identity }),
  z.strictObject({ kind: z.literal('atomic'), repositoryId: identity, change: identity }),
]);

export const NativeStateRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('git'),
    repositoryId: identity,
    commit: identity.nullable(),
    tree: identity,
  }),
  z.strictObject({
    kind: z.literal('atomic'),
    repositoryId: identity,
    view: identity,
    effectiveState: identity,
    ownMerkle: identity,
    manifest: identity,
  }),
]);
export type NativeStateRef = z.infer<typeof NativeStateRefSchema>;

const NativeObjectRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git'), object: identity }),
  z.strictObject({ kind: z.literal('atomic'), digest: identity }),
]);

export const VcsCapabilitiesSchema = z.strictObject({
  staging: z.boolean(),
  hunkStaging: z.boolean(),
  turnRecords: z.boolean(),
  exactRecord: z.boolean(),
  composition: z.boolean(),
  materialization: z.boolean(),
  closureExport: z.boolean(),
  closureRestore: z.boolean(),
  provenance: z.boolean(),
  triage: z.boolean(),
  firstClassConflicts: z.boolean(),
});
export type VcsCapabilities = z.infer<typeof VcsCapabilitiesSchema>;

const VcsFileEntrySchema = z.strictObject({
  path: identity,
  status: z.enum(['M', 'A', 'D', 'R', 'C', '?', '!']),
  staged: z.boolean(),
  conflicted: z.boolean().nullable(),
  mode: z.string().nullable(),
  oldObject: NativeObjectRefSchema.nullable(),
  newObject: NativeObjectRefSchema.nullable(),
});

export const VcsStatusSchema = z.strictObject({
  kind: VcsKindSchema,
  branch: z.string(),
  view: z.string().nullable(),
  ahead: integer,
  behind: integer,
  diverged: z.boolean(),
  files: z.array(VcsFileEntrySchema),
  hasUncommittedChanges: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  filesTruncated: z.boolean(),
  totalFiles: counter.nullable(),
  hasUpstream: z.boolean(),
  unpushedCount: integer.nullable(),
  conflicts: counter.nullable(),
});
export type VcsStatus = z.infer<typeof VcsStatusSchema>;

export const HistoryEntrySchema = z.strictObject({
  change: NativeChangeRefSchema,
  message: z.string(),
  author: z.string(),
  authorEmail: z.string(),
  date: z.string(),
  files: z.array(z.string()).nullable(),
  filesChanged: counter,
  published: z.boolean(),
  agentId: z.string().nullable(),
  linkedNoteId: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

const HistorySnapshotSchema = z.strictObject({
  head: NativeChangeRefSchema,
  boundary: NativeChangeRefSchema.nullable(),
  upstream: NativeChangeRefSchema.nullable(),
});
export const HistoryReadSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('since'),
    baseRef: z.string().nullable(),
    limit: counter,
    includeFiles: z.boolean(),
  }),
  z.strictObject({
    mode: z.literal('bounded'),
    boundary: NativeChangeRefSchema.nullable(),
    limit: counter,
    includeOlder: z.boolean(),
    includeFiles: z.boolean(),
  }),
  z.strictObject({
    mode: z.literal('snapshot'),
    snapshot: HistorySnapshotSchema,
    limit: counter,
    includeOlder: z.boolean(),
    includeFiles: z.boolean(),
  }),
]);
export type HistoryRead = z.infer<typeof HistoryReadSchema>;

const DiffLineSchema = z.strictObject({
  kind: z.enum(['context', 'addition', 'deletion']),
  content: z.string(),
  oldLineno: u32.nullable(),
  newLineno: u32.nullable(),
});
const DiffHunkSchema = z.strictObject({
  oldStart: u32,
  oldLines: u32,
  newStart: u32,
  newLines: u32,
  lines: z.array(DiffLineSchema),
});
const FileDiffSchema = z.strictObject({
  path: identity,
  additions: counter,
  deletions: counter,
  isBinary: z.boolean(),
  oldObject: NativeObjectRefSchema.nullable(),
  newObject: NativeObjectRefSchema.nullable(),
  oldIsGitlink: z.boolean(),
  newIsGitlink: z.boolean(),
});
const FileDiffWithHunksSchema = z.strictObject({
  file: FileDiffSchema,
  hunks: z.array(DiffHunkSchema),
  truncatedReason: z.literal('file-too-large').optional(),
});
export const DiffPageSchema = z.strictObject({
  before: NativeStateRefSchema,
  after: NativeStateRefSchema,
  beforeCapture: identity,
  afterCapture: identity,
  files: z.array(FileDiffWithHunksSchema),
  nextToken: identity.nullable(),
});
export type DiffPage = z.infer<typeof DiffPageSchema>;
export const DiffQuerySchema = z.strictObject({ paths: z.array(z.string()), maxBytes: u32 });
export type DiffQuery = z.infer<typeof DiffQuerySchema>;

/** Scope equality includes the binding epoch; a path is never permission. */
export function sameRootBinding(left: RootBinding, right: RootBinding): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.rootId === right.rootId &&
    left.repositoryId === right.repositoryId &&
    left.kind === right.kind &&
    left.epoch === right.epoch &&
    left.locator === right.locator
  );
}
