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
| Start Luna | `worker start --worker ID --orchestration ID` |
| Message | `worker send --worker ID --prompt TEXT --idempotency-key KEY` |
| Observe | `worker wait\|status --worker ID`; `worker list` |
| Blocking callback | `worker resolve-request --request ID --result-json JSON --idempotency-key KEY` |
| Interrupt/lifecycle | `worker stop\|close\|resume --worker ID` |
| Trusted commit | `integration commit --worker ID --message TEXT [--allowed-path PATH]...` |
| Task review | `review start --review ID --orchestration ID --worker ID --task-review` |
| Flexible review | `review start --review ID --orchestration ID` plus one target |
| Integrate | `integration apply --worker ID --expected-head OID` |

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
- Only apply after the returned review gate is `pass`, using the integration
  HEAD captured immediately before the operation.
