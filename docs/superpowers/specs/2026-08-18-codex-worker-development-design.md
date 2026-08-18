# Codex Worker Development Design

**Date:** 2026-08-18

**Status:** Approved design

## Goal

Extend the existing Claude Code Codex plugin with a modular worker runtime that lets a capable Claude Code agent such as Fable orchestrate interactive Codex workers. GPT-5.6 Luna workers implement plan tasks in isolated Git worktrees, GPT-5.6 Sol workers independently review their work, and the Claude controller adjudicates findings and integrates approved commits.

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

A separate `/codex:sol-review` command exposes the reusable Sol review engine independently of plan execution.

The main Claude Code model remains the controller. The plugin does not select or enforce Fable; it works with the capable controller model chosen by the user.

## Architecture

```text
Claude controller (Fable)
        |
        | codex-workers CLI operations
        v
Reusable worker runtime
        |
        +-- worker supervisor A -- codex app-server -- Luna thread A
        +-- worker supervisor B -- codex app-server -- Luna thread B
        +-- worker supervisor C -- codex app-server -- Sol thread C
        |
        +-- persistent state, reports, queues, and worktree metadata
```

The implementation lives inside the existing `codex-plugin-cc` repository and plugin bundle. It imports the existing app-server client and common process, Git, workspace, and state utilities. Shared runtime behavior must not be copied into skill directories.

Proposed module layout:

```text
plugins/codex/
├── commands/
│   ├── develop.md
│   └── sol-review.md
├── prompts/
│   ├── luna-implementer.md
│   ├── sol-task-reviewer.md
│   ├── sol-re-reviewer.md
│   └── sol-branch-reviewer.md
├── schemas/
│   ├── worker-turn-output.schema.json
│   └── sol-review-output.schema.json
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
    └── lib/
        ├── worker-runtime.mjs
        ├── worker-state.mjs
        ├── worker-supervisor.mjs
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
review start
review status
review result
```

Every operation addresses an explicit worker or review ID. The runtime must not use a global "latest worker" as the authoritative selector when several workers exist.

The interface is role-neutral. A worker record contains the requested model, effort, prompt/role contract, permissions, working directory, thread ID, branch, worktree, state, and artifact paths. Luna and Sol are role profiles layered on this generic interface.

## Worker supervisors and concurrency

The current shared broker permits only one active streamed request and falls back to direct app-server processes when busy. The interactive worker runtime must not depend on that fallback for concurrency.

Each active worker has a lightweight detached Node supervisor that owns a direct `codex app-server` child and a local Unix socket or Windows named pipe. The supervisor:

- initializes app-server once;
- starts or resumes one Codex thread;
- accepts sequential turns for that thread;
- captures notifications, questions, approval requests, progress, and final output;
- supports interruption and clean shutdown;
- persists state after each meaningful transition;
- restarts app-server and resumes the thread after a recoverable crash.

The default scheduler permits five concurrent Codex turns across implementers and reviewers. Idle supervisors do not consume a turn slot. The limit is configurable, but a new turn queues instead of silently exceeding it.

The existing broker and commands remain unchanged unless a shared internal extraction benefits both paths without changing behavior.

## Worker lifecycle

```text
CREATED
  -> QUEUED
  -> RUNNING
  -> NEEDS_INPUT ----- controller sends answer -----> RUNNING
  -> NEEDS_APPROVAL -- controller decides ---------> RUNNING or BLOCKED
  -> COMPLETED
  -> STOPPED
  -> CLOSED
  -> RESUMED
  -> RUNNING
```

Definitions:

- `start` creates the worker record, branch/worktree when required, supervisor, and Codex thread.
- `send` starts a new turn in the same persisted thread.
- `wait` returns when the active turn completes, asks a question, requests approval, fails, or is interrupted.
- `status` returns a compact non-blocking snapshot.
- `stop` interrupts the active turn and preserves the supervisor, thread, branch, worktree, and artifacts.
- `close` stops the supervisor. It may remove a clean worker worktree only after all work is committed and the branch and thread ID are persisted. It must refuse destructive cleanup of uncommitted work.
- `resume` recreates a missing worktree from the saved branch when necessary, starts a supervisor, and calls `thread/resume` for the saved Codex thread.

A Codex worker cannot interrupt the Claude model in the middle of model generation. Interaction occurs at tool boundaries: `wait` or a background completion returns `needs_input` or `needs_approval`, and the controller answers with `send` or an approval operation.

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
  "workerId": "luna-2",
  "threadId": "thread-id",
  "commit": "abc123",
  "tests": "passed",
  "reportFile": "/absolute/path/to/task-2-report.md"
}
```

Large task briefs, implementation reports, diffs, review packages, and review reports travel as file paths. They must not be copied repeatedly through the controller context.

## Persistence and artifacts

Persistent orchestration state lives under `CLAUDE_PLUGIN_DATA`, keyed by the canonical repository path and orchestration ID. The runtime may retain the existing `/tmp` fallback for standalone diagnostics, but it must warn that cross-session recovery is not guaranteed without plugin data storage.

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
│       ├── sol-review.json
│       └── re-reviews/
└── final/
    ├── review-package.md
    └── sol-review.json
```

