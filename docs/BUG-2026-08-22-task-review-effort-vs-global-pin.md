# Bug: task reviews fail closed when `~/.codex/config.toml` pins `model_reasoning_effort`

**Date:** 2026-08-22
**Found during:** orchestration `phase3-export-20260822` (react-flow-blockchain-tracer), first Sol task review
**File:** `plugins/codex/scripts/lib/worker-coordinator.mjs`

## Symptom

Every `review start --task-review` failed instantly (~300 ms, before any model
turn) with:

```
Codex selected effort xhigh instead of high.
```

Passing `--effort high` or `--effort xhigh` on the CLI made no difference:
task reviews hard-pin `effort: "high"` (line ~646,
`effort: params.taskReview ? "high" : (params.effort ?? "xhigh")`), so the flag
is ignored for task reviews.

## Root cause

The coordinator never *sends* the desired reasoning effort when it opens a
thread. `thread/start` / `thread/resume` (line ~486) pass `model`,
`approvalPolicy`, `sandbox`, and `config: profile.config` — but not
`profile.effort`. The thread therefore falls back to the user's global Codex
config. With `model_reasoning_effort = "xhigh"` pinned in
`~/.codex/config.toml`, the thread comes back with `reasoningEffort: "xhigh"`,
and the compatibility check at line ~497 correctly fails closed on the
mismatch.

Luna workers (xhigh) and non-task Sol reviews (default xhigh) happen to match
the pin, so only task reviews (high) break — which makes the failure look like
a review-machinery bug rather than a config interaction.

## Fix applied locally (this worktree)

In `startWorker`'s thread open calls, merge the requested effort into the
config override map so the thread always honors the coordinator's request
regardless of the global pin:

```js
config: { ...(profile.config ?? {}), model_reasoning_effort: profile.effort }
```

applied to both the `thread/resume` and `thread/start` requests. Verified: the
same task review that failed three times ran to completion afterwards.

## Suggested upstream fix

Same as above, or send effort as a first-class `thread/start` parameter if the
app-server protocol grows one. The compatibility check at line ~497 should
stay — it did its job; the request side was the gap.

## Related operational note

`coordinator restart` disconnects live Luna workers; a subsequent
`worker send` fails with `Worker <id> is not connected.` and needs
`worker resume --worker ID` first. The runtime skill documents this for
plugin edits, but the error only surfaces at the *next* send, after the turn
is reported `failed` with the stale previous report still in `lastOutput` —
easy to misread as a completed round.
