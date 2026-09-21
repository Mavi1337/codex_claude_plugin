# Codex Worker Development Design

**Date:** 2026-08-18

**Status:** Approved; model/role separation revised for 1.0.11

**Revision:** 2026-09-21. The user-approved model/role separation supersedes older
role/model coupling. The dated `*-sol-review.md` reports are historical review
artifacts, not current routing instructions. Normative rules override old examples.

## Goal

Extend the existing Claude Code Codex plugin with a modular worker runtime that lets a capable Claude Code agent such as Fable orchestrate interactive Codex workers. Implementers execute plan tasks in isolated Git worktrees, reviewers independently review their work, and the Claude controller adjudicates findings and integrates approved commits. Model and effort are independent explicit selections for either responsibility.

The runtime must also be reusable by future Claude Code skills that need interactive Codex workers without copying the app-server, process, state, or Git implementation.

## Non-goals

- Do not create a second standalone Claude Code plugin.
- Do not modify or depend on files in Claude Code's installed plugin cache.
- Do not modify the Superpowers plugin or require it to know about this workflow.
- Do not replace the existing `/codex:review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`, or `/codex:transfer` commands.
- Do not make a Codex thread equivalent to a container, VM, or filesystem copy.
- Do not guarantee server-side prompt-cache reuse. Resumption guarantees persisted thread context, while cache reuse remains an optimization controlled by the service.

## Ownership and entry points

Superpowers may produce the specification and implementation plan, but this plugin owns the Codex execution workflow. Users select it explicitly with a command such as:

```text
/codex:develop docs/superpowers/plans/example.md
```

The `codex-worker-development` skill description also makes the workflow discoverable when an implementation plan is ready. It may be offered alongside inline execution and native Claude subagent-driven development, but correct operation must not depend on another skill remembering to offer it. An explicit `/codex:develop` invocation is the reliable entry point.

A separate `/codex:worker-review` command exposes the reusable review engine
independently of plan execution. `/codex:sol-review` remains a clearly labeled
legacy alias with the same selection behavior; its name does not select Sol.

The main Claude Code model remains the controller. The plugin does not select or enforce Fable; it works with the capable controller model chosen by the user.

## Architecture

```text
Claude controller (Fable)
        |
        | codex-workers CLI operations
        v
Reusable worker runtime
        |
        +-- per-repository coordinator
              +-- codex app-server -- Implementer thread A
              +-- codex app-server -- Implementer thread B
              +-- codex app-server -- Reviewer thread C
              +-- queue, integration lease, durable state and artifacts
```

The implementation lives inside the existing `codex-plugin-cc` repository and plugin bundle. It imports the existing app-server client and common process, Git, workspace, and state utilities. Shared runtime behavior must not be copied into skill directories.

Proposed module layout:

```text
plugins/codex/
├── commands/
│   ├── develop.md
│   ├── worker-review.md
│   └── sol-review.md (legacy alias)
├── prompts/
│   ├── implementer.md
│   ├── task-reviewer.md
│   ├── re-reviewer.md
│   └── branch-reviewer.md
├── schemas/
│   ├── worker-turn-output.schema.json
│   └── reviewer-output.schema.json
├── skills/
│   ├── codex-worker-runtime/
│   │   └── SKILL.md
│   └── codex-worker-development/
│       ├── SKILL.md
│       └── references/
│           ├── implementation-loop.md
│           └── review-contract.md
└── scripts/
    ├── codex-workers.mjs
    ├── codex-worker-coordinator.mjs
    └── lib/
        ├── worker-runtime.mjs
        ├── worker-state.mjs
        ├── worker-coordinator.mjs
        ├── worker-protocol.mjs
        ├── worker-worktree.mjs
        ├── review-target.mjs
        ├── review-package.mjs
        └── existing app-server/state/process/git modules
```

Skill directories contain Claude-side workflow instructions, role references, and small skill-specific helpers only. Generic process management, app-server communication, persistent state, context budgeting, review packaging, and Git worktree behavior remain common JavaScript modules.

## Runtime interface

`codex-workers.mjs` is a stable command-line adapter used by Claude Code skills and commands. Its machine-facing mode returns structured JSON. Human-facing rendering is a separate concern.

Required operations:

