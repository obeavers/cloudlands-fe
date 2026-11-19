# Neutral repository and work clients

This is an experimental internal foundation. The global `LiveAppClient.vcs` and
`.work` fields remain absent by default. `captureNeutralWorkspace(workspaceId)`
can supply scoped read-model clients only for exact acknowledged `vcs: 1` or
`workEvidence: 1` with `eventStreamRecovery: 1`; the daemon advertises none by
default. These modules add no user controls or advertised capability.
The legacy Git clients keep their current behavior. A known Atomic root without
its required capabilities is unavailable; it never falls back to a Git client.

`src/shared/types/{vcs,work,knowledge,work-read-model}.ts` mirror the implemented
core DTOs. Strict decoders retain native identity tags, repository/root scope,
binding epochs, unknown conflict counts, partial query coverage and optional
read-basis envelopes. Unknown engines, schema versions and unsafe JSON integers
are refused. Native hashes are never assigned to Git commit fields.

`VcsClient` and `WorkClient` require injected authorized service ports. These
ports are internal adapters, not new RPC registrations. They capture the original
transport/account context through `isCurrent`; an operation checks that context
before its request and after its reply. The scoped factory installs only the published read-model RPC ports; status,
history, diff, candidate, offer, context and decision ports stay unavailable until
their authorized facades and contracts exist. The opt-in
`neutral-read-model-rpc.ts` adapter implements the experimental subscription contract
from `docs/protocol/methods/work-evidence.md` against a supplied captured transport;
it performs no ambient backend lookup. It requires acknowledged
`eventStreamRecovery: 1`, a `lossRecovery: 1` lease ack, and an ordered
`fenceEvents` hook whose physical bulk-lane acknowledgment becomes visible only
after earlier notification callbacks across the captured transport. An ordinary
IPC request promise cannot substitute for this hook; missing support refuses the
path. Matching `events.lost` invalidates the view even without a subsequent domain
event, then resumes the accepted durable cursor. Loss generations use exact u64
arithmetic, scoped early markers are bounded at 64 IDs, and capture failures get
two automatic retries at 1 and 4 seconds before suspension. The canonical recovery
corpus is retained byte-for-byte under the live-client test fixtures with its
source commit and SHA-256. Read raw acknowledged
capability values: normalizing an unknown version to absence would incorrectly
select a legacy path.

The projection controller validates an entire snapshot or delta before applying
it with the existing `DeltaReconciler`. A malformed row, scope mismatch, duplicate
identity or sequence gap preserves the last accepted rows and requires recovery.
Loss recovery within a captured session retains the durable cursor for resume.
A replacement physical or account context clears protected rows and takes a fresh snapshot. Retired callbacks and
late subscribe acknowledgments cannot replace the current capture. Subscription
ports must install workspace event delivery before requesting the initial frames
and buffer pushes while those frames are pending. The RPC adapter filters
subscription IDs and caps that buffer at 512 frames and 4 MiB; overflow refuses
the capture instead of silently dropping deltas. Durable read-model sequence
numbers are separate from transient event sequence numbers.

The real transports capture one acknowledged ordinary connection, principal and
workspace. Main also pins the strict window/document backend stamp and pooled
client object, so an A → B → A settings switch cannot revive the original route.
No captured request uses ambient backend lookup, redials or renegotiates hello.
A scoped `workspace:updated` / `workspace:deleted` control lease requires loss
recovery; either event or control loss conservatively retires the capture. Each
request still relies on backend membership enforcement. Connection, hello,
document and principal replacement also retire it. Disposal joins outstanding
requests and original event-lease cleanup before releasing the main producer.
No method arguments, results or credentials are logged.

Electron uses `backend:neutral-workspace:ingress` for sequenced notifications,
barrier markers and retirement. A fence invoke reply includes its marker sequence;
the renderer resolves it only after that ingress queue has processed every earlier
callback. The queue refuses gaps at the five-second fence deadline or overflow
(512 entries / 4 MiB). Browser WebSocket message callbacks run synchronously before
the following fence reply continuation. The control admission buffer is bounded
at 128 entries / 4 MiB. Neither path substitutes an ordinary IPC promise for the
physical event fence.

The renderer saga forwards validated views into workspace-scoped `vcs` and `work`
Collections. Without admitted ports it dispatches no projection views. It clears
protected rows on capture retirement, then acquires a fresh context; unsupported
captures wait for the next acknowledged connection or workspace mount. A new
capture marks its retained rows pending; neither pending nor gap state can supply
a mutation fence. The paired channels must be live at the same workspace sequence
and opaque state token before a decision starts. Confirmation also requires the
exact offer digest. The authorized backend remains responsible for the state-token
compare-and-swap and human authority; the frontend creates no authority and makes
no optimistic mutation. Task-transition summaries retain `confirmed` versus
`completed-without-confirmation` as distinct backend receipts; task completion
never manufactures an accepted confirmation.

Recorded-source metadata stays on the context result envelope. The existing
`context-api.ts` symbol helper still maps a legacy search response to `SymbolInfo[]`;
a future basis-aware consumer must migrate that envelope explicitly rather than
copying query metadata onto individual symbols. No knowledge engine is activated
by these TypeScript definitions.

The experimental task-confirmation source surface uses the canonical
`WorkConfirmationCard`, including its exact retained `TaskRevision`, backend-joined
check pin/detail pairs and rootless ledger read basis. It does not recompute Rust
serde-byte evidence digests. Missing result, narrative, reviewer or triage records
remain unavailable. The read model exposes a note entry only for one offer matching
the server-derived `basis.completionNoteRev` for that note's current revision;
the original task revision, prose and evidence stay immutable through lifecycle-only
status and assignment changes. Multiple offers require a future explicit selection
owner. Opening the card captures that offer and never silently rebinds its task.

The card requires an actual authorized `confirmationCard` and `decide` service port
plus exact capabilities. The current captured transport factory supplies neither,
so these controls are unavailable. It adds no method names or advertised feature.
Decision ownership lives in the `taskConfirmation` Redux slice and saga. A changed
workspace state token or live completion revision after offer capture requires explicit refresh; request-changes
and rejection require a reason. Submitting keeps the original offer digest,
operation ID and paired read-model fence. Unknown mutation settlement is retained
as uncertain and is never retried automatically. Closing, owner replacement and
retirement fence late callbacks; the transport owner joins original cleanup.

The receipt UI distinguishes confirmation from an actual task transition, and
requests neither source adoption nor publication. Direct human completion remains
disabled in this card until its exact captured-task API and replay receipt exist;
it never calls the legacy note-status action. The named `task-confirmation` preview
contains synthetic state examples only and installs no global client or transport.
