# Atomic frontend reconciliation checkpoint

Source preparation is on local branch integrate/atomic-t1, based on main
f4a8646408491d6ecb13384c0da0ad83474f3d38 (version 2.355.0). This is a prepared
component stack, not a release or a claim that its corresponding daemon capabilities
are available. Ordinary Atomic source authority remains disabled.

## Preserved source and integration

The source checkpoint at the monorepo's
.reconciliation/checkpoints/20261119T035821Z preserves the original aggregate frontend
and fe-w38 worker, with source payloads, exact metadata and repository history. Its
manifest and RESTORE.md describe recovery without changing the original trees. The
worker's alternate paint/latency implementation remains preserved for semantic/test
comparison; it was not overlaid as a second instrumentation stack.

All 52 modified tracked files and 82 untracked files from the original aggregate
frontend were ported onto current main. Modified files were merged against the old
feature base 050e969d9a0b2f6e6fba405b4b9596916cc53110. The shared-types import conflict
retains both main's WorkspaceHome and the added TaskWorkDefinition. Each locale adds
the 130 feature keys to main's current key set; none collides with an independently
changed main key.

Main's workspace-home support, push client, machine-frame routing, Browser access
removal, package metadata and renderer/main/preload check structure are retained.
Dependencies were installed from main's frozen lockfile; the lockfile is unchanged.

Integration cleanup keeps private schemas/draft types private and labels three
intentional saga test seams with the repository's existing internal annotation.
The dead-code baseline only shrinks: DeltaReconciler, DeltaPayload and normalizeNote
now have production callers. No implementation behavior was removed to satisfy the
dead-code gate.

The event-recovery fixture and lock were re-exported from merged monorepo main
ae48c76413d68e8c63a3e517e2be23b50453dd1c, replacing the unmerged feature-commit
provenance. The backend mirror must use the same source commit before both consumers
claim same-source conformance.

## Review groups and capability boundaries

| Group                 | Scope                                                          | Required daemon support                                                            |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Neutral contracts     | DTOs, captured transport/read models and Redux ownership       | Matching read-model/event-fence contracts; absent capabilities remain unavailable. |
| Task planning         | Review, confirmation and exact-source first-run admission      | taskPlanning: 1; configureWorkDefinition and exact expectedTaskRevision semantics. |
| Original-run evidence | Bounded confirmed-run list and original first-admission detail | taskEvidenceRead: 1 and task.workEvidence.                                         |
| Confirmation          | Confirmation card DTOs, saga and preview                       | Production confirmationCard/decide ports are still absent; this is dormant.        |
| Experimental memory   | Explicit read-only Context panel and captured transport        | Explicit experimentalMemoryRead: 1; no default learning/mutation activation.       |
| Latency diagnostics   | Request timing and measurement tooling                         | Diagnostics only; real Electron measurements remain required.                      |
| Host packaging        | Optional payload validation/staging/signing                    | Matching daemon host artifact/manifest contract; no activation claim.              |

Shared AppClient/live-client, IPC, reducer/saga and locale hubs require one integration
owner. These groups are extraction boundaries for review, not separate whole-file
cherry-picks. Daemon contract changes must merge before a consuming frontend PR; normal
component pin automation follows. Companion assistant-guide sections must describe only
the capabilities actually ready to ship.

## Verification

- Frozen-lockfile installation completed without dependency or lockfile edits.
- The prescribed changed-tests planner selects a full Vitest fallback because the
  formatter ignore file changes, plus 27 component-test files and the relevant static
  gates. Its plan is retained in /tmp/atomic-fe-verify-plan.log.
- Svelte check completed across 9,782 files with zero errors and 268 warnings.
  Renderer TypeScript completed without errors.
- The dead-code gate passes after the private-export cleanup and shrink-only pruning.
  Format and focused ESLint checks pass; ESLint reports 19 warnings, zero errors.
- Main and preload TypeScript also completed without errors. The new main-process
  test-type gate passes with no additional baseline debt after fixing one mock channel
  type comparison. Its 333 existing errors in 51 files remain historical debt.
- Architecture scans pass through the restricted-import gate; the prescribed wrapper
  stops when tsx tries to create its denied Unix pipe. Direct remaining source scans
  pass. An additional workflow check outside the selected changed-tests scope
  reports SC2329 in unchanged main workflow
  .github/workflows/b76t-packaged-admission.yml; no workflow source was modified.
- The full selected Vitest attempt was terminated with exit 130 before completion
  after more than 22 minutes. It had reported six failures: two integration seams
  subsequently fixed and four environment failures in unchanged script tests. No
  total passing-test count or full-suite success is claimed.
- The two integration fixes are the additive capability snapshot and the captured
  neutral IPC audit. The latter now recognizes three real live-only channels and
  verifies their actual call sites; private JSON-RPC helpers use requestCaptured
  rather than being confused with Electron invoke channels. No frozen audit-debt
  list was expanded.
- Targeted current-source cohorts pass 105 tests in two lifecycle suites and 53 in
  the neutral lifecycle/IPC audit suites. These cohorts overlap in the same 19
  neutral lifecycle tests; their counts must not be added.
- The four environment failures were one denied ps/RSS observation and three
  child-CLI stderr assertions polluted by the injected UNDICI warning. Those three
  stderr probes pass with NODE_NO_WARNINGS=1 (three passed, 55 unselected), without
  changing their source. This diagnostic does not make the raw full attempt green.
- Focused peer review found no blocking regression in home/push/machine-frame
  routing, captured-session retirement, capability gating or Browser removal. Actual
  Electron/WSS execution and matching daemon support remain unqualified.
- The tsx command wrapper cannot create its internal Unix pipe in this execution
  profile. Direct no-listener code generation works; this does not qualify component
  tests or Electron behavior, which require actual listener/process access.

The [durable validation record](atomic-reconciliation-validation-2026-11-18.json)
retains exact commands, results, log bytes/hashes and final source hashes. The prepared
stack is a local review draft; full permitted-profile verification and the 27 selected
component-test files remain open. Continue in an execution profile that permits the
normal tooling and listeners:

```sh
pnpm run verify:changed --resume --base origin/main
```

No source was pushed or merged, no app release was installed, and Atomic source
authority was not activated by this preparation.