```text
worker start
worker send
worker wait
worker status
worker list
worker stop
worker close
worker resume
worker resolve-request
integration commit
integration apply
review start
review status
review result
```

Every operation addresses an explicit orchestration, worker, review, request, or
integration ID. Mutating requests carry an idempotency key. The runtime must not
use a global "latest worker" as the authoritative selector when several workers
exist.

Machine mode uses newline-delimited, versioned JSON envelopes with a maximum
frame size of 1 MiB. Requests contain `version`, `requestId`, `idempotencyKey`,
`repositoryId`, `operation`, `params`, and the coordinator capability token.
Responses contain the matching request ID and either `result` or a structured
`error`. Stdout contains one response only; diagnostics go to stderr. Exit codes
distinguish usage (2), compatibility (3), conflict/stale state (4), unavailable
runtime (5), and internal failure (1). IDs match
`[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}`.

The interface is role-neutral. A worker record contains the requested model, effort, prompt/role contract, permissions, working directory, thread ID, branch, worktree, state, and artifact paths. `implementer` and `reviewer` select responsibilities and permissions only.

Both `worker start` and `review start` require `--model MODEL --effort EFFORT`.
The coordinator rejects either missing or blank value even if the request key
was previously used. No model or effort is defaulted, trimmed, or substituted.
Discovery follows `model/list` pagination and accepts any exposed identifier and
supported effort, without a model allowlist. Thread start/resume receives the
exact model and `config.model_reasoning_effort`; turn start receives the same
model and effort. Unsupported pairs fail with a compatibility diagnostic.

Examples (append the required worker/review and orchestration IDs):

```text
worker start --role implementer --model gpt-5.6-luna --effort high
worker start --role reviewer --model gpt-5.6-sol --effort xhigh
worker start --role implementer --model gpt-6-astra --effort low
review start --model gpt-6-astra --effort high --worktree
```

New workers default only their role to `implementer`; `luna` and `sol` are invalid
new roles. `worker resume` reads the saved record, normalizes those historical
roles to `implementer` and `reviewer`, and persists the normalized record after a
successful resume. Preserve the existing worker/thread/branch identities and
exact saved model/effort. Missing or unavailable saved selections fail; never
invent a profile from the old role name.

## Coordinator, workers, and concurrency

The current shared broker permits only one active streamed request and falls back to direct app-server processes when busy. The interactive worker runtime must not depend on that fallback for concurrency.

One detached Node coordinator exists per stable local repository identity. It is
the only writer of orchestration state and the only authority allowed to start
turns or mutate the integration branch. Each active worker owns a direct
`codex app-server` child inside that coordinator. This replaces the earlier
per-worker-supervisor proposal because one authority is required to prevent lost
updates and enforce a repository-wide limit.

The coordinator:

- initializes app-server once;
- starts or resumes one Codex thread;
- accepts sequential turns for that thread;
- captures notifications, questions, approval requests, progress, and final output;
- supports interruption and clean shutdown;
- persists state after each meaningful transition;
- reconciles partially created workers and expired leases at startup;
- marks in-flight turns indeterminate if their transport dies, then resumes the
  thread only to a known idle boundary after an explicit retry;
- owns one compare-and-swap integration-writer lease.

The default scheduler permits five concurrent inference turns across every
orchestration sharing the repository identity. Idle workers and turns paused on
a blocking app-server request release an inference slot, but pending turns count
against a separate configurable live-turn bound. Queue entries are durable and
idempotent, FIFO within priority, carry leases and heartbeats, and are reconciled
after a crash. A new turn queues instead of silently exceeding the limit.

The local endpoint is derived from repository identity in a short owner-only
runtime directory. Unix directories and sockets are mode `0700`/`0600`; Windows
uses a user-scoped named pipe. A random owner-only capability token binds clients
to the repository. PID records include process start identity and executable
metadata so cleanup never trusts a reused PID.

The existing broker and commands remain unchanged unless a shared internal extraction benefits both paths without changing behavior.

## State machines

Supervisor state is `starting | online | stopped | crashed | closed`. Thread state
is `new | ready | unavailable`. Turn state is
`queued | running | waiting-input | waiting-approval | completed | failed |
interrupted | indeterminate`. Controller task state is
`pending | implemented | in-review | accepted | integrated | blocked`.
Request state is `pending | resolved | expired | cancelled`. Only the coordinator
writes transitions. A worker may be idle while its app-server and thread remain
ready; `resume` restores readiness and never implies that a turn has started.

