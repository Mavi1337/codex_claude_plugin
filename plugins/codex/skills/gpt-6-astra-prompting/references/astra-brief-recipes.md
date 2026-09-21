# Astra Brief Recipes

Assembled starting points. Copy the one that fits, fill the bracketed parts, and
delete any block whose behaviour cannot arise in this task.

Keep a brief to three or four work items. Brief size is the cost lever: a
seven-item turn in this repository cost 82 model requests and 4.33M cumulative
input tokens and exhausted a usage window; a three-item turn cost a fraction of
that at the same effort.

## Implementer brief (first message of a task)

```xml
<task>
[The job, in one or two sentences. Name the files or directories.]
Work only inside [allowed paths].
Done means: [the observable end state — a passing suite at a stated floor, a
named behaviour, a committed shape].
Items, in order:
1. [item]
2. [item]
3. [item]
</task>

<instruction_precedence>
Authority, highest first: this brief; then the requirement files passed with the
task; then your own defaults.
Where this brief and a requirement file conflict, follow the brief and say in your
report which file you overrode and at which line.
Where a requirement file forbids something this brief did not mention, follow the
file.
If any instruction makes you pause, ask permission, or leave work unfinished, name
the exact file and line that caused it.
</instruction_precedence>

<initiative_and_scope>
Infer the task scope from this brief and the repository. Bias toward action and
carry the task to completion.
Before asking anything, finish the work this brief already authorizes. Then ask
the question in your final report rather than stopping mid-turn.
Stop mid-turn only for a destructive or irreversible action, or a missing fact
without which the change would be wrong rather than merely different.
Decisions already taken, do not re-open: [list them].
</initiative_and_scope>

<verification_calibration>
Every behavioural change in this task needs at least one test that fails when the
change is reverted. Do not decide for yourself that a change is too small to test.
Prove it: revert the change, record which test reddened and its assertion, then
restore.
Report this as a table: finding | what you removed | which test reddened.
A mutation that survived is a finding, not a pass.
</verification_calibration>

<structured_output_contract>
Return:
1. what changed, per file
2. the revert-proof table
3. the exact command you ran and its final counts, before and after
4. residual risks and anything you left undone
</structured_output_contract>

<prose_style>
Short paragraphs, one idea each. Lists only where items are genuinely parallel.
No preamble, no restatement of this brief, no closing summary.
</prose_style>

<action_safety>
Keep changes inside [allowed paths]. No unrelated refactors, renames, or cleanup.
Call out any irreversible action before taking it.
</action_safety>

<missing_context_gating>
Do not guess repository facts. Read the file, or state exactly what remains
unknown.
Run the suite yourself; do not report a count you did not observe.
</missing_context_gating>
```

## Follow-up into a warm thread

Send the delta only. Do not restate the brief — the thread still holds it, and
restating it costs a full re-read.

```xml
<task>
Round [n]. [What is wrong or what changed, in one or two sentences.]
Fix: [the specific items].
Everything else from the previous round stands.
</task>

<verification_calibration>
Re-run the full suite and report the counts you observed, not the previous
round's. Extend the revert-proof table with the new items.
</verification_calibration>
```

## Reviewer brief

The reviewer sees the frozen package, including any supplied task brief,
requirements and implementation report. State the evidence boundary accurately;
do not claim that supplied documents are absent.

```xml
<task>
Review this change for material correctness and regression risk.
Evidence available: [the frozen package and its included requirements].
Known limits: [any context intentionally outside the requested scope].
Use cannot-verify when required evidence is missing.
</task>

<instruction_precedence>
Authority, highest first: this brief; then the requirement files; then your own
defaults.
</instruction_precedence>

<grounding_rules>
Ground every claim in the diff or your tool outputs. Label inferences as
inferences.
For each finding, give the concrete inputs or state that produce the wrong
outcome. A finding you cannot make concrete is a question, not a finding.
</grounding_rules>

<dig_deeper_nudge>
After the first plausible issue, check second-order failures, empty state,
retries, stale state, concurrent callers, and rollback paths.
Check whether each new test can fail for the reason its title claims. A test
whose fixture severs the relationship it names is a finding.
</dig_deeper_nudge>

<structured_output_contract>
Return findings ordered by severity: claim, evidence, failure scenario, smallest
fix. Empty list if none survive.
</structured_output_contract>

<prose_style>
Short paragraphs. No preamble, no closing summary.
</prose_style>
```
