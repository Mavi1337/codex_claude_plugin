# Codex Worker Development — Sol Implementation Re-review

Date: 2026-08-18

Reviewer: GPT-5.6 Sol (`xhigh`)

Base: `db52e28`

Reviewed HEAD: `659163731dddf19ebf8ae84f752ca49c9e6ee3d7`

Binding specification: `docs/superpowers/specs/2026-08-18-codex-worker-development-design.md`

## Executive verdict

**Specification compliance: fail.** The remediation commit fixes a meaningful
set of defects, but the exact-review gate can still authorize an unreviewed
commit, real permission approvals do not use the app-server response schema,
coordinator ownership can be made unreachable by corrupt metadata, and several
binding durability, immutable-review, partitioning, recovery, repair, and
capability requirements remain absent.

**Code quality: changes required.** The implementation is materially stronger
and all checked-in tests pass, but the remaining trust-boundary race is a release
blocker. Several new mitigations are locally reasonable yet do not close the
end-to-end state machines they are meant to protect.

**Implementation readiness: not ready for integration or user-facing rollout.**
At minimum, CR-01, I-01, I-02, and I-03 below must be fixed and covered by
adversarial tests before the review gate can be treated as an integration
authority. The immutable-evidence and context-partition findings are also
binding specification failures, not optional hardening.

The green suite is useful evidence, but not evidence that the security and crash
recovery invariants hold: a disposable real-Git reproduction integrated two
commits even though the passing package contained only the first one.

## Disposition of the previous C-01 through C-06 findings

| Prior finding | Status at `6591637` | Re-review conclusion |
|---|---|---|
| C-01 stale scalar review gate | **Partially fixed; critical defect remains** | A later completed commit now clears an existing gate and `integration.apply` checks a structured binding. However, `review.start` freezes H1 and, at completion, binds the verdict to the worker's then-current H2. CR-01 reproduces integration of unreviewed H2. |
| C-02 task-review evidence absent | **Partially fixed** | Instructions, the first-message brief, validated Luna report/tests/concerns, assignment paths, and Git facts are now added. Binding plan/spec/global-constraint contents are not copied or hashed, and Sol still runs in the live worktree. See I-04. |
| C-03 review request times out and duplicates | **Partially fixed** | The CLI timeout is now 31 minutes, review ID/idempotency are claimed before inference, and status is observable. Multi-pass or repair reviews can still exceed the one-request timeout, and a coordinator crash leaves the durable review permanently `running`. See I-03. |
| C-04 split-brain coordinator/state writers | **Partially fixed** | Coordinator-owner and state-write directory locks prevent the simplest simultaneous-writer case. Ownership still trusts PID alone, is not bound to integration-worktree identity, and missing/corrupt metadata lets startup unlink a live owner's endpoint and replace its token. See I-02 and I-06. |
| C-05 unsafe blocking-request forwarding | **Partially fixed** | The full sanitized request payload, IDs, expiry, connection ownership, slot release/reacquisition, and limited response validation are now present. The validation is not method-specific and is wrong for real permission approvals and command `availableDecisions`. See I-01. |
| C-06 partial integration after multi-commit conflict | **Fixed for the reported branch-corruption defect** | One multi-commit `cherry-pick` is now aborted as a unit and verifies restoration of the exact expected HEAD. The binding repair-branch/replay/resume/full-re-review workflow remains unimplemented; see I-07. |

## Critical finding

### CR-01 / C-01 — An in-flight review of H1 is rebound to H2 and authorizes H2 without review

**Classification:** Specification, correctness, security, concurrency

**Confidence:** 1.0

`startReview` snapshots `reviewedWorker` and freezes the range ending at that
snapshot's `headCommit` (`plugins/codex/scripts/lib/worker-coordinator.mjs:365-405`).
It then awaits one or more Sol turns. Concurrent coordinator requests remain
enabled by the socket server (`plugins/codex/scripts/codex-worker-coordinator.mjs:33-62`),
so the same terminal Luna worker can receive a follow-up, complete it, and be
committed while the review is in flight. The new commit correctly clears the old
gate (`worker-coordinator.mjs:150-174`).