Definitions:

- `start` creates the worker record, branch/worktree when required, app-server, and Codex thread.
- `send` starts a new turn in the same persisted thread.
- `wait` returns when the active turn completes, enters a blocking request, fails,
  becomes indeterminate, or is interrupted.
- `status` returns a compact non-blocking snapshot.
- `stop` interrupts the active turn and preserves the thread, branch, worktree, and artifacts.
- `resolve-request` answers a pending app-server server request on its original
  JSON-RPC connection. It never starts another turn.
- `close` stops the worker app-server. It may remove a clean worker worktree only
  after coordinator-created commits and preservation of non-disposable ignored
  files. It refuses destructive cleanup of uncommitted work.
- `resume` recreates a missing worktree from the saved branch when necessary, starts an app-server, and calls `thread/resume` for the saved Codex thread.

A Codex worker cannot interrupt Claude in the middle of model generation.
Interaction occurs at tool boundaries. A completed model turn may return
`needs_input`, after which `send` starts a follow-up turn. By contrast, a blocking
app-server question or approval keeps the existing turn alive and must be answered
with `resolve-request`.

Pending requests persist a runtime request ID, transient server request ID,
method, worker/thread/turn/item/approval IDs, blocking flag, allowed decisions,
sanitized action data, and created/expiry timestamps. Resolution is exactly-once:
repeating the same idempotency key returns the prior result, while a conflicting,
expired, or connection-invalid decision is rejected. Secret answers are sent to
app-server but never persisted. Stop and close deny or cancel pending requests
before interruption. Unknown mutating request methods fail closed. Supported
methods cover command approval, file-change approval, tool user input, MCP
elicitation, and permission approval.

## Communication contract

Worker turns use structured terminal statuses:

```text
completed
completed_with_concerns
needs_input
needs_approval
blocked
failed
interrupted
```

Questions and approval requests return directly to the controller because they need an immediate decision. Completed work writes a canonical report file and returns only a compact notification.

Example controller result:

```json
{
  "status": "completed",
  "workerId": "implementer-2",
  "threadId": "thread-id",
  "head": "abc123",
  "tests": "passed",
  "reportFile": "/absolute/path/to/task-2-report.md"
}
```

Large task briefs, implementation reports, diffs, review packages, and review reports travel as file paths. They must not be copied repeatedly through the controller context.

## Persistence and artifacts

Persistent orchestration state lives under `CLAUDE_PLUGIN_DATA`, keyed by a
repository ID derived from the canonical `git rev-parse --git-common-dir` and an
explicit canonical integration-worktree identity. The ID is passed to task
workers and never re-derived from their worktree cwd. The runtime may retain the
existing `/tmp` fallback for standalone diagnostics, but warns that cross-session
recovery is not guaranteed without plugin data storage.

Each orchestration stores:

```text
orchestrations/<orchestration-id>/
├── state.json
├── progress.md
├── tasks/
│   └── <task-id>/
│       ├── brief.md
│       ├── implementation-report.md
│       ├── review-package.md
│       ├── reviewer-report.json
│       └── re-reviews/
└── final/
    ├── review-package.md
    └── reviewer-report.json
```

State records include worker ID, role, status, PID, endpoint, model, effort, thread ID, turn ID, branch, worktree, base commit, head commit, artifact paths, timestamps, and the last recoverable error.

State uses a versioned schema and monotonically increasing revision. The
coordinator is its single writer. Writes use an owner-only temporary sibling,
file fsync, atomic rename, and directory fsync where supported; the previous valid
record is retained as a bounded backup. Startup validates and migrates known
versions, reconciles stale temporary files, and reports corruption instead of
silently creating empty state. Immutable per-turn events and per-worker artifacts
avoid unrelated read-modify-write contention.

The trusted runtime is the sole writer of canonical reports. Workers return
schema-validated fields; they never choose artifact paths. State directories are
`0700` and files `0600`. Secret answers, credentials, environment values, and raw
authorization headers are never logged. Approval commands and paths are
sanitized, raw model output and logs are size capped, active artifacts are never
pruned, and inactive orchestration retention defaults to 30 days with explicit,
repository-scoped cleanup.

