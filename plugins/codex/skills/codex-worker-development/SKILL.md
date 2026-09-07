---
name: codex-worker-development
description: Use when an implementation plan is ready, the user asks for Codex development, or a Superpowers workflow reaches the choice of inline, subagent-driven, or Codex-worker implementation
---

# Codex Worker Development

Orchestrate focused Luna implementation workers and fresh Sol reviewers while
Claude remains controller, adjudicator, and integration owner.

**REQUIRED SUB-SKILL:** Use `codex-worker-runtime` for every runtime operation.
Compose the first Luna message with `gpt-6-astra-prompting`, which is also the
guide for Sol review briefs — both roles run `gpt-6-astra`. Use
`gpt-5-4-prompting` only for a run pinned to a 5.4-family model with `--model`.

When an implementation plan is ready, offer three implementation modes:
inline, native Claude subagent-driven development, or Codex worker development.
If the user already chose Codex development, proceed without asking again.

## Start

1. Read the plan and binding spec. Build tasks with dependencies and expected
   path ownership. If the repo carries agent instructions (`CLAUDE.md`,
   `AGENTS.md`), pass them via `--requirement` too: Luna works in a fresh
   worktree, so test commands, interpreter paths, and commit-message rules
   only reach it that way.
2. Show task count, maximum concurrency (at most five), Luna
   and review models (`gpt-6-astra`, effort `low` unless `--effort` raises it).
   Obtain one authorization to dispatch.
3. Create a safe orchestration ID and record the integration HEAD.
4. Follow [implementation-loop.md](references/implementation-loop.md).

## Controller contract

- Dispatch only dependency-ready tasks whose expected paths do not overlap.
- Keep every worker/review/request ID and canonical report path in the progress
  ledger. Recover from those records, never chat recollection.
- Read Luna reports and Sol verdicts. Independently inspect material findings or
  disputed diffs before instructing Luna again.
- Keep rounds 1–3 in the same Luna thread. Use a fresh implementer for rounds
  4–5. After round 5, record an explicit ruling instead of looping.
- Integrate only a coordinator-created, exactly reviewed head whose two-part gate
  passes. Never merge to main, push, publish, or delete material without normal
  user authority.
- A final branch review at a raised `--effort` is recommended but remains on demand.

Use [review-contract.md](references/review-contract.md) for targets, verdicts,
fix rounds, and final review.