The race is reintroduced when the review finishes: the transaction reads the
**current** worker and writes its current `baseCommit`, `headCommit`, and `tree`
into `reviewBinding` (`worker-coordinator.mjs:470-480`) instead of using the
frozen `reviewedWorker` facts. `integration.apply` then compares that internally
consistent but false binding to the current worker and verifies only the package
file hash (`worker-coordinator.mjs:177-195`). It never verifies that the package's
resolved target equals the binding.

Fresh disposable reproduction:

1. Freeze and begin a passing task review for H1.
2. While the fake Sol turn is delayed, commit H2 through `integration.commit`.
3. Let the H1 review finish and call `integration.apply`.

Observed facts:

```json
{
  "packageReviewedHead": "24280c308504bde968b0021266c866b77343c03a",
  "laterHead": "d0c0673c340499f1ed132f97a05b9249687556dd",
  "boundHead": "d0c0673c340499f1ed132f97a05b9249687556dd",
  "packageContainsV2": false,
  "gate": "pass",
  "appliedCommits": [
    "24280c308504bde968b0021266c866b77343c03a",
    "d0c0673c340499f1ed132f97a05b9249687556dd"
  ]
}
```

**Impact:** The central success criterion—integrate only the exact commits
approved by Sol—is false. A normal fix turn during a slow review can cause
unreviewed code to enter the integration branch under a passing gate.

**Required change:** Build the binding solely from the frozen snapshot and
package target. At review completion, compare-and-swap the worker's persisted
base/head/tree against those facts. If any fact changed, persist the review as
stale and do not install a gate. At apply time independently compare the package
target/manifest facts to the binding. Add a deterministic in-flight-review versus
follow-up-commit race test matching the reproduction above.

## Important findings

### I-01 / C-05 — Blocking approval validation rejects valid protocol responses and accepts invalid ones

**Classification:** Specification, correctness, protocol compatibility

**Confidence:** 1.0

The coordinator now persists useful sanitized action data and validates some
responses, which is a real improvement. The validator nevertheless treats every
method in `APPROVAL_METHODS` as `{ decision: string }` and reads
`params.allowedDecisions` (`worker-coordinator.mjs:24-30,47-64`). The current
app-server protocol differs:

- command approval advertises `availableDecisions`, not `allowedDecisions`, and
  its decision can be `acceptForSession` or a structured amendment;
- file-change approval also permits `acceptForSession`;
- `item/permissions/requestApproval` responds with
  `{ permissions, scope, strictAutoReview? }`, not `decision`;
- MCP elicitation uses `{ action, content, _meta }` and accepted input content
  needs method-specific validation.

These shapes are defined in the current Codex checkout at
`/home/user01/Schreibtisch/agents/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:59-77,105-113,1495-1516,1537-1541`,
`.../permissions.rs:784-794`, and `.../mcp.rs:734-747`.

A fresh coordinator reproduction sent an actual permission response shape. The
runtime rejected it with `Approval decision must be one of: accept, decline,
cancel.`, then accepted and forwarded the invalid `{ "decision": "accept" }`
shape as `resolved`. The app-server deserializer converts the latter to an empty
permission grant, so the controller receives a false success while the worker
does not receive the requested authority.

**Impact:** The interactive Luna permission workflow does not work against the
real protocol, session-scoped and amendment decisions are lost, and a reported
successful resolution can be semantically rejected by app-server.

**Required change:** Validate each supported server-request method against its
actual generated request/response type, preserve structured decision values,
use `availableDecisions`, and validate accepted MCP content. Add fixture tests
for command, file, user-input, MCP, and permission responses, including every
advertised decision and connection loss before/after resolution.

### I-02 / C-04 — Corrupt or missing metadata disconnects a live coordinator, and PID reuse is still trusted

**Classification:** Specification, correctness, security, crash recovery

**Confidence:** 1.0

