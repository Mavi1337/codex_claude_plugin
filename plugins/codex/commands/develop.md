---
description: Implement a written plan with interactive implementers and independent reviewers
argument-hint: "<plan-file> [--model MODEL] [--effort EFFORT] [--review-model MODEL] [--review-effort EFFORT] [--concurrency 1-5] [--final-review|--no-final-review]"
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Skill
---

Use the `codex-worker-development` skill to execute the supplied implementation
plan. Load and follow its required `codex-worker-runtime` sub-skill.

Raw request:
`$ARGUMENTS`

Before dispatch, show the resolved task count, concurrency cap, implementer
and reviewer models/efforts (recommend `gpt-6-astra/low`), and whether
an on-demand final review is selected. Resolve `--model`/`--effort` for both lanes,
then apply `--review-model`/`--review-effort` to the review lane when supplied.
Include the resolved `--model` and `--effort` on every worker/review start;
normally `--model gpt-6-astra --effort low`. These are orchestration choices;
the runtime never defaults them. Ask once for authorization unless
the user already explicitly authorized this exact run. Then continue through
implementation, task review, fixes, and reviewed integration; do not stop after
merely starting workers.
