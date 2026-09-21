---
name: codex-worker-development
description: Use when an implementation plan is ready, the user asks for Codex development, or a Superpowers workflow reaches the choice of inline, subagent-driven, or Codex-worker implementation
---

# Codex Worker Development

Orchestrate focused implementers and fresh reviewers while
Claude remains controller, adjudicator, and integration owner.

**REQUIRED SUB-SKILL:** Use `codex-worker-runtime` for every runtime operation.
`implementer` and `reviewer` are responsibilities; model is a separate selection.
The normal workflow explicitly chooses `gpt-6-astra` and effort `low` for each
worker and review. Pass `--model gpt-6-astra --effort low` on every start, including
fix workers and re-reviews. The runtime has no model or effort defaults.

Honor user selections independently for implementation and review: Luna means
`--model gpt-5.6-luna`, Sol means `--model gpt-5.6-sol`, and Astra means
`--model gpt-6-astra`. Keep the role `implementer` or `reviewer`. Choose an explicit
effort for each lane (normally `low`, or the user's requested effort); include
both flags on every start. Record each selection in the ledger. Never substitute
a model or effort after a compatibility error; report it and await a new choice.

Use `gpt-6-astra-prompting` only when the selected model is `gpt-6-astra`.
For a 5.4-family model use `gpt-5-4-prompting`; for Luna, Sol, and other models use
the generic role/task contract without importing Astra-specific behavior claims.

When an implementation plan is ready, offer three implementation modes:
inline, native Claude subagent-driven development, or Codex worker development.
If the user already chose Codex development, proceed without asking again.

## Start

1. Read the plan and binding spec. Build tasks with dependencies and expected
   path ownership. If the repo carries agent instructions (`CLAUDE.md`,
   `AGENTS.md`), pass them via `--requirement` too: Implementer works in a fresh
   worktree, so test commands, interpreter paths, and commit-message rules
   only reach it that way.
2. Show task count, maximum concurrency (at most five), and separately selected
   implementer/reviewer models and efforts. The recommendation is `gpt-6-astra`
   with explicit `low`; honor any requested model and effort. Use the existing
   authorization to dispatch, or obtain it once if the run is not authorized.
3. Create a safe orchestration ID and record the integration HEAD.
4. Follow [implementation-loop.md](references/implementation-loop.md).

## Controller contract

- Dispatch only dependency-ready tasks whose expected paths do not overlap.
- Keep every worker/review/request ID and canonical report path in the progress
  ledger. Recover from those records, never chat recollection.
- Read Implementer reports and Reviewer verdicts. Independently inspect material findings or
  disputed diffs before instructing Implementer again.
- Keep rounds 1–3 in the same implementer thread. Use a fresh implementer for rounds
  4–5. After round 5, record an explicit ruling instead of looping.
- Integrate only a coordinator-created, exactly reviewed head whose two-part gate
  passes. Never merge to main, push, publish, or delete material without normal
  user authority.
- A final branch review at a raised `--effort` is recommended but remains on demand.

Use [review-contract.md](references/review-contract.md) for targets, verdicts,
fix rounds, and final review.