Session shutdown asks the coordinator to interrupt active turns and close app-server
children within the hook deadline. It preserves orchestration records, branches,
Codex thread IDs, and reports. Persistent worker state must not be removed by the
existing session-job cleanup logic.

## Git worktrees and scheduling

The Claude controller owns one integration branch/worktree. Every implementation task gets a dedicated branch and worktree based on the latest accepted integration commit.

The controller derives dependencies and likely file ownership from the implementation plan. It may run tasks concurrently only when their declared dependencies are satisfied and their expected files/interfaces do not overlap. Tasks with dependencies wait until prerequisite commits have passed review and been integrated.

Implementer edits and tests but cannot write Git metadata. It returns a structured result
describing changed files, tests, and concerns. The trusted coordinator validates
that changes stay within the assigned worktree, stages only runtime-derived
allowed paths, rejects submodules and unexpected repositories, and creates a
mechanical commit with hooks disabled and signing off. Authorship identifies the
controller/runtime while the report records the implementer worker/thread. The
coordinator records the exact staged tree and resulting full commit ID.

After review approval, the coordinator derives the ordered commits from the
persisted base/head object IDs, verifies ancestry and the reviewed manifest hash,
rejects merge commits, obtains the integration-writer lease, compare-and-swaps the
expected integration HEAD, and cherry-picks exactly those IDs. The workflow never
merges into `main`, pushes, or publishes without the normal user-facing finish
process.

If integration conflicts:

1. keep the integration branch unchanged;
2. record the conflict in the ledger;
3. abort the cherry-pick and create a repair branch from the new integration HEAD;
4. replay the exact task patch, resume the owning Implementer thread with the repair
   worktree and conflict details, then verify it;
5. review the entire repaired base-to-head delta before integration.

## Role policies

### Implementer

Role policy (independent of model selection):

```text
role: implementer
model: required explicit selection
reasoning effort: required explicit selection
sandbox: workspace-write
writable roots: assigned worktree only
network: restricted unless approved
thread: persistent
approval policy: on-request
approvals reviewer: user
```

Implementer reads one focused task brief, implements, tests, self-reviews, and returns a
structured implementation result. The coordinator writes its report and creates
the Git commit. Implementer does not spawn reviewers. Follow-up fixes resume the same
thread for rounds one through three so it retains implementation context.

### Reviewer

Role policy (independent of model selection):

```text
role: reviewer
model: required explicit selection
reasoning effort: required explicit selection
sandbox: read-only
approval: never
thread: fresh and ephemeral
```

Reviews are generic read-only `turn/start` calls with an output schema over a
runtime-built immutable evidence package. Native `review/start` is not used for
this engine. The reviewer receives the task brief, implementation report, review
package, and binding global constraints. It does not receive the implementer's
hidden reasoning or the controller's opinion of likely findings.

It returns two independent verdicts:

```text
spec compliance: pass | fail | cannot-verify
code quality: approve | changes-required
```

Every finding has a stable ID derived from review ID, pass ID, normalized rule,
and evidence fingerprint; severity (`critical | important | minor`), zero or more
locations, evidence, impact, recommendation, confidence, and disposition. IDs
survive re-review through explicit `supersedes` and `duplicateOf` relationships.
The coordinator validates the versioned JSON Schema, rejects unknown schema
versions and fields, stores bounded raw output for diagnostics, and permits one
schema-repair retry. The reviewer itself remains read-only.

The automatic integration gate is:

| Spec verdict | Quality verdict | Result |
|---|---|---|
| `pass` | `approve` | pass; minor findings may remain |
| `fail` | either | block |
| `cannot-verify` | either | block unless a written controller ruling waives it |
| `pass` | `changes-required` | block |

Controller rulings name finding IDs, evidence, decision, and author. Critical and
important findings cannot be silently waived. `completed_with_concerns` is a
terminal implementer result equivalent to `completed` for scheduling but its
structured concerns remain inputs to review; it never bypasses the gate.

### Final review and synthesis

Final branch review requires an explicit model and effort, like task review.
Every bounded pass, repair turn and synthesis keeps that exact selection; the
runtime never raises effort automatically. Final review is flexible and on
demand. The development workflow recommends it before handoff, while
`/codex:worker-review` permits independent invocation at any time.

