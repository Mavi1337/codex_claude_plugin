# Changelog

## 1.0.11

- Separate implementer/reviewer responsibilities from model identity. Require an
  explicit model and effort at CLI and coordinator boundaries, validate paginated
  model discovery, and retain exact selections through start, resume, review
  passes and synthesis. No model or effort fallback.
- Recommend Astra explicitly in orchestration, while supporting Luna, Sol and
  future discovered models independently of role. Apply Astra prompting only
  when Astra is selected.
- Add `/codex:worker-review`; retain `/codex:sol-review` as a legacy alias. Rename
  active prompts, reviewer schema, report language and finding IDs generically.
  Existing persisted luna/sol workers normalize on resume without changing their
  saved model/effort, worker ID or thread ID.

## Earlier worker-runtime additions

- Add `/codex:develop` for interactive, resumable worker development with
  isolated worktrees and trusted coordinator commits.
- Add flexible branch, worktree, range, file, and audit reviews with bounded
  context and synthesis.
- Add a repository-scoped coordinator with explicit worker IDs, typed blocking
  request resolution, five-turn scheduling, durable reports, and reviewed Git
  integration.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
