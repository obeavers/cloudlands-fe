# Interaction latency measurements

Internal measurement tooling for the Atomic substrate adoption plan, section 5.11.
Instrumentation is disabled until an operator starts a capture. This does not enable
Atomic workspaces or change application behavior.

`window.__INTENT_LATENCY__` becomes available after the first live transport request.
`start()` resets and starts a capture, `snapshot()` returns a copy, and `stop()` ends it.
The recorder retains at most 4,096 samples and 128 unfinished interactions; overflow is
reported and invalidates qualification. Invalid or mismatched timing metadata also
counts as dropped evidence. It stores opaque trace identifiers, method
names, outcomes and durations. It never stores method arguments, results or error text,
and sends no telemetry to an external service. Restarting a capture fences late replies
from the previous capture.

Ordinary requests retain their existing numeric JSON-RPC identifiers. During a capture,
the renderer generates a UUID trace identifier and uses it as the JSON-RPC string `id`.
An owning interaction can pass its root through `BackendRequestOptions.interactionTraceId`;
each request then appends a unique span UUID to that root in its string `id`, allowing
concurrent requests without collisions. Background requests are not implicitly attached
to whichever interaction happened most recently. Existing UI paths need to forward this
context explicitly when they adopt the interaction hooks.
The daemon already accepts and echoes string identifiers. No method parameters or daemon
response fields change. Main-process timings are additional IPC wrapper metadata only.
Specialized routes and cached hello reads report no fabricated RPC duration.

The renderer measures request duration with its monotonic clock. Main measures its own
handler and JSON-RPC durations. The two IPC hops, including cloning/renderer overhead,
are estimated by subtracting **durations**, never timestamps from different processes.
Invalid or mismatched timings are excluded. This aggregate does not identify which hop
is slow. The main-hop gate uses the small `host.status` request, and needs Electron;
browser-only measurements cannot qualify that gate.

## Collect a baseline

Start a disposable stack with `MOCK_AGENT=1 make dev-sandbox-stack` using the normal
workspace service workflow. Reuse its running state and URL; the harness starts no
servers and does not stop another owner's stack. Then, from `packages/cloudlands-fe`:

```sh
pnpm perf:interaction-latency \
  --url http://daemon.localhost:<DEV_PORT>/workspace/<WORKSPACE_ID> \
  --repository /absolute/path/to/reference-repository \
  --reference-machine reference-machine-name \
  --out .demo-artifacts/perf/interaction-baseline-1 \
  --baseline
```

The default scenario repeats `host.status` twenty times. It records request timings and
existing IPC timings where present. `--cdp <endpoint>` attaches to an existing Electron
renderer on the selected origin to measure the IPC path; otherwise it launches its own
Chromium browser. The selected sandbox must be healthy and its recorded `mockAgent`
value must be true. The reference repository's tracked file count and revision are
read from Git, and a forced-reflink probe is created and removed inside that repository.
The probe establishes filesystem support, not child-creation latency.

`report.json` contains observations, reference facts and a qualification result.
`trace.json` contains the CDP rendering trace. Output directories must be new. Baseline
mode allows a partial measurement run to exit successfully but always reports the
separate qualification result. It is not evidence that a latency gate passed.

## Measure an interaction

Pass `--scenario /path/to/scenario.json`. Its `steps` array supports:

```json
{
  "steps": [
    {
      "kind": "interaction",
      "metric": "workspace-changes",
      "trigger": "<selector for the workspace control>",
      "ready": "<selector for the populated changes panel>",
      "readyState": "visible"
    }
  ]
}
```

CSS selectors and starting state belong to the scenario for its disposable workspace.
Each repeat must leave the next repeat's starting state ready, for example by including
both sides of a toggle. A request step accepts `kind: "request"`, `method` and optional
`params`. Request duration can only count toward a request budget; it cannot substitute
for paint latency or runtime overhead. Arguments are not written into the report.

The driver marks interaction start at the control's actual pointer/click dispatch,
excluding driver and actionability waits. A browser mutation observer marks the
specified DOM transition before rendering, without waiting for a driver roundtrip.
A ready predicate that already matches is refused. The analyzer requires an actual main-thread CDP `Paint`
event after that mark and before the next interaction. It measures through completion
of that browser paint event; this is not display scanout timing. Two animation frames
keep tracing alive but are never treated as paint evidence. Missing paints stay missing.
Production integrations may use `beginInteraction(metric)` and `interactionReady(id)`
for the same marks after the owning UI state commits.

## Qualification

Omit `--baseline` to require qualification, or check retained observations:

```sh
pnpm perf:interaction-latency --check .demo-artifacts/perf/interaction-baseline-1/report.json
```

The checker includes every plan budget plus the Electron main-hop budget. It requires
twenty distinct successful observations per metric, a named machine, at least 20,000
tracked files, an observed mock-agent stack and copy-on-write support. It uses
nearest-rank p95 without rounding. Missing, failed, duplicated, nonfinite, overflowed,
or incorrectly sourced observations fail qualification. Reader independence is a
concurrency invariant, not a made-up zero-millisecond sample.
The one-frame gates require `--frame-budget-ms` from the named reference display's
refresh configuration (for example, 1000/60 milliseconds on a 60 Hz display). A slow
test run is never used to infer a larger frame allowance. Baseline collection can omit
this value, which leaves qualification incomplete.

The current collector measures requests, IPC and explicitly scripted paints. Runtime
write-to-paint signals, overhead, recording, child provisioning and the reader/writer invariant still need
their owning backend measurement spans and scenarios. No nightly reference-machine
run has been qualified. Full V39 remains incomplete until every required metric has
real observations; the checker cannot turn this partial baseline into a passing gate.

There is no assistant-app-guide change: these are internal diagnostics with no new
user-facing controls or released feature behavior.
