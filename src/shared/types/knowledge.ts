/** Recorded-source metadata is retained as an envelope, never inferred from a hit. */
import { z } from 'zod';
import { NativeStateRefSchema } from './vcs';
import { TaskRevisionRefSchema } from './work';

const id = z.string().min(1);
const counter = z.number().int().safe().nonnegative();
const QueryReadBasisSchema = z.strictObject({
  repositoryId: id,
  rootId: id,
  rootEpoch: counter,
  sourceState: NativeStateRefSchema,
  derivedState: NativeStateRefSchema.nullable(),
  provenance: z.literal('importedGitSnapshot'),
  indexEpoch: counter,
  taskRevision: TaskRevisionRefSchema.nullable(),
  sourceEventWatermark: counter.nullable(),
  projectorWatermark: counter.nullable(),
  queryVersion: z.literal(1),
  ontologyVersion: id,
  visibilityDigest: id,
  ignorePolicyDigest: id,
  stale: z.boolean(),
  coverage: z.strictObject({
    candidateFiles: counter,
    readFiles: counter,
    skippedFiles: counter,
    unsupportedGrammarFiles: counter,
    sourceBytes: counter,
    complete: z.boolean(),
  }),
  truncation: z.array(z.enum(['resultLimit', 'byteLimit', 'sourceReadBudget', 'timeBudget'])),
});
export type QueryReadBasis = z.infer<typeof QueryReadBasisSchema>;

export const RetrieveResultSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      file: z.string(),
      symbol: z.string().optional(),
      line: counter.optional(),
      preview: z.string(),
      score: z.number().finite().optional(),
    }),
  ),
  readBasis: QueryReadBasisSchema.optional(),
});
export type RetrieveResult = z.infer<typeof RetrieveResultSchema>;
