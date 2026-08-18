# Codex Worker Development Implementation — Sol Review

**Reviewed:** 2026-08-18

**Base:** `db52e28`

**Head:** `262810164026dadf931758d359b0f7038dcc9e07`

**Binding specification:** `docs/superpowers/specs/2026-08-18-codex-worker-development-design.md`

**Scope:** Full branch diff, runtime and Git authority, app-server request routing,
IPC/concurrency, persistence/recovery, immutable review packaging, CLI/skills,
compatibility, and tests.

## Executive verdict

| Dimension | Verdict | Reason |
|---|---|---|
| Specification compliance | **fail** | Core normative guarantees are absent or contradicted, including exact review-to-head binding, single coordinator authority, actionable blocking requests, immutable/complete task-review evidence, durable scheduling, bounded review context, crash recovery, and compatibility probing. |
| Code quality | **changes-required** | The happy paths are compact and readable, but correctness depends on controller discipline where the trusted runtime is required to enforce invariants. Several timeout, retry, conflict, crash, and concurrent-start paths can lose state, exceed limits, integrate unreviewed code, or report success over incomplete evidence. |
| Implementation readiness | **not ready** | The branch must not be presented as an implementation of the approved design or used to integrate worker changes until the critical findings are fixed and the missing adversarial/E2E tests exist. |

The additive module layout, direct app-server clients, explicit IDs, owner-only
Unix files, model/effort selection, output schemas, mechanical commits, and basic
CAS check are useful foundations. The existing test suite also remains green.
Those positives do not compensate for failures in the design's trust and
recovery boundaries.

## Critical findings

### C-01 — A stale scalar review gate allows unreviewed commits to be integrated

**Classification:** Specification and code quality

**Evidence:**

- `plugins/codex/scripts/lib/worker-coordinator.mjs:85-93` lets every
  `integration.commit` replace `headCommit` and `tree`, but does not invalidate
  `reviewGate` or bind a review to that head/tree/package hash.
- `plugins/codex/scripts/lib/worker-coordinator.mjs:278-282` records only the
  scalar gate status on the worker.
- `plugins/codex/scripts/lib/worker-coordinator.mjs:95-103` checks that scalar,
  then applies the worker's *current* `headCommit`. It neither compares that head
  with the reviewed head nor verifies `packageHash`/manifest/tree.

After one passing review, another coordinator commit can be created and applied
without any review. This defeats the central integration gate and directly
contradicts design lines 312-316 and 650.

**Impact:** Unreviewed or post-review-modified code can enter the integration
branch while the runtime reports that review passed.

**Required change:** Persist an immutable review binding containing at least
review ID, exact base/head commit IDs, staged tree, manifest/package hash, and
verdict. Invalidate it on every later commit or relevant mutation. At apply time,
re-resolve and compare all bound Git facts and reject any mismatch.

**Confidence:** 1.0

### C-02 — Task reviews receive no task brief, binding requirements, implementation report, tests, or concerns

**Classification:** Specification and code quality

**Evidence:**

- `plugins/codex/scripts/lib/worker-coordinator.mjs:211-227` derives only a Git
  target and freezes it. It does not load the task brief, global constraints,
  worker result, implementation report, test evidence, or concerns.
- `plugins/codex/scripts/lib/worker-coordinator.mjs:238-249` prompts Sol with only
  the generic template, package path, and package hash.
- `plugins/codex/scripts/lib/review-package.mjs:83-99` packages only target
  metadata, manifest, and source/diff sections.
- The Luna report does exist (`worker-coordinator.mjs:426-439`) but is never
  connected to `startReview`.

The design explicitly requires task brief, implementation report, immutable
package, and binding global constraints (lines 362-366). A real reviewer cannot
soundly return the required specification verdict from the implemented package.
The fake fixture always returns `pass/approve`, masking this absence.

**Impact:** The runtime can certify specification compliance without providing
the specification. Worker concerns and test failures are omitted from the gate.

**Required change:** Make task briefs and requirement references canonical
runtime artifacts, include their hashes plus the schema-validated implementation
report/test evidence/concerns in every task review package, and fail closed when
required evidence is unavailable.