The new startup lock serializes competing CLI launch attempts, and the detached
coordinator obtains a persistent ownership lock before opening its endpoint.
Those changes prevent the previous straightforward two-writer race.

They do not make discovery authoritative. `loadCoordinatorSession` returns null
when metadata is missing or corrupt (`worker-coordinator-lifecycle.mjs:32-40`).
`ensureCoordinatorSession` then skips the live-PID refusal, unlinks the existing
socket, overwrites its token, and spawns another process
(`worker-coordinator-lifecycle.mjs:116-156`). The new child fails the owner lock,
but the original live coordinator has already lost its endpoint and capability
token. The coordinator executable itself also unconditionally unlinks its target
after acquiring ownership (`plugins/codex/scripts/codex-worker-coordinator.mjs:25-31`).

Fresh fault injection produced:

```json
{
  "secondError": "Worker coordinator failed to start...",
  "oldAlive": true,
  "endpointExists": false
}
```

Both startup and persistent owner records contain only a PID and timestamp
(`worker-coordinator-lifecycle.mjs:92-113`; `worker-state.mjs:85-117`). Metadata
records `executable` but never verifies it. This still violates the explicit
process-start-identity/executable requirement and can trust a reused PID.

**Impact:** A recoverable metadata write/corruption event turns a live owner into
an unreachable orphan and causes every CLI call to fail. PID reuse can also
prevent recovery or apply cleanup logic to the wrong process.

**Required change:** Make the owner lock/record—not the discovery JSON—the source
of truth; store and verify PID start identity plus executable; never unlink an
endpoint or replace a token until stale ownership is proven and the new owner has
successfully claimed authority. Publish discovery metadata only after the child
owns the lock and answers the authenticated readiness probe. Test corrupt/missing
metadata, PID reuse, child failure before readiness, and simultaneous processes.

### I-03 / C-03 — Review execution remains request-bound and a crash leaves the review permanently running

**Classification:** Specification, reliability, crash recovery, usability

**Confidence:** 1.0

Claiming the review and idempotency key before inference
(`worker-coordinator.mjs:104-127`) closes the original immediate duplicate-start
window. The CLI also raises its timeout from 10 seconds to 31 minutes
(`plugins/codex/scripts/codex-workers.mjs:120-126`).

However, one pass may wait 30 minutes and a schema repair may wait another 30
minutes (`worker-coordinator.mjs:486-513`). Multiple partitions run sequentially
and may add an xhigh synthesis (`worker-coordinator.mjs:409-447`). The single
31-minute IPC request therefore still times out during valid reviews while the
coordinator continues executing. More importantly, coordinator restart recovery
only reconciles workers and turn queues (`worker-coordinator.mjs:79-101`); it
does not reconcile `reviews[reviewId].status === "running"` or its running
idempotency entry.

A persisted-state restart reproduction returned the old `running` record forever
for the original key, while a new key failed with `Review review-stuck already
exists.` No operation can resume, fail, or replace that review.

**Impact:** A crash or long partitioned review strands the canonical review ID
and orchestration. Controller polling cannot distinguish genuine work from a
dead operation, and the documented retry/recovery path does not exist.

**Required change:** Make `review start` a durable accepted job that returns
promptly, or give it a renewable persisted execution lease/heartbeat independent
of the caller socket. On coordinator startup reconcile running reviews and their
Sol workers to completed, failed, or indeterminate states and provide an explicit
safe retry/resume operation. Test crash points before package creation, between
passes, during repair, and before gate installation.

### I-04 / C-02 / I-01 — Task reviews still lack binding source evidence and are not isolated from the live repository

**Classification:** Specification, review integrity

**Confidence:** 0.99

Task packaging now includes all stored instructions, the validated Luna report
with tests and concerns, and selected runtime/Git constraints
(`worker-coordinator.mjs:378-405`). This fixes most of the previous total evidence
omission.