The normal orchestration workflow chooses `gpt-6-astra` and explicit `low` on
every worker/review start. User requests for Luna, Sol or Astra map to
`gpt-5.6-luna`, `gpt-5.6-sol` or `gpt-6-astra` respectively, without changing the
role. Honor the requested effort, or explicitly choose the workflow's recommended
effort before dispatch. `--review-model` and `--review-effort` let `/codex:develop`
select the review lane separately from `--model` and `--effort` for both lanes.
Use `gpt-6-astra-prompting` only for a selected `gpt-6-astra` run.

## Development and review loop

For each plan task:

1. The controller extracts a focused brief and records the task base commit.
2. An implementer worker implements and tests; the coordinator validates, reports, and commits.
3. The runtime creates a review package from the exact base-to-head range.
4. A fresh task reviewer checks both specification compliance and code quality.
5. The controller reads the compact verdict, opens report findings or relevant diff sections as needed, and adjudicates conflicts between the report, plan, and specification.
6. Critical and important findings, confirmed specification gaps, and controller-required changes go back to the same implementer thread.
7. Implementer fixes and re-tests; the coordinator creates the next commit and appends its report.
8. A fresh re-reviewer receives the open findings and the scoped fix diff. It verdicts each finding as addressed or not addressed and reports new material breakage in the fix.
9. After both verdicts pass, the controller cherry-picks the task commits into the integration branch and records completion.

Fix-loop policy:

- Rounds 1-3 resume the original Implementer thread.
- Rounds 4-5 use a fresh, more capable implementer chosen by the controller and carry the brief, report, attempts, and open findings as files.
- After round 5, the controller adjudicates remaining findings and records explicit rulings. The workflow cannot loop indefinitely.

The controller normally sends fixes back to the task owner. It may perform a trivial integration-only edit itself only when starting another worker turn would be disproportionate; any controller edit still enters review before integration completion.

## Review targets

The review system distinguishes change review from current-state code audit.

Supported change targets:

- current branch against the detected default branch;
- current branch against an explicit base ref;
- current working tree, including untracked text files within bounded size limits;
- staged changes;
- unstaged changes;
- the last N commits;
- an explicit base/head or Git commit range;
- the exact commits produced by one worker task.

Supported filters:

- one directory;
- a list of files;
- bounded path patterns.

Supported code-audit targets:

- the current version of one directory or subsystem;
- the current version of an explicit file list;
- selected source plus directly relevant dependencies discovered read-only by the reviewer.

A file list without a change baseline is a current-state audit. A file list combined with a base or range filters that change review. The target resolver rejects ambiguous or incompatible combinations instead of guessing.

Example interface:

```text
/codex:worker-review --base main --model gpt-6-astra --effort high
/codex:worker-review --worktree --model gpt-5.6-sol --effort xhigh
/codex:worker-review --staged --model gpt-6-astra --effort low
/codex:worker-review --last 5 --model gpt-6-astra --effort high
/codex:worker-review --range abc123..def456 --model gpt-6-astra --effort high
/codex:worker-review --base main --path src/auth --model gpt-6-astra --effort high
/codex:worker-review --file src/api.ts --file src/auth.ts --model gpt-6-astra --effort high
/codex:worker-review --audit-path src/payments --model gpt-6-astra --effort high
```

Every target is frozen before review. Committed targets resolve to full object
IDs. Index, worktree, untracked, and audit targets become an immutable snapshot or
synthetic Git tree. A hashed manifest records included, skipped, binary, symlink,
submodule, generated, and dependency-discovered paths with reasons. Reviewers run
against that snapshot and may not inspect the live repository; any deliberately
added evidence is copied into and hashed with the package.

The review package contains that manifest and hash, resolved refs, commit list,
statistics, exact diff or selected source, requirements/spec references, test
evidence, and target metadata. Partition passes own explicit path sets; a declared
cross-cutting interfaces/tests pass may overlap them, and synthesis verifies that
every manifest entry is covered.

Ranges use Git's two-dot `A..B` commit/diff meaning unless the user explicitly
requests a merge-base comparison. `--last N` means the first-parent commits
`HEAD~N..HEAD` and rejects an unavailable depth. Staged means `HEAD` versus the
frozen index; unstaged means frozen index versus worktree; worktree combines both
and bounded untracked files. File arguments are repeatable argv values rather
than comma-split strings. Git invocations use argv arrays and `--` before
pathspecs. Renames/deletions are recorded from Git, symlinks are metadata only,
and submodules/LFS pointers are recorded but not recursively expanded.