**Confidence:** 1.0

### C-03 — Real review starts time out at the CLI while continuing server-side, and retries are not idempotent in flight

**Classification:** Code quality and usability

**Evidence:**

- `plugins/codex/scripts/codex-workers.mjs:118-123` gives every operation except
  `worker.wait` a 10-second IPC timeout.
- `plugins/codex/scripts/lib/worker-coordinator.mjs:228-266` makes
  `review.start` synchronously execute every Sol pass and optional synthesis;
  each pass can wait up to 30 minutes (`:294-300`).
- A review record is created only after all inference completes
  (`worker-coordinator.mjs:266-282`), so `review.status` cannot observe an
  in-flight review.
- Idempotency is cached only after the operation returns
  (`worker-coordinator.mjs:59-63,121-122`). A retry while the first request is
  still running does not find an in-flight claim and can repeat side effects.

The fast fake responses finish under ten seconds, but ordinary Sol reviews will
not. The caller receives a timeout although the coordinator keeps consuming
model usage; retrying may start duplicate review work or collide on derived
workers/artifacts.

**Impact:** `/codex:sol-review` and task review are operationally unreliable,
can duplicate expensive turns, and cannot be recovered through the advertised
status/result interface.

**Required change:** Persist and idempotently claim the review before side
effects, return a compact queued/running result immediately, and make
`review.status`/`review.result` the completion path. Alternatively, a blocking
mode must use a caller timeout consistent with the full operation while still
persisting an in-flight idempotency record.

**Confidence:** 1.0

### C-04 — Coordinator startup can create split brain and the state store is not a cross-process single-writer store

**Classification:** Specification, concurrency, persistence, and security

**Evidence:**

- `plugins/codex/scripts/lib/worker-coordinator-lifecycle.mjs:86-127` has no
  creation lock. Concurrent callers can both decide no healthy coordinator
  exists, overwrite the token, unlink the same socket, spawn coordinators, and
  overwrite metadata.
- A 300 ms readiness miss is treated as death (`:79-90`), after which the code
  unlinks the endpoint (`:98-100`) without validating the recorded PID's start
  identity or executable.
- Metadata contains only PID and timestamp (`:113-120`), not process start
  identity/executable metadata required by design lines 167-171.
- `plugins/codex/scripts/lib/worker-state.mjs:87-95` performs a read/check/write
  sequence without an interprocess lock or atomic compare-and-swap. Two writers
  can both observe the same revision and overwrite each other.
- `integrationLease` is initialized (`worker-state.mjs:18`) but never acquired or
  enforced.

An old coordinator can also continue receiving app-server notifications after
its socket is replaced, so both processes may mutate the same state and Git
repository.

**Impact:** Lost state updates, duplicate workers/turns, scheduler limit
violations, and concurrent integration mutations are possible. This invalidates
the architecture's sole-writer trust assumption.

**Required change:** Add an OS-backed repository/integration-identity ownership
lock and atomic endpoint publication. Verify PID start identity and executable
before cleanup, never unlink a live or unverified endpoint, make state writes
single-writer/locked, and implement a real expiring CAS integration lease.

**Confidence:** 0.99

### C-05 — Blocking requests discard the information needed to make a safe decision and accept arbitrary unvalidated responses

**Classification:** Specification, security, and usability

**Evidence:**

- `plugins/codex/scripts/lib/worker-coordinator.mjs:448-465` persists method and
  routing IDs only. It discards command, cwd, reason, requested permissions,
  question schema, MCP message/schema, allowed decisions, scope, and risk; it
  also hard-codes `isBlocking: true`.
- The transient map (`:461`) retains only client and server request ID, not an
  actionable sanitized request exposed to the controller.
- `resolveRequest` (`:323-340`) accepts any JSON result without method-specific
  schema/allowed-decision validation or expiry checking, marks it resolved after
  an unacknowledged transport write, and immediately increments inference use.
- `stop` rejects a request in memory but does not persist `cancelled`
  (`:343-349`). Restart cancels only the persisted marker and loses the original
  connection, so it cannot provide exact resolution semantics.