The first raw Luna message is treated as the entire canonical brief
(`worker-coordinator.mjs:339-350`). The workflow tells the controller to reference
plan/spec paths, but the runtime neither resolves nor copies/hashes those files.
The evidence section contains no binding global constraints, requirement-source
contents, source hashes, or controller rulings. A reviewer therefore cannot
verify requirements from the immutable package unless the controller happened to
duplicate them into the prompt.

In addition, Sol starts with `cwd: reviewCwd`, the live Luna worktree
(`worker-coordinator.mjs:419-424,486-493`). Read-only prevents mutation, not live
inspection. There is no synthetic tree/worktree or sandbox rule that restricts
the reviewer to the package. Mutable and audit targets are assembled through
separate Git/filesystem reads rather than one atomic snapshot
(`plugins/codex/scripts/lib/review-package.mjs:18-88`). The manifest also lacks
several required skipped/generated/LFS/submodule/dependency categories.

**Impact:** A task review can return `pass` without seeing the binding
specification, and evidence consulted from the live worktree can differ from the
hashed package and later binding. The package hash is not a complete statement of
what Sol reviewed.

**Required change:** Require explicit requirement/global-constraint inputs for a
task review, copy their contents into the package, and hash them. Freeze mutable
targets as a synthetic Git tree or isolated snapshot, start Sol against that
snapshot, and prevent reads from the live repository. Record every included,
skipped, binary, generated, symlink, submodule/LFS, and dependency-discovered
path with reasons.

### I-05 / I-02 — Oversized reviews are byte chunks, not manifest-owned review passes

**Classification:** Specification, correctness, context management

**Confidence:** 1.0

The remediation correctly caps each generated chunk using the conservative
four-bytes-per-token estimate. It then partitions the complete Markdown package
one Unicode character at a time (`review-package.mjs:89-116`). This can split a
manifest entry, diff hunk, line, or source file at any byte threshold. Only the
first part normally contains `## Manifest`; later passes have no owned path set,
target metadata, or declaration of what they cover. There is no cross-cutting
interfaces/tests pass, and synthesis receives only model reports, so it cannot
independently prove every manifest entry was covered.

A two-file disposable package at `maxInputTokens=1000` produced eight passes.
Only pass 1 contained the manifest; passes 2, 3, and 5-8 named neither source
path. This behavior is not detected by the new partition test, which asserts
only size and package-hash presence.

The recorded budget also differs from the binding allocation: it reports 8K for
prompt/schema, 32K for output, and 8K combined tool/error
(`worker-coordinator.mjs:449-458`) instead of 22K fixed instructions/schema, 24K
tool expansion, 14K output, and 8K measurement/error. It omits requested versus
confirmed settings telemetry.

**Impact:** Individual reviewers cannot know the scope they own; material
interfaces or findings split across boundaries can be missed while synthesis
still claims complete coverage. The report's budget record does not prove the
approved 258K accounting.

**Required change:** Partition by manifest-owned paths and coherent file/diff
sections, include target metadata and owned paths in every pass, add a declared
cross-cutting pass, and make synthesis verify an explicit coverage map. Implement
the exact reserve accounting and settings telemetry. Test boundary splits,
renames/deletions/binary entries, cross-file findings, and missing-coverage
failure.

### I-06 / I-04 / I-05 — Durable state and scheduling still omit required leases, orchestration recovery, and bounds

**Classification:** Specification, persistence, concurrency, security

**Confidence:** 0.99

Atomic temp-write/fsync/rename, a backup, monotonically increasing revisions,
owner-only modes, a cross-process state-write lock, an owner lock, in-flight queue
records, and transport-exit marking are all substantive improvements
(`worker-state.mjs:46-65,85-176`; `worker-coordinator.mjs:603-769`).

The binding contract still is not implemented end to end:

- repository identity hashes only the common Git directory and omits explicit
  canonical integration-worktree identity (`worker-protocol.mjs:19-33`);
- there is one repository-level state file rather than per-orchestration
  `state.json`/`progress.md` task/final ledger structure;
- queue records have no priority, lease, heartbeat, queue position, or separate
  live-turn bound, and recovered queue entries are only moved aside as
  indeterminate, not reconciled/resumed;
