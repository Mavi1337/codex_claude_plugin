---
description: Run an independent read-only review with an explicitly selected model and effort
argument-hint: "[--base REF|--range A..B|--last N|--worktree|--staged|--unstaged|--audit-path PATH] [--path PATH|--file FILE] [--model MODEL] [--effort EFFORT]"
allowed-tools: Bash(node:*), Bash(git:*)
---

Run a review-only operation through
`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs"`.

Choose the exact model and effort before starting. Recommend
`--model gpt-6-astra --effort low` unless the user selects different values.
Luna means `gpt-5.6-luna`, Sol means `gpt-5.6-sol`, and Astra means `gpt-6-astra`.
The responsibility remains reviewer for every model. Every start must include
both flags; do not rely on config or runtime defaults. Never substitute after a
compatibility error. Astra prompting applies only to a selected `gpt-6-astra`.

Create explicit safe review and orchestration IDs, add `--cwd "$PWD" --json`,
and preserve the user's target arguments. The normal invocation is
`review start --review ID --orchestration ID --model gpt-6-astra --effort low`
plus the target. Replace both profile values with the resolved selections.
Supported targets include branch, worktree, staged, unstaged, last N, explicit
range, repeated path/file filters, and subsystem/file audit.

Return the compact verdict and canonical `reportFile`; do not fix code.
The start call returns durable `running` acceptance. Poll `review status`
with the explicit review ID until completion or failure. Report a failed review's
diagnostic, including model/effort incompatibility. If a recovered review is
`indeterminate`, retry explicitly with a new idempotency key and the same selected
model and effort. All bounded passes and synthesis retain those selections.

Raw target arguments:
`$ARGUMENTS`