The design requires the exact sanitized action, reason, scope, risk, allowed
decisions, timestamps, and connection validity (lines 207-215 and 521-525).

**Impact:** The controller is asked to approve a hidden action or answer an
unknown form. Blind approval can authorize an unintended command, path, network
scope, permission expansion, or MCP action. Typed interaction is not practically
usable.

**Required change:** Define method-specific request/response schemas, persist a
sanitized actionable payload and allowed decisions, enforce expiry and
connection/turn identity, fail closed for Sol mutation requests, and preserve an
exactly-once resolution ledger without storing secret answers.

**Confidence:** 1.0

### C-06 — A multi-commit integration conflict can leave the integration branch partially changed despite an error

**Classification:** Specification and code quality

**Evidence:**

- `plugins/codex/scripts/lib/worker-worktree.mjs:94-100` cherry-picks each commit
  in a separate command. If commit 1 succeeds and commit 2 conflicts,
  `git cherry-pick --abort` aborts only the active second cherry-pick; commit 1
  remains on the integration branch.
- The method then throws that integration "was aborted," although the branch is
  no longer at its original HEAD.
- No conflict ledger, repair branch, exact patch replay, or full repaired-delta
  review exists.

This contradicts the required conflict protocol that keeps the integration
branch unchanged (design lines 319-326).

**Impact:** A failed integration can silently install only a prefix of the
reviewed task and corrupt subsequent dependency/review assumptions.

**Required change:** Run the ordered commits as one sequencer transaction (or
otherwise guarantee restoration to the verified starting OID), hold the
integration lease for the full operation, verify the post-abort HEAD, record the
conflict, and create the specified repair branch/workflow.

**Confidence:** 0.99

## Important findings

### I-01 — Review targets are incomplete and can produce a passing review over no source

**Classification:** Specification and code quality

`review-target.mjs:25-33` counts `files` as an audit selector even when `base` or
`range` is present, so the explicitly supported `--base/--range` plus file-list
filter is rejected as ambiguous. `review-package.mjs:40-42` passes an audit path
directly to `fileEvidence`; a directory is marked `not-file` rather than walked.
A read-only reproduction against this branch produced:

```json
{
  "path": "plugins/codex/scripts",
  "kind": "audit",
  "included": false,
  "reason": "not-file",
  "bytes": 0
}
```

The resulting package contained no file sections. In addition, committed
manifests hash paths from the live cwd (`review-package.mjs:19-30,33-39`) rather
than reading blobs from `target.head`; ranges ending at a non-HEAD commit can
therefore describe different bytes than the diff. Submodule/LFS/generated and
dependency-discovered records are not implemented.

**Impact:** Advertised subsystem audits can approve an empty package, valid file
filters fail, and manifests are not reproducible for arbitrary ranges.

**Required change:** Implement the complete target grammar, recursively and
boundedly enumerate audit roots/files, materialize committed blobs and mutable
targets into immutable snapshots/synthetic trees, and record every included or
skipped manifest entry with the required type/reason.

**Confidence:** 1.0

### I-02 — Context partitioning does not enforce the configured input bound

**Classification:** Specification and code quality

`review-package.mjs:66-80` partitions only between manifest entries. A single
large file is always placed in one pass even when it exceeds the limit. A
reproduction using `worker-coordinator.mjs` with `maxInputTokens: 100` produced
one partition estimated at 6,112 tokens and a 6,211-token package. Large deleted
diffs are worse because deleted entries have zero bytes while their diff remains
large. The complete oversized package is still built/stored first (`:83-99`),
and each scoped package is sent without a post-build bound check
(`worker-coordinator.mjs:227-249`). Synthesis serializes every pass report without
budget estimation (`:255-264`). There is no cross-cutting pass or coverage
verification, and reports omit the fixed/schema/tool/output/error reserve
accounting required by design lines 487-517.

**Impact:** Reviews can overflow context, truncate in tool output, fail, or
synthesize incomplete evidence while claiming bounded coverage.

**Required change:** Enforce the full accounting after final package rendering,
split or fail closed on an oversized single entry, separately bound synthesis,
add manifest ownership/cross-cutting coverage checks, and record requested and
confirmed budget telemetry.