State records include worker ID, role, status, PID, endpoint, model, effort, thread ID, turn ID, branch, worktree, base commit, head commit, artifact paths, timestamps, and the last recoverable error.

Writes use a temporary sibling file followed by atomic rename. The progress ledger records task completion, commits, review findings, fix rounds, integration decisions, and controller rulings so a compacted or restarted controller can recover without replaying completed work.

Session shutdown interrupts active turns and closes supervisors safely. It preserves orchestration records, branches, Codex thread IDs, and reports. Persistent worker state must not be removed by the existing session-job cleanup logic.

## Git worktrees and scheduling

The Claude controller owns one integration branch/worktree. Every implementation task gets a dedicated branch and worktree based on the latest accepted integration commit.

The controller derives dependencies and likely file ownership from the implementation plan. It may run tasks concurrently only when their declared dependencies are satisfied and their expected files/interfaces do not overlap. Tasks with dependencies wait until prerequisite commits have passed review and been integrated.

Luna must commit completed work and report all commit hashes, changed files, tests, and concerns. After review approval, the controller performs the mechanical cherry-pick into its integration branch. The workflow never merges into `main`, pushes, or publishes without the normal user-facing finish/approval process.

If integration conflicts:

1. keep the integration branch unchanged;
2. record the conflict in the ledger;
3. resume the owning Luna thread with the new integration base and conflict details;
4. let Luna update and verify its task branch;
5. re-review the conflict-resolution diff before integration.

## Role policies

### Luna implementer

Default role configuration:

```text
model: gpt-5.6-luna
reasoning effort: xhigh
sandbox: workspace-write
writable roots: assigned worktree only
network: restricted unless approved
thread: persistent
```

Luna reads one focused task brief, implements, tests, commits, self-reviews, and writes an implementation report. It does not spawn its own reviewers. Follow-up fixes resume the same thread for rounds one through three so it retains implementation context.

### Sol task reviewer

Default task-review configuration:

```text
model: gpt-5.6-sol
reasoning effort: high
sandbox: read-only
approval: never
thread: fresh and ephemeral
```

The reviewer receives the task brief, implementation report, review package, and binding global constraints. It does not receive the implementer's hidden reasoning or the controller's opinion of likely findings.

It returns two independent verdicts:

```text
spec compliance: pass | fail | cannot-verify
code quality: approve | changes-required
```

Every material finding has a stable ID, severity, file and line, evidence, impact, recommendation, and confidence. The supervisor validates the structured output and writes the canonical report because the reviewer itself is read-only.

### Sol final reviewer and synthesis

Final branch review and large-review synthesis use GPT-5.6 Sol at `xhigh`. Final review is flexible and on demand rather than hardwired to only one Git comparison. The development workflow recommends it before handoff, while `/codex:sol-review` permits independent invocation at any time.

## Development and review loop

For each plan task:

1. The controller extracts a focused brief and records the task base commit.
2. A Luna worker implements, tests, commits, and reports.
3. The runtime creates a review package from the exact base-to-head range.
4. A fresh Sol task reviewer checks both specification compliance and code quality.
5. The controller reads the compact verdict, opens report findings or relevant diff sections as needed, and adjudicates conflicts between the report, plan, and specification.
6. Critical and important findings, confirmed specification gaps, and controller-required changes go back to the same Luna thread.
7. Luna fixes, re-tests, commits, and appends its report.
8. A fresh Sol re-reviewer receives the open findings and the scoped fix diff. It verdicts each finding as addressed or not addressed and reports new material breakage in the fix.
9. After both verdicts pass, the controller cherry-picks the task commits into the integration branch and records completion.

Fix-loop policy:

