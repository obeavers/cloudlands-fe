import { requestTraceId, type MainRequestTiming } from '$shared/request-latency';

const SAMPLE_CAPACITY = 4096;
const INTERACTION_CAPACITY = 128;

type LatencyPhase = 'request' | 'main' | 'ipc-overhead' | 'rpc' | 'interaction-ready';
interface LatencySample {
  traceId: string;
  interactionTraceId?: string;
  phase: LatencyPhase;
  durationMs: number;
  outcome: 'success' | 'error';
  /** Method name only; arguments, results, error text and identifiers are never retained. */
  method?: string;
  metric?: string;
}

interface LatencySnapshot {
  version: 1;
  active: boolean;
  dropped: number;
  samples: LatencySample[];
}

interface LatencyProbe {
  start(): void;
  stop(): LatencySnapshot;
  clear(): void;
  snapshot(): LatencySnapshot;
  beginInteraction(metric: string): string | undefined;
  /** Call after the expected DOM state is committed. The perf harness finds the actual Paint. */
  interactionReady(traceId: string): void;
}

declare global {
  interface Window {
    __INTENT_LATENCY__?: LatencyProbe;
  }
}

interface RequestSpan {
  traceId: string;
  finish(outcome: 'success' | 'error', timing?: MainRequestTiming): void;
}

function traceId(): string | undefined {
  try {
    return requestTraceId(`latency-${crypto.randomUUID()}`);
  } catch {
    return undefined;
  }
}

/** Fixed names keep the browser User Timing buffer bounded, too. CDP still sees each mark. */
function mark(name: string, detail: Record<string, string>): void {
  try {
    performance.clearMarks(name);
    performance.mark(name, { detail });
  } catch {
    // Diagnostics must never affect a request or render on an older browser.
  }
}

class LatencyRecorder implements LatencyProbe {
  private active = false;
  private generation = 0;
  private samples: LatencySample[] = [];
  private cursor = 0;
  private dropped = 0;
  private interactions = new Map<string, { metric: string; start: number }>();

  start(): void {
    this.clear();
    this.active = true;
  }

  stop(): LatencySnapshot {
    this.active = false;
    this.generation += 1;
    this.interactions.clear();
    return this.snapshot();
  }

  clear(): void {
    this.generation += 1;
    this.samples = [];
    this.cursor = 0;
    this.dropped = 0;
    this.interactions.clear();
  }

  snapshot(): LatencySnapshot {
    return {
      version: 1,
      active: this.active,
      dropped: this.dropped,
      samples: [...this.samples.slice(this.cursor), ...this.samples.slice(0, this.cursor)].map(
        (sample) => ({ ...sample }),
      ),
    };
  }

  private append(sample: LatencySample): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) {
      this.dropped += 1;
      return;
    }
    if (this.samples.length < SAMPLE_CAPACITY) {
      this.samples.push(sample);
    } else {
      this.samples[this.cursor] = sample;
      this.cursor = (this.cursor + 1) % SAMPLE_CAPACITY;
      this.dropped += 1;
    }
  }

  request(method: string, interactionTraceId?: string): RequestSpan | undefined {
    if (!this.active) return undefined;
    const span = traceId();
    if (!span) {
      this.dropped += 1;
      return undefined;
    }
    const parent =
      interactionTraceId && this.interactions.has(interactionTraceId)
        ? interactionTraceId
        : undefined;
    // Each request retains its interaction root without reusing a pending JSON-RPC id.
    const id = parent ? `${parent}.${span.slice('latency-'.length)}` : span;
    const generation = this.generation;
    const start = performance.now();
    const methodKey = /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(method) ? method : 'invalid-method';
    mark('intent.latency.request-start', { traceId: id, method: methodKey });
    let finished = false;
    return {
      traceId: id,
      finish: (outcome, timing) => {
        if (finished || !this.active || generation !== this.generation) return;
        finished = true;
        const durationMs = performance.now() - start;
        const base = {
          traceId: id,
          ...(parent ? { interactionTraceId: parent } : {}),
          method: methodKey,
          outcome,
        };
        mark('intent.latency.request-complete', { traceId: id, method: methodKey, outcome });
        this.append({ ...base, phase: 'request', durationMs });
        if (
          timing?.traceId === id &&
          Number.isFinite(timing.mainDurationMs) &&
          timing.mainDurationMs >= 0 &&
          timing.mainDurationMs <= durationMs
        ) {
          this.append({ ...base, phase: 'main', durationMs: timing.mainDurationMs });
          this.append({
            ...base,
            phase: 'ipc-overhead',
            durationMs: durationMs - timing.mainDurationMs,
          });
          if (timing.rpcDurationMs !== undefined) {
            if (timing.rpcDurationMs <= timing.mainDurationMs)
              this.append({ ...base, phase: 'rpc', durationMs: timing.rpcDurationMs });
            else this.dropped += 1;
          }
        } else if (timing !== undefined) {
          this.dropped += 1;
        }
      },
    };
  }

  beginInteraction(metric: string): string | undefined {
    // Machine-readable metric keys only; never store a UI label or task text.
    if (!this.active || !/^[a-z][a-z0-9-]{0,63}$/.test(metric)) return undefined;
    const id = traceId();
    if (!id) return undefined;
    if (this.interactions.size >= INTERACTION_CAPACITY) {
      this.dropped += 1;
      return undefined;
    }
    this.interactions.set(id, { metric, start: performance.now() });
    mark('intent.latency.interaction-start', { traceId: id, metric });
    return id;
  }

  interactionReady(id: string): void {
    const pending = this.interactions.get(id);
    if (!this.active || !pending) return;
    this.interactions.delete(id);
    mark('intent.latency.interaction-ready', { traceId: id, metric: pending.metric });
    this.append({
      traceId: id,
      metric: pending.metric,
      phase: 'interaction-ready',
      durationMs: performance.now() - pending.start,
      outcome: 'success',
    });
  }
}

let recorder: LatencyRecorder | undefined;

/** Installed lazily when a live transport is first used; collecting is always explicit. */
export function beginLatencyRequest(
  method: string,
  interactionTraceId?: string,
): RequestSpan | undefined {
  if (typeof window === 'undefined') return undefined;
  if (!recorder) {
    recorder = new LatencyRecorder();
    window.__INTENT_LATENCY__ = recorder;
  }
  return recorder.request(method, interactionTraceId);
}