**Confidence:** 1.0

### I-03 — App-server/transport failure can leave a worker permanently `running`; resume does not establish a known idle boundary

**Classification:** Specification, crash recovery, and code quality

The coordinator never observes a client's `exitPromise` or transport close.
After `turn/start` returns (`worker-coordinator.mjs:381-395`), a later app-server
exit emits no coordinator transition, so the turn can remain `running` forever.
Idle app-server failure is not automatically replaced/resumed. Only constructing
a whole new coordinator marks online records indeterminate (`:40-56`). Resume
ignores the resumed thread's returned status and marks it ready (`:163-175`), so
it does not prove the required idle boundary. It also reuses the saved path and
does not reconstruct a missing worktree (`:72-82`). A crash between worktree,
thread, and state creation leaves unrecorded resources because the record is
written only at `:176-177`.

**Impact:** Waiters can hang, retries can overlap uncertain remote work, missing
worktrees cannot recover, and partial starts leak branches/processes/threads.

**Required change:** Wire transport lifecycle into durable transitions, adopt a
transactional start ledger with reconciliation checkpoints, invalidate pending
requests on loss, require explicit retry after verified idle resume, and rebuild
missing task worktrees from the saved branch.

**Confidence:** 0.98

### I-04 — Blocking-request slot release and durable queue semantics do not enforce the repository-wide limit

**Classification:** Specification and concurrency

When a turn blocks, `#handleServerRequest` decrements the global counter and
pumps another turn (`worker-coordinator.mjs:448-469`). Resolving the request then
increments the counter immediately (`:323-340`) without reacquiring a scheduler
slot. With a cap of one, A can block, B can start, and resolving A makes both
infer concurrently. Completion/interrupt can decrement again even though the
blocked turn had already released its slot, allowing further overcommit.

The queue is shifted durably *before* app-server accepts the turn (`:364-395`),
has no priority, lease, heartbeat, live-turn bound, or durable in-flight claim,
and startup simply clears it (`:40-56`).

**Impact:** The five-turn usage cap is not reliable, and queued work can be lost
or duplicated across crashes.

**Required change:** Track per-turn slot ownership, queue request resumption
until a slot is available, make terminal accounting idempotent, and implement
durable FIFO-within-priority queue leases/heartbeats and crash reconciliation.

**Confidence:** 1.0

### I-05 — Persistence and artifacts do not implement the approved durability/security contract

**Classification:** Specification, persistence, and security

`worker-state.mjs` has one shallowly validated repository-level JSON file, not
the required per-orchestration state/progress/task/final layout. Repository
identity hashes only the common Git directory (`worker-protocol.mjs:19-33`) and
does not bind an explicit canonical integration worktree, so separate integration
worktrees collide. The store has no schema migrations, stale-temp reconciliation,
immutable events, retention, active-artifact protection, cleanup API, fallback
warning, size cap, or redaction pass. `lastOutput`, reports, package content, and
idempotency results can grow without bound. Backup replacement is a direct copy
and cross-process revision protection is ineffective.

**Impact:** Recovery can silently lose queued/in-flight context, different
integration worktrees can share authority, and proprietary/model output can
cause unbounded durable state and IPC frames.

**Required change:** Implement the versioned orchestration/artifact schema,
integration-worktree identity, locked atomic persistence with migrations/temp
recovery/valid backup, bounded event and raw-output storage, explicit 30-day
inactive retention, and repository-scoped cleanup/redaction policy.

**Confidence:** 0.99

### I-06 — Trusted Git authority does not verify that it is still operating on the assigned worktree/repository

**Classification:** Specification and security

`commitTaskWorktree` accepts only a cwd and optional caller-supplied path list
(`worker-worktree.mjs:54-77`). It does not compare canonical common Git dir,
worktree Git dir, branch, base, or assignment state with persisted trusted facts.
The coordinator permits commit at any turn state and makes `allowedPaths`
optional (`worker-coordinator.mjs:85-93`; `codex-workers.mjs:58-61`). A modified
or redirected worktree Git pointer, wrong repository, mid-turn partial edit, or
undeclared path set is therefore not rejected by the trusted layer.

