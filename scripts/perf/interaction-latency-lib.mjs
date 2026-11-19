/** All interaction gates from the Atomic substrate plan §5.11, plus A38. */
export const INTERACTION_BUDGETS = Object.freeze({
  'agent-write-row': { ms: 100, source: 'runtime-to-paint' },
  'agent-write-hunk': { ms: 150, source: 'runtime-to-paint' },
  'change-diff-warm': { ms: 100, source: 'cdp-paint' },
  'change-diff-cold': { ms: 300, source: 'cdp-paint' },
  'selection-frame': { frames: 1, source: 'cdp-paint' },
  'criterion-frame': { frames: 1, source: 'cdp-paint' },
  'tab-frame': { frames: 1, source: 'cdp-paint' },
  'selection-ack': { ms: 100, source: 'request' },
  'agent-tool-overhead': { ms: 2, source: 'runtime-span' },
  'turn-start-overhead': { ms: 5, source: 'runtime-span' },
  'turn-recording': { ms: 50, source: 'runtime-to-paint' },
  'turn-recorded': { ms: 1000, source: 'runtime-to-paint' },
  'capture-next-prompt': { ms: 50, source: 'runtime-span' },
  'child-ready': { ms: 1000, source: 'runtime-span' },
  'review-open': { ms: 200, source: 'cdp-paint' },
  'confirm-card': { ms: 50, source: 'cdp-paint' },
  'adoption-50-files': { ms: 1000, source: 'runtime-span' },
  'rewind-50-files': { ms: 1000, source: 'runtime-span' },
  'line-explanation': { ms: 150, source: 'cdp-paint' },
  'code-search': { ms: 100, source: 'cdp-paint' },
  'workspace-changes': { ms: 100, source: 'cdp-paint' },
  'reader-not-blocked': { source: 'concurrency-invariant' },
  'electron-main-hop': { ms: 5, source: 'ipc-overhead' },
});

const MINIMUM_SAMPLES = 20;

/** Nearest-rank p95; no interpolation or rounding can conceal a regression. */
export function p95(values) {
  if (!values.length || values.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error('latency samples must be finite non-negative numbers');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

/** Missing evidence is a failed qualification, never a zero-duration success. */
export function evaluateLatencyReport(report) {
  const errors = [];
  if (report?.version !== 1) errors.push('unsupported latency report version');
  const reference = report?.reference;
  if (typeof reference?.machine !== 'string' || !reference.machine.trim())
    errors.push('a named reference machine is required');
  if (!Number.isSafeInteger(reference?.repositoryFiles) || reference.repositoryFiles < 20_000)
    errors.push('the reference repository must have at least 20,000 tracked files');
  if (reference?.mockAgent !== true || reference?.sandboxMode !== 'stack')
    errors.push('an observed MOCK_AGENT stack sandbox is required');
  if (!['git', 'atomic'].includes(reference?.engine)) errors.push('the engine must be named');
  if (reference?.copyOnWrite !== true)
    errors.push('the child-ready gate requires a qualified copy-on-write filesystem');
  const frameBudgetMs = reference?.frameBudgetMs;
  if (!Number.isFinite(frameBudgetMs) || frameBudgetMs <= 0 || frameBudgetMs > 1000)
    errors.push('the named reference display must supply its frame budget in milliseconds');
  if (report?.dropped !== 0)
    errors.push('dropped or unaccounted-for samples invalidate qualification');
  const samples = report?.samples;
  if (!Array.isArray(samples)) errors.push('samples must be an array');
  const groups = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const budget =
      typeof sample?.metric === 'string' && Object.hasOwn(INTERACTION_BUDGETS, sample.metric)
        ? INTERACTION_BUDGETS[sample.metric]
        : undefined;
    if (!budget) {
      errors.push('unknown budget metric');
      continue;
    }
    if (
      sample.source !== budget.source ||
      sample.outcome !== 'success' ||
      typeof sample.traceId !== 'string' ||
      ![44, 81].includes(sample.traceId.length) ||
      !/^latency-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.test(
        sample.traceId,
      )
    ) {
      errors.push(`${sample.metric}: failed or incompatible evidence`);
      continue;
    }
    if (
      budget.source === 'concurrency-invariant'
        ? sample.blockedByWriter !== false
        : !Number.isFinite(sample.durationMs) || sample.durationMs < 0
    ) {
      errors.push(`${sample.metric}: invalid or failing measurement`);
      continue;
    }
    const rows = groups.get(sample.metric) ?? [];
    // Replaying the same span must not manufacture a statistically sufficient sample.
    if (rows.some((row) => row.traceId === sample.traceId)) {
      errors.push(`${sample.metric}: duplicate trace`);
      continue;
    }
    rows.push(sample);
    groups.set(sample.metric, rows);
  }
  const metrics = Object.entries(INTERACTION_BUDGETS).map(([metric, budget]) => {
    const budgetMs = budget.frames ? frameBudgetMs : budget.ms;
    const rows = groups.get(metric) ?? [];
    if (rows.length < MINIMUM_SAMPLES) {
      errors.push(`${metric}: ${rows.length}/${MINIMUM_SAMPLES} required samples`);
      return { metric, status: 'incomplete', samples: rows.length, budgetMs: budgetMs ?? null };
    }
    if (budget.source === 'concurrency-invariant')
      return { metric, status: 'pass', samples: rows.length, p95Ms: null, budgetMs: null };
    const observed = p95(rows.map((row) => row.durationMs));
    const status = observed <= budgetMs ? 'pass' : 'fail';
    if (status === 'fail') errors.push(`${metric}: p95 ${observed} ms exceeds ${budgetMs} ms`);
    return { metric, status, samples: rows.length, p95Ms: observed, budgetMs };
  });
  return { qualified: errors.length === 0, errors, metrics };
}

function markDetail(event) {
  const value = event.args?.data?.detail ?? event.args?.detail;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return undefined;
  }
}

/**
 * DOM-ready marks are not paint samples. Require a real main-thread Paint after
 * readiness and before the next interaction. rAF callbacks alone are insufficient.
 */
export function analyzeInteractionPaints(events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const pending = new Map();
  const samples = [];
  let unmatched = 0;
  for (const event of sorted) {
    const thread = `${event.pid}:${event.tid}`;
    if (event.name === 'intent.latency.interaction-start') {
      if (pending.delete(thread)) unmatched += 1;
      const detail = markDetail(event);
      if (
        detail?.traceId &&
        Object.hasOwn(INTERACTION_BUDGETS, detail.metric) &&
        INTERACTION_BUDGETS[detail.metric].source === 'cdp-paint'
      )
        pending.set(thread, { detail, start: event.ts, ready: false });
      continue;
    }
    const span = pending.get(thread);
    if (!span) continue;
    if (
      event.name === 'intent.latency.interaction-ready' &&
      markDetail(event)?.traceId === span.detail.traceId
    ) {
      span.ready = true;
    } else if (
      span.ready &&
      event.name === 'Paint' &&
      event.ph === 'X' &&
      event.cat?.split(',').includes('devtools.timeline')
    ) {
      samples.push({
        traceId: span.detail.traceId,
        metric: span.detail.metric,
        source: 'cdp-paint',
        durationMs: (event.ts + (event.dur ?? 0) - span.start) / 1000,
        outcome: 'success',
      });
      pending.delete(thread);
    }
  }
  return { samples, unmatched: unmatched + pending.size };
}
