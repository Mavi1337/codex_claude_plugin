---
description: Legacy alias for worker-review; select the model and effort independently
argument-hint: "[review target options] [--model MODEL] [--effort EFFORT]"
allowed-tools: Read, Bash(node:*), Bash(git:*)
---

This is a legacy alias for `/codex:worker-review`. Read
`${CLAUDE_PLUGIN_ROOT}/commands/worker-review.md` and execute its instructions
with the arguments below; do not invoke this alias recursively.
The name does not select Sol. Follow the generic command's model selection:
normally `--model gpt-6-astra --effort low`, or the user's explicit model and
effort, both supplied on every start. Recommend `/codex:worker-review` for new use.

Raw target arguments:
`$ARGUMENTS`