## Context budgets

Review context limits are runtime policy, not prompt prose. Defaults:

```text
Reviewer effective context budget: 258,000 tokens
review-package/input budget: 190,000 tokens
Reviewer automatic compaction threshold: 220,000 tokens
```

The configured 258K ceiling is a conservative policy cap, not a claim that
`model/list` advertises a context window. It is applied equally to the selected
review model, without a model-specific compatibility table. App-server responses
do not confirm context limits; reports record requested settings and this
limitation. Providers with smaller limits may reject a review, which must surface
as a failure. Implementers use the selected model's Codex context defaults.

For the default Reviewer cap, 190K is the maximum evidence package, 22K is reserved
for fixed instructions and schema, 24K for tool/evidence expansion, 14K for
output, and 8K for tokenizer/measurement error. The total is 258K. Automatic
compaction starts at 220K. Reports record estimated tokens, tokenizer/version or
the documented conservative four-bytes-per-token approximation, requested
settings, and settings confirmed by available telemetry.

Before a review starts, the package builder estimates token size conservatively.
If the package exceeds 190K it must not truncate silently or rely solely on
compaction. It divides the target into manifest-owned passes, adds a declared
cross-cutting pass where needed, and runs a fresh reviewer synthesis thread over only
bounded reports. Each pass and synthesis independently obeys the full accounting
above.

Model and effort always come from explicit start options. Synthesis retains the
review's pair. Users may lower review input bounds with `--max-input-tokens`.

## Permissions and approvals

Implementer may freely perform reversible actions inside its assigned worktree that fit its sandbox and task. Network access, dependency installation requiring network, access outside allowed writable roots, or other escalated operations produce `needs_approval` for the Claude controller.

The app-server client must support and route relevant server-initiated approval requests instead of returning the current generic unsupported-method error. The coordinator records the exact action, reason, scope, and risk. The controller may approve routine reversible actions already authorized by the user's task. It must involve the user for destructive operations, security-sensitive actions, pushes, publishes, changes to shared external state, or meaningful scope expansion.

Reviewers remain read-only. The coordinator rejects command, file-change and
permission approval requests from them without exposing an approvable callback.

## Failure recovery

- Coordinator crash: the next CLI call or session hook verifies process identity,
  restarts it, and reconciles durable queue and worker records.
- App-server crash while idle: start a replacement and resume the thread.
- App-server/transport loss during a turn: mark the turn `indeterminate`; invalidate
  pending request IDs; never claim the inference survived; require an explicit
  retry with a new idempotency key from a known idle thread boundary.
- Claude context compaction: recover from orchestration state, ledger, reports, branches, and Git history.
- Claude session end: interrupt active turns and close app-server children; preserve resumable state and artifacts.
- Unresponsive worker: expose status and permit interrupt or close without deleting work.
- Missing worktree: reconstruct it from the saved branch on resume.
- Dirty worktree during close: refuse removal and report the exact files requiring attention.
- Merge conflict: return the task to its owning worker and re-review the resolution.
- Invalid structured output: store size-bounded redacted raw output, mark the turn
  failed with a parse error, and permit one bounded repair retry.
- Context-budget overflow: split into review passes before inference; never truncate silently.
- Concurrency limit: queue turns and report queue position.

## Configuration

Worker-development settings extend the plugin's existing repository-keyed configuration. Model and effort have no runtime defaults. Configuration includes:

- maximum concurrent Codex turns;
- explicit implementer and reviewer model/effort selections at the start boundary;
- role-specific context, input, and compaction budgets;
- worktree root;
- coordinator/app-server startup, idle, and graceful-shutdown timeouts;
- maximum fix rounds;
- artifact retention and explicit cleanup policy;
- default review target and default branch detection behavior.

Commands may override safe per-run values. Managed or machine-level Codex restrictions remain authoritative and cannot be weakened by plugin configuration.

Before dispatch, `/codex:develop` displays the resolved task count, concurrency
cap, implementer/reviewer models and efforts, and whether final review is enabled.
Status includes queued/running/completed turn counts and review counts so the
controller and user can see the usage shape without approving every turn.

## Compatibility and rollout

