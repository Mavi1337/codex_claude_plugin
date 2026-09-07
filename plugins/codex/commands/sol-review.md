---
description: Run a flexible independent GPT-6 Astra review and save its canonical report
argument-hint: "[--base REF|--range A..B|--last N|--worktree|--staged|--unstaged|--audit-path PATH] [--path PATH|--file FILE] [--effort low|medium|high|xhigh]"
allowed-tools: Bash(node:*), Bash(git:*)
---

Run a review-only operation through
`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs" review start`.

Create explicit safe review and orchestration IDs, add `--cwd "$PWD" --json`,
and preserve the user's target arguments. Supported targets include branch,
worktree, staged, unstaged, last N, explicit range, repeated path/file filters,
and subsystem/file audit. Default effort is `low`; pass `--effort` to raise it
for a standalone/final review. Return the compact verdict and canonical `reportFile`; do not fix code.
The start call returns a durable `running` acceptance. Poll `review status`
with the explicit review ID and return the final compact verdict/report path.
If a recovered review is `indeterminate`, retry explicitly with a new
idempotency key.

Raw target arguments:
`$ARGUMENTS`
