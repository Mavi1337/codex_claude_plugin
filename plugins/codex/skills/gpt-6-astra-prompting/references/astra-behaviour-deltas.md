# Astra Behaviour Deltas

Why the extra blocks exist. Source: OpenAI's GPT-6 Astra guide,
`https://developers.openai.com/api/docs/guides/latest-model.md`, read 2026-09-07.
API-surface material in that page (transport, request parameters, migration) is
deliberately omitted — this plugin drives Astra through the Codex CLI.

Model facts are quoted or paraphrased from that page. Everything under "In this
plugin" is this repository's own observation and is labelled as such.

## 1. It asks more

The model "is more likely to ask the user a question when additional input could
materially change the result." OpenAI's own remedy is prompt-side: tell it to
infer intent and scope, treat request phrasing as instruction, and finish the
authorized work before asking.

*In this plugin:* a Luna worker has no user to answer it. A question mid-turn is
a held concurrency slot and a coordinator round. The `pendingRequest` field in
`worker status` is where these surface. `initiative_and_scope` is the fix; a
higher `--effort` is not.

## 2. It weighs context more heavily

The model "can also be more sensitive to information in context." OpenAI's remedy
is an explicit precedence statement, plus a transparency rule: when an instruction
file causes it to pause or diverge, it should name the exact file it read.

*In this plugin:* workers are started with `--requirement CLAUDE.md`, which in
this repository is ~66 KB of hard-won rules. That file *should* usually win — but
when a brief deliberately deviates, the deviation has to be stated or Astra will
resolve the conflict in the file's favour and report success against the wrong
target. `instruction_precedence` makes the resolution explicit either way.

## 3. It formats heavily

The model "tends toward detailed, formatted responses." OpenAI recommends asking
for clear paragraphs, lists only where items are genuinely parallel, and naming
the filler vocabulary to avoid.

*In this plugin:* the implementation report is a JSON structure the coordinator
reads field by field. Prose that expands to fill it makes the real content harder
to find, and long reports are the output side of a turn's token cost.

## 4. It calibrates testing on its own

The guide's verification advice is that the model should "not write tests for
reversible, low-impact changes that mirror the implementation" and that tests it
does write should be "meaningful and necessary."

**This is the one place where the model guide and this repository disagree, and
the repository wins.** The house rule is that every fix needs at least one test
that fails when the fix is removed, and that you only know which tests those are
by actually reverting. A model deciding on its own that a change is too small to
test produces exactly the defect class this repository has already paid for
repeatedly: a test that cannot fail for the reason its title claims.

`verification_calibration` states the stricter rule explicitly rather than hoping
the requirement file carries it — which is delta 2 applied to delta 4.

## 5. Delegation

The guide encourages parallel delegation to other agents and, because those
messages may be read by a human, explicitly asks for legible text with proper
spacing.

*In this plugin:* Luna workers do not spawn sub-agents, so `delegation_legibility`
is inert for them. It applies to Opus subagents and to any future role that can
fan out.

## What did not change

Operator tone, one job per run, XML block structure, a stated end state, and
"tighten the contract before raising reasoning" all carry over from the 5.4 guide
unchanged. Astra changes the default contents of a brief, not the method of
writing one.