The new worker CLI and modules are additive. Existing command output, state records, and broker behavior remain compatible. Shared refactors require regression coverage before existing commands switch to them.

`setup` and coordinator startup perform a capability probe. The compatibility
record names the minimum tested Codex CLI version and verifies initialize,
`model/list`, `thread/start`, `thread/resume`, `turn/start` with output schema,
`turn/interrupt`, required server-request methods, configuration overrides, and
the requested model/effort combination. Either role accepts any model exposed by
discovery at one of its supported efforts. Missing models,
efforts, methods, or required configuration fail with actionable diagnostics;
there is no silent model fallback. Experimental features are used only after an
explicit advertised probe. CI maintains a minimum-protocol fixture and a current
fixture.

Rollout stages:

1. Add generic worker state, coordinator, and explicit-thread operations behind internal commands.
2. Add interactive Implementer role and worktree lifecycle.
3. Add Reviewer structured review and flexible target packaging.
4. Add the `codex-worker-development` orchestration skill and `/codex:develop` command.
5. Add `/codex:worker-review`, its legacy alias, and documented local-development testing.

No stage depends on editing Claude's plugin cache. Development uses the source checkout through Claude Code's local plugin-development loading flow.

## Testing

Normal CI uses the existing fake Codex fixture and consumes no live model usage.

Unit coverage includes:

- lifecycle transitions and invalid transitions;
- atomic state persistence and recovery;
- context-budget calculations and review partitioning;
- review target resolution and incompatible target rejection;
- structured worker/reviewer output validation;
- queue behavior and concurrency limits;
- safe path, branch, worktree, and PID validation.
- repository identity across main/linked/symlinked worktrees;
- state revisions, migrations, corruption, backups, and simultaneous writers;
- idempotent requests, lease expiry, queue fairness, and two-controller attempts;
- review schema/gate truth tables and immutable-manifest hashes.

Runtime integration coverage includes:

- start, message, question, response, completion, stop, close, and resume;
- server-initiated approval routing;
- multiple approval IDs, typed responses, duplicate/stale resolution, and
  connection loss before and after resolution;
- coordinator and app-server crash recovery;
- concurrent workers without notification or state cross-talk;
- persistence across a simulated Claude session boundary.
- partial-start crash injection, stale leases, PID reuse, socket authorization,
  protocol/model mismatch, and coordinator restart reconciliation.

Git integration coverage includes:

- isolated task branches/worktrees;
- actual workspace-write behavior in a linked worktree, proving Implementer cannot and
  need not commit;
- coordinator staging with hooks disabled and exact tree/commit recording;
- preservation of committed branches on close;
- refusal to remove dirty worktrees;
- clean cherry-pick integration;
- conflict detection, worker repair, and reviewed resolution;
- reconstruction of a removed worktree on resume.

Review coverage includes every supported change/audit target, stable finding IDs, both required verdicts, canonical report creation, compact controller results, scoped re-review, context-budget partitioning, and synthesis.

An end-to-end fake-runtime scenario executes two independent Implementer tasks, receives two Reviews, routes one finding through an implementer fix and scoped re-review, and verifies that the integration branch contains only approved commits.

A manual opt-in smoke test may use explicitly selected real models for both roles to validate availability and current app-server behavior. It is never part of normal CI.

Linux runs the real linked-worktree and Unix-socket tests. macOS and Windows CI
exercise their sandbox/IPC/process variants; Windows tests the user-scoped named
pipe and path handling explicitly.

## Success criteria

- Fable can orchestrate up to five concurrent Codex turns without mixing worker state or notifications.
- It can message, wait for, interrupt, close, and later resume an explicitly identified Implementer worker.
- Implementer can return questions and approval requests at tool boundaries and continue in the same thread after a response.
- Every task runs in an isolated worktree and integrates only after controller-approved review.
- Reviewer reports separate specification-compliance and code-quality verdicts with grounded file/line findings.
- Review supports branch, worktree, staged, unstaged, last-N, explicit range, path-filtered, file-list, and current-state audit targets.
- review threads remain within their configured 258K effective context budget, splitting oversized reviews without silent truncation.
- Canonical reports and orchestration state survive controller compaction and session restart.
- Existing Codex plugin commands remain behaviorally compatible.
- The runtime is reusable by future skills without duplicating app-server or worker-management code.