- Rounds 1-3 resume the original Luna thread.
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
/codex:sol-review --base main
/codex:sol-review --worktree
/codex:sol-review --staged
/codex:sol-review --last 5
/codex:sol-review --range abc123..def456
/codex:sol-review --base main --path src/auth
/codex:sol-review --files src/api.ts,src/auth.ts
/codex:sol-review --audit-path src/payments
```

The review package contains a manifest, resolved refs, commit list, statistics, diff or selected source, requirements/spec references, test evidence, and target metadata. It is the reviewer's evidence boundary and is stored as a file rather than injected through the controller chat.

## Context budgets

Review context limits are runtime policy, not prompt prose. Defaults:

```text
Sol effective context budget: 258,000 tokens
Sol review-package/input budget: 190,000 tokens
Sol automatic compaction threshold: 220,000 tokens
```

The runtime passes per-thread Codex configuration equivalent to `model_context_window` and `model_auto_compact_token_limit`. It computes:

```text
effective budget = min(user-configured role budget, advertised model limit)
```

The configured 258K ceiling remains in effect when a model supports a larger window unless the user raises it. Luna has a separately configurable context budget and otherwise uses the selected model's Codex default.

Before a review starts, the package builder estimates token size with a conservative tokenizer or documented approximation. If the package exceeds the 190K input budget, it must not truncate silently or rely solely on compaction. It divides the target into explicit, non-overlapping review passes, adds a cross-cutting interfaces/tests pass where needed, and runs a fresh Sol synthesis thread over only the bounded reports. Each pass and the synthesis independently obey the context budget.

Per-task review uses `high`; final review and large-review synthesis use `xhigh`. Users may override model, effort, and budgets through plugin configuration or explicit command options.

## Permissions and approvals

Luna may freely perform reversible actions inside its assigned worktree that fit its sandbox and task. Network access, dependency installation requiring network, access outside allowed writable roots, or other escalated operations produce `needs_approval` for the Claude controller.

The app-server client must support and route relevant server-initiated approval requests instead of returning the current generic unsupported-method error. The supervisor records the exact action, reason, scope, and risk. The controller may approve routine reversible actions already authorized by the user's task. It must involve the user for destructive operations, security-sensitive actions, pushes, publishes, changes to shared external state, or meaningful scope expansion.

Sol reviewers remain read-only and never request mutation approval.

## Failure recovery

- Supervisor crash: preserve state and restart the supervisor; resume the saved thread.
- App-server crash: start a replacement app-server and resume the thread.
- Claude context compaction: recover from orchestration state, ledger, reports, branches, and Git history.
- Claude session end: interrupt active turns and close supervisors; preserve resumable state and artifacts.
- Unresponsive worker: expose status and permit interrupt or close without deleting work.
- Missing worktree: reconstruct it from the saved branch on resume.
- Dirty worktree during close: refuse removal and report the exact files requiring attention.
- Merge conflict: return the task to its owning worker and re-review the resolution.
- Invalid structured output: store raw output, mark the turn failed with a parse error, and permit a bounded retry.
- Context-budget overflow: split into review passes before inference; never truncate silently.
- Concurrency limit: queue turns and report queue position.

## Configuration

Worker-development settings extend the plugin's existing repository-keyed configuration. Defaults are explicit and versioned. Configuration includes:

- maximum concurrent Codex turns;
- implementer and reviewer model/effort;
- role-specific context, input, and compaction budgets;
- worktree root;
- supervisor startup, idle, and graceful-shutdown timeouts;
- maximum fix rounds;
- artifact retention and explicit cleanup policy;
- default review target and default branch detection behavior.

Commands may override safe per-run values. Managed or machine-level Codex restrictions remain authoritative and cannot be weakened by plugin configuration.

## Compatibility and rollout

The new worker CLI and modules are additive. Existing command output, state records, and broker behavior remain compatible. Shared refactors require regression coverage before existing commands switch to them.

Rollout stages:

1. Add generic worker state, supervisor, and explicit-thread operations behind internal commands.
2. Add interactive Luna role and worktree lifecycle.
3. Add Sol structured review and flexible target packaging.
4. Add the `codex-worker-development` orchestration skill and `/codex:develop` command.
5. Add `/codex:sol-review` and documented local-development testing.

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

Runtime integration coverage includes:

- start, message, question, response, completion, stop, close, and resume;
- server-initiated approval routing;
- supervisor and app-server crash recovery;
- concurrent workers without notification or state cross-talk;
- persistence across a simulated Claude session boundary.

Git integration coverage includes:

- isolated task branches/worktrees;
- preservation of committed branches on close;
- refusal to remove dirty worktrees;
- clean cherry-pick integration;
- conflict detection, worker repair, and reviewed resolution;
- reconstruction of a removed worktree on resume.

Review coverage includes every supported change/audit target, stable finding IDs, both required verdicts, canonical report creation, compact controller results, scoped re-review, context-budget partitioning, and synthesis.

An end-to-end fake-runtime scenario executes two independent Luna tasks, receives two Sol reviews, routes one finding through a Luna fix and scoped re-review, and verifies that the integration branch contains only approved commits.

A manual opt-in smoke test may use real Luna and Sol to validate model availability and current app-server behavior before release. It is never part of normal CI.

## Success criteria

- Fable can orchestrate up to five concurrent Codex turns without mixing worker state or notifications.
- It can message, wait for, interrupt, close, and later resume an explicitly identified Luna worker.
- Luna can return questions and approval requests at tool boundaries and continue in the same thread after a response.
- Every task runs in an isolated worktree and integrates only after controller-approved Sol review.
- Sol reports separate specification-compliance and code-quality verdicts with grounded file/line findings.
- Review supports branch, worktree, staged, unstaged, last-N, explicit range, path-filtered, file-list, and current-state audit targets.
- Sol review threads remain within their configured 258K effective context budget, splitting oversized reviews without silent truncation.
- Canonical reports and orchestration state survive controller compaction and session restart.
- Existing Codex plugin commands remain behaviorally compatible.
- The runtime is reusable by future skills without duplicating app-server or worker-management code.
