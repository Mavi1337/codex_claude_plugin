---
name: codex-worker-runtime
description: Use when a Claude Code workflow needs multiple interactive, explicitly addressed, resumable Codex workers or independent Sol reviews
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
| Start Luna | `worker start --worker ID --orchestration ID --allowed-path PATH... --requirement FILE...` |
| Message | `worker send --worker ID --prompt TEXT --idempotency-key KEY` |
| Observe | `worker wait\|status --worker ID`; `worker list` |
| Blocking callback | `worker resolve-request --request ID --result-json JSON --idempotency-key KEY` |
| Interrupt/lifecycle | `worker stop\|close\|resume --worker ID` |
| Trusted commit | `integration commit --worker ID --message TEXT --allowed-path PATH...` |
| Task review | `review start --review ID --orchestration ID --worker ID --task-review` |
| Flexible review | `review start --review ID --orchestration ID` plus one target |
| Controller ruling on a review | `review rule --review ID --reason TEXT [--waive-cannot-verify]` |
| Controller ruling without a review | `integration rule --worker ID --reason TEXT` |
| Integrate | `integration apply --worker ID --expected-head OID` |
| Reload edited plugin code | `coordinator restart [--force]` |

`--allowed-path` accepts files or directories; a directory covers everything
beneath it, and a rename is inside the assignment only when both its source and
destination are covered. The paths passed to `integration commit` must still
match the worker's `worker start` assignment exactly.

Review targets are `--base REF`, `--range A..B`, `--last N`, `--worktree`,
`--staged`, `--unstaged`, repeated `--path`/`--file`, or repeated
`--audit-path`. Add `--effort xhigh` for final review; task review defaults to
high. Reports are returned as canonical file paths.

## Interaction contract

- A completed `needs_input` result accepts a later `worker send`.
- `waiting-input` or `waiting-approval` is an active app-server callback. Answer
  its `pendingRequest.id` with `worker resolve-request`; do not use `send`.
- Ask the user before destructive, security-sensitive, publishing, external
  state, or scope-expanding decisions. Routine reversible actions already
  authorized by the task may be resolved by the controller.
- `close` preserves thread/branch state. `resume` restores that explicit worker.
- Luna edits/tests; only `integration commit` writes Git metadata.
- The first Luna message becomes the canonical task brief; later messages are
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
- When the user opts out of Sol reviews entirely, `integration rule --worker ID
  --reason TEXT` records an explicit controller ruling in the ledger and binds
  the exact committed base/head/tree, which `integration apply` then honours.
  Ask the user before ruling; a ruling replaces independent review, so say so.
  Any later `integration commit` invalidates the ruling, exactly as it
  invalidates a Sol binding.

## Observing a long turn

- `worker wait --worker ID --timeout 0` blocks until the turn leaves
  `queued`/`running` with no deadline of its own. Run it as one background
  command rather than polling: the client uses bounded slices and reconnects
  after a shared coordinator disruption. A forced coordinator restart still
  requires `worker resume --worker ID` before the next `worker send`.
- A failed turn reports `turnError` at the head of the `wait`/`status` payload
  as well as in `turn.error`. Read it before assuming the worker misbehaved —
  an API rejection surfaces here.
- Luna narrates progress while still running. Treat only a terminal turn status
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