- no schema migration, stale-temp reconciliation, bounded valid-backup policy,
  fallback warning, 30-day retention, or cleanup API exists;
- `lastOutput`, state/idempotency values, reports, and normal logs remain
  unbounded, while IPC responses can exceed the 1 MiB request-frame policy;
- runtime worker records still omit coordinator/app-server PID/endpoint and a
  durable controller task-state/fix-round/ruling ledger.

**Impact:** Cross-session recovery remains incomplete, separate integration
worktrees can share one authority, queues do not meet their concurrency contract,
and long-lived output/artifacts can grow without policy bounds.

**Required change:** Implement the specified integration-worktree identity,
versioned per-orchestration ledger/artifact layout, lease/heartbeat queue and live
turn bound, startup migration/temp/backup recovery, bounded output/events, and
retention/cleanup policy. Add real multi-process writer and crash-point tests.

### I-07 / C-06 — Conflict rollback is atomic, but the required repair and re-review workflow is absent

**Classification:** Specification, Git lifecycle, recovery

**Confidence:** 1.0

`applyReviewedCommits` now derives the ordered commits, rejects merge commits,
runs a single multi-commit cherry-pick, aborts on conflict, and verifies exact
HEAD restoration (`worker-worktree.mjs:124-150`). The focused and full test suite
both confirm that the integration branch remains unchanged after a conflict.

The coordinator only appends a generic conflict record
(`worker-coordinator.mjs:216-243`). It does not create a repair branch from the
new integration HEAD, replay the exact task patch, resume the owning Luna thread
with conflict details, verify the repair, or force review of the entire repaired
base-to-head delta as required by design lines 319-326.

**Impact:** The dangerous partial-branch state is fixed, but a normal integration
conflict still has no executable recovery path through the runtime/skill.

**Required change:** Implement the full repair state machine and preserve the
original branch/package/commit evidence. The repaired head must receive a fresh
full task review before another apply attempt.

### I-08 / I-07 / I-08 — Re-review, rulings, stable finding lifecycle, and capability probing remain mostly declarative

**Classification:** Specification, review workflow, compatibility

**Confidence:** 0.99

Sol output validation is stricter, runtime IDs replace model IDs, invalid raw
output is capped, one repair retry is attempted, and ephemeral Sol processes are
closed (`worker-review.mjs:7-40`; `worker-coordinator.mjs:486-519`). Those changes
fix important portions of the previous I-07 and M-03 findings.

There is still no scoped re-review operation/prompt carrying open findings and
the fix diff, no persisted finding dispositions, no runtime-enforced rounds 1-5,
and no persisted controller-ruling API. `pass-with-ruling` is an unused evaluator
branch and `integration.apply` accepts only literal `pass`
(`worker-review.mjs:43-46`; `worker-coordinator.mjs:177-182`). Stable IDs include
mutable title and location data instead of normalized rule plus evidence
fingerprint, so a reworded or relocated finding changes identity. The checked-in
schema is supplied to app-server, but runtime validation remains a separate
hand-written implementation.

Startup capability checks still verify only model name and effort
(`worker-coordinator.mjs:246-269`). They do not verify initialize/version,
thread resume, output schema, interrupt, server-request methods, role config
overrides, context policy, minimum/current fixtures, or both Sol efforts as one
compatibility record.

**Impact:** The documented fix loop cannot be executed with durable semantics,
waivers cannot be safely audited or applied, finding continuity is unreliable,
and a nominally available model can fail only after orchestration has started.

**Required change:** Add explicit re-review inputs and dispositions, durable
controller rulings and round state, schema-derived validation, and the binding
capability probe/compatibility record with minimum and current fixtures.

### I-09 / I-10 — The normative adversarial and end-to-end release gate is still missing

**Classification:** Specification, test adequacy

**Confidence:** 1.0

Coverage increased and now tests several previously missing fixes: simultaneous
same-process discovery, transport loss, request expiry, slot reacquisition,
in-flight review idempotency claim, commit authority, stale completed gates,
recursive audits, committed blobs, package size, conflict rollback, missing
worktree restoration, and non-Git SessionEnd.

