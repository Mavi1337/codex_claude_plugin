---
description: Run a flexible independent GPT-5.6 Sol review and save its canonical report
argument-hint: "[--base REF|--range A..B|--last N|--worktree|--staged|--unstaged|--audit-path PATH] [--path PATH|--file FILE] [--effort high|xhigh]"
allowed-tools: Bash(node:*), Bash(git:*)
---

Run a review-only operation through
`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs" review start`.

Create explicit safe review and orchestration IDs, add `--cwd "$PWD" --json`,
and preserve the user's target arguments. Supported targets include branch,
worktree, staged, unstaged, last N, explicit range, repeated path/file filters,
and subsystem/file audit. Default effort is xhigh for this standalone/final
review. Return the compact verdict and canonical `reportFile`; do not fix code.

Raw target arguments:
`$ARGUMENTS`