**Impact:** The runtime can commit from the wrong repository/branch or commit
partial/unassigned changes, weakening the premise that Luna cannot control Git
metadata and that only runtime-derived paths are staged.

**Required change:** Persist and revalidate common-repo/worktree/branch/base
identity before every Git action, require a terminal validated Luna result and a
runtime-owned assignment manifest, stage only paths derived from that manifest
and Git status, and test actual workspace-write protection of linked-worktree Git
metadata.

**Confidence:** 0.96

### I-07 — Structured review validation, re-review, rulings, and repair semantics are largely prompt-only

**Classification:** Specification and code quality

`validateSolReview` (`worker-review.mjs:12-27`) is a hand-written partial check:
it accepts unknown fields, arbitrary model-provided IDs, malformed location
objects/relationships, and does not apply the checked-in JSON Schema. Stable IDs
include mutable title/severity/pass material (`:7-10`) rather than the specified
normalized rule/evidence fingerprint semantics. Invalid output is neither saved
as bounded/redacted diagnostics nor repaired once (`worker-coordinator.mjs:294-300`).
The re-review prompt is never loaded, there is no scoped re-review operation, and
there is no persisted controller-ruling API; `pass-with-ruling` exists only as an
unused function option (`worker-review.mjs:29-32`) and integration accepts only
literal `pass` (`worker-coordinator.mjs:97`).

**Impact:** Findings cannot be reliably tracked across rounds, malformed output
does not follow the recovery policy, and the documented fix/ruling workflow
cannot be executed through the runtime.

**Required change:** Use a real strict schema validator, runtime-generated IDs,
bounded raw diagnostics plus one repair retry, explicit re-review inputs and
finding dispositions, and a durable controller-ruling record enforced by the
gate.

**Confidence:** 1.0

### I-08 — Capability probing verifies only model names and efforts, not the required protocol/runtime behavior

**Classification:** Specification and compatibility

`worker-coordinator.mjs:138-149` checks only `model/list` and supported effort.
It does not record a minimum CLI version or verify `thread/resume`, structured
`turn/start`, interrupt, supported server-request methods/responses, config
overrides, experimental fields, or that thread/turn responses actually selected
the requested model/effort/config. `/codex:setup` only claims a later probe in
prose (`commands/setup.md:13-16`); it does not execute or report a full
compatibility record. There is no minimum/current protocol fixture split.

**Impact:** Version/provider skew can surface after resources are created, config
can be ignored or rejected, and silent rerouting/fallback is not detected despite
the fail-closed requirement.

**Required change:** Add a cached, versioned startup/setup capability record and
exercise every required method/config combination with actionable compatibility
errors before dispatch.

**Confidence:** 0.99

### I-09 — SessionEnd now fails in non-Git workspaces and skips existing cleanup

**Classification:** Code quality and compatibility regression

`session-lifecycle-hook.mjs:84-87` calls `shutdownCoordinatorSession` before the
existing broker/job cleanup. That function constructs a worker store, which
unconditionally runs Git identity resolution. The existing cleanup deliberately
supports non-Git cwd through `resolveWorkspaceRoot` fallback. A direct
SessionEnd reproduction with `cwd=/tmp` exited 1 with:

```text
git rev-parse --show-toplevel: exit=128: fatal: not a git repository
```

Because the exception occurs first, broker shutdown, job cleanup, and state
cleanup are skipped.

**Impact:** Existing plugin sessions outside Git repositories regress and may
leak active broker/job processes or state.

**Required change:** Treat absence of a worker repository/session as a normal
no-op, isolate coordinator shutdown errors from legacy cleanup, and add a
non-Git SessionEnd regression test.

**Confidence:** 1.0

### I-10 — The normative adversarial and end-to-end test gate was not implemented

**Classification:** Specification and code quality

The branch adds focused happy-path tests, but no
`tests/worker-development-e2e.test.mjs` exists. Missing cases include simultaneous
coordinator startup/two writers, in-flight idempotent retries, approval payload
and typed response variants, resolution transport loss, app-server idle/running
crash, queue leases/fairness, partial-start crash points, PID reuse, stale review
binding, multi-commit conflict rollback/repair, missing-worktree resume, live
repository isolation, audit directories, oversized single files/synthesis,
strict schema repair, and current/minimum protocol fixtures.

