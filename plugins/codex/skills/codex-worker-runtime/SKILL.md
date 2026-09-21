---
name: codex-worker-runtime
description: Use when a Claude Code workflow needs multiple interactive, explicitly addressed, resumable Codex workers or independent Reviews
user-invocable: false
---

# Codex Worker Runtime

Use the plugin-owned coordinator through one adapter:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs" <group> <operation> --cwd "$PWD" --json ...
```

Every worker, review, request, and orchestration has an explicit ID. Preserve
those IDs in the controller ledger; never substitute “latest.” The coordinator
owns app-server connections, concurrency, artifacts, worktrees, commits, and
integration.

## Operations

| Need | Operation and required options |
|---|---|
| Start implementer | `worker start --worker ID --orchestration ID --role implementer --model gpt-6-astra --effort low --allowed-path PATH... --requirement FILE... [--base REF]` |
| Start reviewer | `worker start --worker ID --orchestration ID --role reviewer --model gpt-6-astra --effort low` |
| Message | `worker send --worker ID --prompt TEXT --idempotency-key KEY` |
| Observe | `worker wait\|status --worker ID`; `worker list` |
| Blocking callback | `worker resolve-request --request ID --result-json JSON --idempotency-key KEY` |
| Interrupt/lifecycle | `worker stop\|close\|resume --worker ID` |
| Trusted commit | `integration commit --worker ID --message TEXT --allowed-path PATH...` |
| Task review | `review start --review ID --orchestration ID --model gpt-6-astra --effort low --worker ID --task-review` |
| Flexible review | `review start --review ID --orchestration ID --model gpt-6-astra --effort low` plus one target |
| Controller ruling on a review | `review rule --review ID --reason TEXT [--waive-cannot-verify]` |
| Controller ruling without a review | `integration rule --worker ID --reason TEXT` |
| Integrate | `integration apply --worker ID --expected-head OID` |
| Reload edited plugin code | `coordinator restart [--force]` |

`--allowed-path` accepts files or directories; a directory covers everything
beneath it, and a rename is inside the assignment only when both its source and
destination are covered. The paths passed to `integration commit` must still
match the worker's `worker start` assignment exactly.

An implementer worktree is branched from `--base`, defaulting to `HEAD` of the integration
checkout. Pass `--base` when the task builds on work that is not on the
integration branch yet — a sibling worker's branch, for instance. Without it a
second worker cannot see the first one's commits, which is silent: the worker
simply does not find the code the brief describes.

The coordinator stays bound to the integration checkout. `--cwd` must always name
that checkout; pointing it at a worktree is refused and is unrelated to `--base`.

Review targets are `--base REF`, `--range A..B`, `--last N`, `--worktree`,
`--staged`, `--unstaged`, repeated `--path`/`--file`, or repeated
`--audit-path`. Reports are returned as canonical file paths.

Roles express responsibility and permissions: `implementer` uses an isolated
worktree, workspace-write and on-request approvals; `reviewer` uses read-only,
ephemeral threads and never approves mutations. Neither role selects a model.
Both model and effort are mandatory on every worker/review start, including
coordinator protocol calls. The examples explicitly recommend Astra/low.
When requested, replace the model with `gpt-5.6-luna`, `gpt-5.6-sol`, or any exact
identifier exposed by `model/list`, and pass the chosen supported `--effort`.
The coordinator checks discovery and forwards those exact values on thread
start/resume and every turn. It never substitutes either value. Review passes,
repair turns and synthesis retain the review's explicit model and effort.

Resume reuses the persisted profile, with no fallback to current recommendations.
Saved roles `luna`/`sol` migrate to `implementer`/`reviewer` on successful
`worker resume --worker ID`; legacy roles are rejected on new starts. Use
`/codex:worker-review` for standalone reviews; `/codex:sol-review` is a legacy alias.

## Interaction contract

- A completed `needs_input` result accepts a later `worker send`.
- `waiting-input` or `waiting-approval` is an active app-server callback. Answer
  its `pendingRequest.id` with `worker resolve-request`; do not use `send`.
- Ask the user before destructive, security-sensitive, publishing, external
  state, or scope-expanding decisions. Routine reversible actions already
  authorized by the task may be resolved by the controller.
- `close` preserves thread/branch state. `resume` restores that explicit worker.
- Implementer edits/tests; only `integration commit` writes Git metadata.
- The first Implementer message becomes the canonical task brief; later messages are
  hashed follow-up instructions. A task review fails closed unless the worker
  completed with a validated implementation report, test evidence, concerns,
  an explicit allowed-path assignment, and immutable copies of every binding
  plan/spec/requirement supplied with `--requirement`.
- `review start` returns a durable `running` acceptance immediately. Poll
  `review status --review ID` until `completed`, `stale`, `failed`, or
  `indeterminate`; retry an indeterminate review with a new idempotency key.
- Only apply after the returned review gate is `pass`, using the integration
  HEAD captured immediately before the operation. The runtime rechecks the
  reviewed package hash and exact base/head/tree under the integration lease.
- When the user opts out of Reviews entirely, `integration rule --worker ID
  --reason TEXT` records an explicit controller ruling in the ledger and binds
  the exact committed base/head/tree, which `integration apply` then honours.
  Ask the user before ruling; a ruling replaces independent review, so say so.
  Any later `integration commit` invalidates the ruling, exactly as it
  invalidates a Reviewer binding.

## Observing a long turn

- `worker wait --worker ID --timeout 0` blocks until the turn leaves
  `queued`/`running` with no deadline of its own. Run it as one background
  command rather than polling: the client uses bounded slices and reconnects
  after a shared coordinator disruption. A forced coordinator restart still
  requires `worker resume --worker ID` before the next `worker send`.
- A failed turn reports `turnError` at the head of the `wait`/`status` payload
  as well as in `turn.error`. Read it before assuming the worker misbehaved —
  an API rejection surfaces here.
- Implementer narrates progress while still running. Treat only a terminal turn status
  as completion, never the text of `lastOutput`.

## Environment the worker will not have

- A task worktree is created from a commit, so untracked, ignored, and
  uncommitted files — `.venv`, `.env`, generated data — are absent. `worker
  start` returns `absentInputs` listing what the integration checkout holds and
  the worktree will not.
- Put absolute interpreter, environment, and data paths in the brief, and pass
  repository agent instructions (`CLAUDE.md`, `AGENTS.md`) with `--requirement`.

## After editing the plugin

The coordinator is a daemon that loads schemas, prompts, and its module graph
once at startup. After changing plugin files run `coordinator restart`; it
refuses to disrupt live turns or waits unless `--force` is explicit. After a
forced restart, run `worker resume --worker ID` before the next `worker send`.