The tests still do not cover the adversarial failures reproduced in this review:
review/commit concurrency, actual protocol response shapes, corrupt/missing
metadata with a live owner, PID reuse, or running-review crash reconciliation.
The new stale-binding test commits only after a manually installed completed
gate, so it cannot detect CR-01. The partition test checks size/hash only, so it
cannot detect missing manifest ownership. There is also no binding end-to-end
scenario with two Luna tasks, two Sol reviews, a finding/fix/scoped re-review,
and integration of approved commits only, nor conflict repair/re-review,
cross-session persistence, current/minimum protocol fixtures, or platform CI
coverage described by design lines 593-643.

**Impact:** The green test count gives false confidence around exactly the
concurrency and protocol boundaries that remain broken.

**Required change:** Implement the normative test matrix, starting with the four
deterministic reproductions identified above and the complete fake-runtime E2E
workflow.

## Minor findings

### M-01 — Machine-mode error and compactness guarantees remain incomplete

`codex-workers.mjs:129-137` maps usage, compatibility, and unauthorized errors,
but does not emit exit 4 for conflict/stale state or exit 5 for unavailable
runtime as required. The IPC client does not verify response version/request ID
(`worker-coordinator-lifecycle.mjs:63-73`). Worker status/wait and review
start/result return full output/findings rather than compact notifications, with
no response-size bound.

### M-02 — Valid public review IDs can still fail after internal suffixing

The public protocol accepts 80-character IDs (`worker-protocol.mjs:9,36-40`),
but pass/synthesis workers prepend/append `sol-`, `-pN`, or `-synth`
(`worker-coordinator.mjs:419-443`) and revalidate the derived ID. A valid public
review ID near the limit therefore fails internally. Use bounded hashed internal
IDs or reserve suffix space at the public boundary.

### M-03 — `review start` usability still depends on a long foreground tool call

The command text acknowledges that the call may remain open and suggests polling
from another controller turn, but the CLI itself has no `--detach`/accepted-job
mode. In clients that cannot background the shell tool, one 31-minute request
blocks the controller from issuing `review status`, resolving unrelated work, or
reporting progress. This compounds I-03 even when no crash occurs.

## Verified fixes and strengths

The re-review confirms the following material improvements in `6591637`:

- completed commits invalidate prior gates; apply performs base/head/tree and
  package-file hash checks;
- Luna commit authority now requires a terminal validated result, exact
  runtime-owned assignment, canonical common/worktree Git directories, branch,
  and base ancestry;
- recursive directory audit, empty-audit rejection, base/range file filters, and
  committed-blob evidence work in the covered cases;
- transport exit marks active work indeterminate and missing clean worktrees can
  be restored;
- blocking turns release and later reacquire an inference slot;
- state writes and coordinator ownership now have cross-process directory locks;
- multi-commit conflicts restore the exact integration HEAD;
- Sol schema output gets stricter validation, a single repair attempt, bounded
  invalid-output diagnostics, and process cleanup;
- SessionEnd preserves legacy cleanup outside Git repositories;
- `git diff --check db52e28..HEAD` is clean.

These fixes justify the “partially fixed” dispositions; they do not offset the
remaining exact-review authorization failure.

## Complete prior-finding disposition

