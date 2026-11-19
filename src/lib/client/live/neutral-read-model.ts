/** Strict scoped projection fold; transport registration is supplied only after protocol readiness. */
import {
  ReadModelFrameSchema,
  readModelItemInScope,
  readModelItemRequiresAtomic,
  ReadModelItemSchema,
  type ReadModelFrame,
  type ReadModelChannel,
  type ReadModelCursor,
  type ReadModelItem,
} from '$shared/types/work-read-model';
import { DeltaReconciler } from './delta-subscription';
import { type NeutralServiceLifetime } from './neutral-client-support';
import { supportsNeutralCapability } from '$lib/vcs/vcs-mode';

export interface ReadModelView {
  workspaceId: string;
  captureId: string;
  channel: ReadModelChannel;
  status: 'pending' | 'live' | 'resnapshot-required';
  cursor: ReadModelCursor | null;
  items: ReadModelItem[];
}
export interface ReadModelSink {
  started(workspaceId: string, captureId: string): void;
  updated(view: ReadModelView): void;
}

export class NeutralReadModel {
  private captureId: string | null = null;
  private cursor: ReadModelCursor | null = null;
  private status: ReadModelView['status'] = 'pending';
  private readonly atomicIds = new Set<string>();
  private readonly rows = new DeltaReconciler<ReadModelItem>(
    (raw) => ReadModelItemSchema.parse(raw).value.id,
    (raw) => ReadModelItemSchema.parse(raw),
  );

  constructor(
    private readonly workspaceId: string,
    private readonly channel: ReadModelChannel,
    private readonly lifetime: NeutralServiceLifetime,
    private readonly sink: ReadModelSink,
  ) {}

  /** The owner supplies a fresh opaque ID on reconnect/root/account replacement. */
  capture(captureId: string): {
    push(frame: unknown): 'applied' | 'ignored' | 'resnapshot';
    confirmed(): void;
    failed(): void;
    cursor: ReadModelCursor | null;
  } {
    if (!captureId || captureId === this.captureId)
      throw new Error('A fresh capture identity is required');
    this.captureId = captureId;
    this.status = 'pending';
    this.sink.started(this.workspaceId, captureId);
    this.emit();
    return {
      cursor: this.cursor && { ...this.cursor },
      push: (frame) => this.push(captureId, frame),
      confirmed: () => {
        if (
          captureId === this.captureId &&
          this.status === 'pending' &&
          this.cursor &&
          this.lifetime.isCurrent() &&
          supportsNeutralCapability(
            this.lifetime.capabilities(),
            this.channel === 'vcs' ? 'vcs' : 'workEvidence',
          ) &&
          (this.atomicIds.size === 0 ||
            supportsNeutralCapability(this.lifetime.capabilities(), 'atomic'))
        ) {
          this.status = 'live';
          this.emit();
        }
      },
      failed: () => {
        if (captureId === this.captureId) this.resnapshot();
      },
    };
  }

  private push(captureId: string, input: unknown): 'applied' | 'ignored' | 'resnapshot' {
    const capabilities = this.lifetime.capabilities();
    if (
      captureId !== this.captureId ||
      !this.lifetime.isCurrent() ||
      !supportsNeutralCapability(capabilities, this.channel === 'vcs' ? 'vcs' : 'workEvidence')
    )
      return 'ignored';
    if (this.status === 'resnapshot-required') return 'resnapshot';
    if (this.atomicIds.size > 0 && !supportsNeutralCapability(capabilities, 'atomic'))
      return this.resnapshot();
    const parsed = ReadModelFrameSchema.safeParse(input);
    if (!parsed.success) return this.resnapshot();
    const frame: ReadModelFrame = parsed.data;
    if (frame.workspaceId !== this.workspaceId || frame.channel !== this.channel)
      return this.resnapshot();
    const items = frame.type === 'snapshot' ? frame.items : frame.upserts;
    if (
      items.some(
        (item) =>
          !readModelItemInScope(item, this.workspaceId, this.channel) ||
          (readModelItemRequiresAtomic(item) && !supportsNeutralCapability(capabilities, 'atomic')),
      )
    )
      return this.resnapshot();
    const ids = items.map((item) => item.value.id);
    if (new Set(ids).size !== ids.length) return this.resnapshot();
    if (this.cursor && frame.sequence < this.cursor.sequence) return 'ignored';
    if (
      this.cursor &&
      frame.sequence === this.cursor.sequence &&
      frame.stateToken !== this.cursor.stateToken
    )
      return this.resnapshot();
    if (frame.type === 'snapshot') {
      this.rows.applySnapshot(frame.sequence, items);
    } else {
      if (this.cursor && frame.sequence <= this.cursor.sequence) return 'ignored';
      if (
        !this.cursor ||
        frame.previousSequence !== this.cursor.sequence ||
        frame.sequence !== frame.previousSequence + 1 ||
        new Set(frame.removedIds).size !== frame.removedIds.length ||
        frame.removedIds.some((id) => ids.includes(id)) ||
        !this.rows.applyDelta(frame.sequence, { updated: items, removedIds: frame.removedIds })
      )
        return this.resnapshot();
    }
    if (frame.type === 'snapshot') this.atomicIds.clear();
    for (const item of items) {
      if (readModelItemRequiresAtomic(item)) this.atomicIds.add(item.value.id);
      else this.atomicIds.delete(item.value.id);
    }
    if (frame.type === 'delta') for (const id of frame.removedIds) this.atomicIds.delete(id);
    this.cursor = { sequence: frame.sequence, stateToken: frame.stateToken };
    this.status = 'live';
    this.emit();
    return 'applied';
  }

  private resnapshot(): 'resnapshot' {
    this.status = 'resnapshot-required';
    this.emit();
    return 'resnapshot';
  }

  private emit(): void {
    if (this.captureId)
      this.sink.updated({
        workspaceId: this.workspaceId,
        channel: this.channel,
        captureId: this.captureId,
        status: this.status,
        cursor: this.cursor && { ...this.cursor },
        items: this.rows.values(),
      });
  }
}

/** Both paired channels must have caught up before a cross-channel mutation can start. */
export function readModelMutationFence(vcs: ReadModelView, work: ReadModelView): string | null {
  return vcs.workspaceId === work.workspaceId &&
    vcs.channel === 'vcs' &&
    work.channel === 'work' &&
    vcs.status === 'live' &&
    work.status === 'live' &&
    vcs.cursor !== null &&
    work.cursor !== null &&
    vcs.cursor.sequence === work.cursor.sequence &&
    vcs.cursor.stateToken === work.cursor.stateToken
    ? vcs.cursor.stateToken
    : null;
}
