---
name: gpt-6-astra-prompting
description: Internal guidance for composing prompts when the selected model is GPT-6 Astra
user-invocable: false
---

# GPT-6 Astra Prompting

Use this skill only when the selected model is `gpt-6-astra`, for either an
implementer brief or reviewer brief. Roles do not select a model. Luna, Sol and
other model selections must not inherit Astra-specific behavior claims.

Use [gpt-5-4-prompting](../gpt-5-4-prompting/SKILL.md) instead only when the run
is explicitly pinned to a 5.4-family model with `--model`, as `codex-rescue`
permits.

Everything in the 5.4 skill still applies: operator tone, one job per run, XML
blocks, a stated end state, better contracts before more reasoning. Astra changes
what the *default* prompt must contain, not the method. The blocks in
[references/prompt-blocks.md](../gpt-5-4-prompting/references/prompt-blocks.md)
remain the base set; this skill adds five.

## What is different about Astra

Four behaviours change how a brief must be written. Each is sourced and each has
one prompt consequence.

| Behaviour | Consequence for the brief |
|---|---|
| Asks the user a question whenever more input could materially change the result | Ship `initiative_and_scope` in every write-capable brief, or the worker stalls on a question the coordinator already answered |
| More sensitive to information in context | Rank the inputs explicitly with `instruction_precedence`; a large `--requirement` file otherwise outranks the brief |
| Tends toward detailed, heavily formatted answers | Pair the output contract with `prose_style`, or reports arrive as nested bullet trees |
| Applies its own test-economy judgement | State the repository's testing rule with `verification_calibration`; Astra will otherwise skip tests it considers low-value |

Detail and sources: [references/astra-behaviour-deltas.md](references/astra-behaviour-deltas.md).

## Default brief shape

For an implementer implementation brief, in this order:

1. `task` — the job, the paths, the end state.
2. `instruction_precedence` — brief over requirement files over model defaults.
3. `structured_output_contract` — plus `prose_style`.
4. `initiative_and_scope` — what to decide alone, what to stop for.
5. `completeness_contract`, `verification_loop`, `verification_calibration`.
6. `action_safety`, `missing_context_gating`.

For a Reviewer or adversarial review: `task`, `instruction_precedence`,
`grounding_rules`, `structured_output_contract` + `prose_style`,
`dig_deeper_nudge`, `verification_loop`.

New blocks live in [references/astra-prompt-blocks.md](references/astra-prompt-blocks.md).
Assembled briefs for both roles live in [references/astra-brief-recipes.md](references/astra-brief-recipes.md).

## Working rules

- **Keep briefs to three or four items.** Brief size is the cost lever, not
  effort. The workflow recommends explicit `--effort low`; the coordinator checks
  the selected effort against `model/list` and never substitutes a fallback.
- **Do not raise effort to fix a stalling worker.** A worker that asks instead of
  acting needs `initiative_and_scope`, not more reasoning.
- **Name the authority when inputs can conflict.** Astra reads a passed
  `CLAUDE.md` or `AGENTS.md` closely. If the brief overrides it, say so in the
  brief; if the file overrides the brief, say that instead.
- **Ask for the revert-proof table, not for "tests".** Astra reports what it was
  asked to report. See `verification_calibration`.
- **Send follow-ups into the warm thread.** `worker send` on a live thread costs
  a delta; a thread resumed after a session gap re-reads its whole context at
  full price. Send only what changed, not a restated brief, unless the direction
  changed materially.
- **Never accept a suite claim.** The coordinator re-runs every number itself.
  This is a process rule, not a model property, and no prompt block replaces it.
