---
description: Implement a written plan with interactive Luna workers and independent Sol reviews
argument-hint: "<plan-file> [--concurrency 1-5] [--final-review|--no-final-review]"
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Skill
---

Use the `codex-worker-development` skill to execute the supplied implementation
plan. Load and follow its required `codex-worker-runtime` sub-skill.

Raw request:
`$ARGUMENTS`

Before dispatch, show the resolved task count, concurrency cap, Luna
and review models (`gpt-6-astra/low` unless `--effort` raises them), and whether
an on-demand final review at a higher effort is selected. Ask once for authorization unless
the user already explicitly authorized this exact run. Then continue through
implementation, task review, fixes, and reviewed integration; do not stop after
merely starting workers.