**Impact:** All 118 tests pass while each critical defect above remains
executable. The suite is not evidence for the design's success criteria.

**Required change:** Add the complete normative matrix from design lines 593-643,
including the specified two-Luna/two-Sol/fix/re-review/approved-only-integration
fake-runtime E2E scenario.

**Confidence:** 1.0

## Minor findings

### M-01 — Machine-protocol error and compactness guarantees are incomplete

The CLI maps only usage, compatibility, and unauthorized errors
(`codex-workers.mjs:126-134`); Git conflict/stale errors are not exit 4 and
runtime-unavailable errors are not exit 5. The IPC client does not verify response
version/request ID (`worker-coordinator-lifecycle.mjs:63-73`). Worker wait/status
returns the full `lastOutput`/result record and review start/result returns full
findings (`worker-coordinator.mjs:268-276,303-320`), contrary to compact
notifications and potentially beyond the 1 MiB response frame, which is not
bounded.

### M-02 — Valid external IDs can fail after internal prefixing

The protocol permits IDs up to 80 characters (`worker-protocol.mjs:9`), but
review workers are derived as `sol-${reviewId}-pN` or `-synth`
(`worker-coordinator.mjs:237-260`) and then revalidated against the same 80-byte
limit. A valid long review ID therefore fails internally. Derive bounded hashed
internal IDs or reserve/validate the suffix length at the public boundary.

### M-03 — Sol app-server processes accumulate until session shutdown

Every review pass starts a new online Sol worker/app-server
(`worker-coordinator.mjs:286-300`) and never closes it after the ephemeral review.
Large reviews create one process per pass plus synthesis. Close ephemeral review
workers after their result/artifacts are durable, while retaining thread/report
identity.

### M-04 — `git diff --check` is not clean

The branch contains trailing whitespace on lines 3-6 and an extra final blank
line in `docs/superpowers/specs/2026-08-18-codex-worker-development-sol-review.md`.
This is non-functional but fails the plan's stated release check.

## Verification performed

- Inspected the complete `db52e28..2628101` diff and the binding design.
- `npm test`: **pass**, 118 tests, 0 failures (run outside the sandbox because
  Node child processes returned spurious `EPERM` inside the sandbox).
- `./node_modules/.bin/tsc -p tsconfig.app-server.json`: **pass**.
- `npm run check-version`: **pass**; metadata matches `1.0.6`.
- `git diff --check db52e28..HEAD`: **fail** on the whitespace noted in M-04.
- Focused read-only reproductions confirmed:
  - directory audit produces one excluded `not-file` entry and no source section;
  - one file estimated at 6,112 tokens remains a single pass with a 100-token
    configured input limit;
  - base/range plus `files` is rejected as an ambiguous target;
  - SessionEnd in a non-Git directory exits 1 before legacy cleanup.

## Implementation-readiness gate

Before another implementation review, the branch should at minimum:

1. Bind every passing review to exact immutable Git/package facts and make apply
   revalidate that binding under a real integration lease.
2. Make coordinator discovery/startup and state mutation provably single-writer,
   with process identity, durable idempotency claims, queue leases, and crash
   reconciliation.
3. Route complete sanitized blocking requests and typed, expiry/connection-aware
   exactly-once resolutions.
4. Turn review start into a recoverable durable job and provide task brief,
   requirements, implementation report, tests, and concerns to fresh Sol.
5. Implement true immutable snapshots, the full target grammar, strict context
   bounds/coverage/synthesis, strict schemas, re-review, and controller rulings.
6. Make Git commit/apply/conflict repair transactional and verify the assigned
   repository/worktree/branch/path facts at every trusted operation.
7. Implement transport-loss and missing-worktree recovery, full capability
   probing, non-Git lifecycle compatibility, bounded/redacted retention, and the
   complete adversarial/E2E test matrix.

Until those conditions are met, the implementation is a promising prototype of
the happy path, not a safe implementation of the approved worker runtime.