| Prior ID | Status | Notes |
|---|---|---|
| C-01 | Partial / blocking | Existing-gate invalidation added; in-flight H1-to-H2 rebinding remains CR-01. |
| C-02 | Partial | Brief/instructions/report/constraints added; binding source contents and isolated evidence remain missing. |
| C-03 | Partial | Longer timeout and preclaimed idempotency added; long-request and crash recovery remain broken. |
| C-04 | Partial | Locks added; authoritative discovery/start identity/integration identity remain broken. |
| C-05 | Partial | Payload and lifecycle validation added; typed protocol responses remain broken. |
| C-06 | Fixed for original defect | Atomic abort restores HEAD; repair workflow remains I-07. |
| I-01 | Partial | Audit/filter/committed blob fixes landed; snapshot and manifest contract remain I-04. |
| I-02 | Partial | Per-chunk size is bounded; manifest-owned/cross-cutting partitioning remains I-05. |
| I-03 | Partial | Transport exit and worktree restore landed; known-idle/review crash recovery remain incomplete. |
| I-04 | Partial | Slot ownership/reacquisition landed; durable scheduler leases/live bound/fairness remain I-06. |
| I-05 | Partial | Atomic locked writes/private artifacts improved; required persistence contract remains I-06. |
| I-06 | Fixed for original authority checks | Terminal result, exact assignment, repository/worktree/branch/base checks landed. |
| I-07 | Partial | Validation/repair/diagnostic cleanup improved; re-review/rulings/finding lifecycle remain I-08. |
| I-08 | Remaining | Capability probe remains model/effort-only. |
| I-09 | Fixed | Non-Git SessionEnd now catches coordinator shutdown failure and continues cleanup. |
| I-10 | Remaining | Normative adversarial and E2E matrix remains I-09. |
| M-01 | Remaining | Exit taxonomy, response correlation, compactness, and response bounds remain. |
| M-02 | Remaining | Derived internal ID length still exceeds the public allowance. |
| M-03 | Fixed | Sol workers close in `finally`. |
| M-04 | Fixed | Diff check is clean. |

## Verification performed

All verification used the isolated feature worktree and did not modify
implementation files.

- Confirmed branch/HEAD: `codex-worker-development` at
  `659163731dddf19ebf8ae84f752ca49c9e6ee3d7`; worktree was clean before review.
- Read the binding design, the previous Sol implementation review, the complete
  `db52e28..6591637` diff, and the focused `2628101..6591637` remediation diff.
- `npm test`: **pass, 130/130**, no failures/skips/todos.
- `./node_modules/.bin/tsc -p tsconfig.app-server.json`: **pass**.
- `npm run check-version`: **pass**, all metadata matches `1.0.6`.
- `git diff --check db52e28..HEAD`: **pass**.
- Focused regression subset: **pass, 9/9**, covering simultaneous discovery,
  non-Git shutdown, blocking requests, malformed decisions, review idempotency
  claim, completed-gate invalidation, audit/committed evidence, package bounds,
  and multi-commit rollback.
- Adversarial real-Git gate-race reproduction: **fails invariant**, integrating
  H1 and unreviewed H2 under the H1 package.
- Permission-response reproduction: **fails invariant**, rejecting the valid
  permissions shape and forwarding invalid `{decision:"accept"}`.
- Corrupt-metadata/live-owner fault injection: **fails invariant**, leaving the
  old coordinator alive with its endpoint removed.
- Running-review restart reproduction: **fails invariant**, leaving the same key
  permanently running and rejecting a new key.
- Oversized two-file partition inspection: **fails invariant**, seven of eight
  passes had no manifest and most named no owned path.

`npm run build` was not invoked because its `prebuild` regenerates tracked
app-server type files, which would violate the report-only review constraint.
The non-mutating TypeScript command used by `build` was run directly and passed.

## Implementation-readiness gate

The branch must remain blocked. A credible next re-review should require, at
minimum:

1. a transactional exact-package review binding that fails stale on any H1/H2
   race, with the reproduced race as a test;
2. generated, method-specific server-request response validation with real
   protocol fixtures;
3. authoritative coordinator ownership/discovery with process start identity and
   corrupt-metadata/PID-reuse tests;
4. durable asynchronous or leased review execution with crash reconciliation;
5. binding spec/global constraints copied into a genuinely immutable review
   environment;
6. manifest-owned partitions, cross-cutting coverage, and exact context-budget
   accounting;
7. the specified persistence/scheduler, conflict-repair/re-review, ruling, and
   capability-probe state machines; and
8. the normative adversarial plus two-task fake-runtime end-to-end release gate.

Until those conditions hold, neither a passing Sol result nor a green unit suite
is sufficient authority to integrate worker commits automatically.
