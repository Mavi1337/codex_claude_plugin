# Codex Worker Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, interactive, resumable implementer/reviewer worker runtime to the existing Claude Code Codex plugin.

**Revision:** 2026-09-21. Roles and model identities are independent. The current
increment is tracked in `2026-09-21-model-role-separation.md`; this original plan
records the architecture, not a request to reimplement already completed modules.

**Architecture:** One detached coordinator per Git common repository owns all direct app-server clients, scheduling, blocking server requests, durable state, artifacts, and Git integration. Claude-facing commands and skills are thin clients; Implementer edits in isolated worktrees, the coordinator commits, and fresh read-only Reviewer turns review immutable packages.

**Tech Stack:** Node.js ESM, newline-delimited JSON-RPC, Codex app-server, Git worktrees, JSON Schema, Claude Code plugin commands/skills, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-18-codex-worker-development-design.md`

## Global Constraints

- Existing commands and installed plugin-cache files remain unchanged.
- Repository-wide inference concurrency defaults to five.
- `implementer` is workspace-write in an isolated worktree with `on-request` approvals; it never writes Git metadata.
- `reviewer` is read-only, ephemeral and uses approval policy `never`.
- Every start requires model and effort, validated against paginated `model/list`
  and forwarded exactly. Orchestration explicitly recommends Astra/low; requested
  Luna, Sol or other exposed models work for either role. Review passes and
  synthesis retain the selection. Astra prompting applies only to Astra.
- Only saved legacy luna/sol records migrate on resume; new legacy roles fail.
- The coordinator is the sole durable-state, artifact, scheduler, and integration writer.
- All Git commands use argv arrays with no shell; hooks and signing are disabled for coordinator commits.
- Review input defaults to 190K tokens within a 258K conservative cap and never truncates silently.

---

### Task 1: Protocol, repository identity, and durable store

**Files:**
- Create: `plugins/codex/scripts/lib/worker-protocol.mjs`
- Create: `plugins/codex/scripts/lib/worker-state.mjs`
- Test: `tests/worker-protocol.test.mjs`
- Test: `tests/worker-state.test.mjs`

**Interfaces:**
- Produces: `resolveRepositoryIdentity(cwd)`, `validateEnvelope(value)`, `createWorkerStore(cwd, options)` with `load()`, `transaction(fn)`, and artifact helpers.

- [ ] Write failing tests for linked-worktree identity, invalid IDs/tokens/envelopes, strict corruption handling, revisions, backup recovery, owner-only modes, and active-record retention.
- [ ] Run `node --test tests/worker-protocol.test.mjs tests/worker-state.test.mjs`; verify failures identify missing modules.
- [ ] Implement canonical common-git identity, versioned envelopes, size limits, schema-versioned state, single-writer revision checks, atomic durable replacement, backups, and safe artifact paths.
- [ ] Re-run the focused tests, then `npm test`.
- [ ] Commit `feat: add worker protocol and durable state`.

### Task 2: App-server blocking request support and coordinator scheduling

**Files:**
- Modify: `plugins/codex/scripts/lib/app-server.mjs`
- Create: `plugins/codex/scripts/lib/worker-coordinator.mjs`
- Create: `plugins/codex/scripts/codex-worker-coordinator.mjs`
- Test: `tests/app-server-requests.test.mjs`
- Test: `tests/worker-coordinator.test.mjs`
- Modify: `tests/fake-codex-fixture.mjs`

**Interfaces:**
- Produces: `client.setServerRequestHandler(handler)`, `client.respondToServerRequest(id, result)`, `WorkerCoordinator.dispatch(envelope)`, coordinator `serve` entry point.

- [ ] Write failing tests where the fake app-server blocks on typed input/approval, duplicate/stale decisions fail safely, FIFO scheduling never exceeds five, and restart marks active turns indeterminate.
- [ ] Run focused tests and confirm behavioral failures.
- [ ] Add server-request callbacks/responses without changing legacy default rejection. Implement coordinator worker/thread/turn/request state machines, idempotency cache, queue slots, direct app-server ownership, interrupt/close/resume, and state persistence.
- [ ] Re-run focused tests and the legacy broker/runtime suite.
- [ ] Commit `feat: add interactive worker coordinator`.

### Task 3: Secure local IPC and worker CLI

**Files:**
- Create: `plugins/codex/scripts/lib/worker-coordinator-lifecycle.mjs`
- Create: `plugins/codex/scripts/codex-workers.mjs`
- Test: `tests/codex-workers-cli.test.mjs`

**Interfaces:**
- Produces CLI operations `worker start|send|wait|status|list|stop|close|resume|resolve-request` and `coordinator status|shutdown` with JSON output.

- [ ] Write failing CLI tests for lazy coordinator startup, repository/token binding, explicit IDs, idempotent retries, one-response stdout, exit classes, frame limits, and five-worker isolation.
- [ ] Run the focused test and verify failures.
- [ ] Implement short owner-only endpoints, detached startup/reconciliation, authenticated envelopes, bounded waits, argument validation, and compact rendering.
- [ ] Re-run focused and full tests.
- [ ] Commit `feat: expose interactive codex worker cli`.

### Task 4: Worktrees and trusted Git authority

**Files:**
- Create: `plugins/codex/scripts/lib/worker-worktree.mjs`
- Test: `tests/worker-worktree.test.mjs`
- Modify: `plugins/codex/scripts/lib/worker-coordinator.mjs`

**Interfaces:**
- Produces: `createTaskWorktree`, `inspectTaskWorktree`, `commitTaskWorktree`, `applyReviewedCommits`, `closeTaskWorktree`.

- [ ] Write failing real-Git tests for isolated branches, common-repo identity, path validation, exact staged tree, hook/signing disablement, dirty/ignored cleanup refusal, ancestry/merge rejection, CAS integration, and conflict abort.
- [ ] Run the focused test and verify failures.
- [ ] Implement shell-free worktree lifecycle and coordinator-only commit/apply operations, persisting full base/head/tree/commit IDs and reviewed manifest hash.
- [ ] Re-run Git and full suites.
- [ ] Commit `feat: add trusted worker git integration`.

### Task 5: Immutable review engine and schemas

**Files:**
- Create: `plugins/codex/scripts/lib/review-target.mjs`
- Create: `plugins/codex/scripts/lib/review-package.mjs`
- Create: `plugins/codex/schemas/worker-turn-output.schema.json`
- Create: `plugins/codex/schemas/reviewer-output.schema.json`
- Create: `plugins/codex/prompts/implementer.md`
- Create: `plugins/codex/prompts/task-reviewer.md`
- Create: `plugins/codex/prompts/re-reviewer.md`
- Create: `plugins/codex/prompts/branch-reviewer.md`
- Test: `tests/worker-review.test.mjs`

**Interfaces:**
- Produces: `resolveWorkerReviewTarget`, `freezeReviewPackage`, `validateWorkerResult`, `validateReviewerOutput`, `evaluateReviewGate`, coordinator `review start|status|result`.

- [ ] Write failing tests for all target modes, immutable hashes, skipped-path manifests, repeatable file filters, schema/stable IDs, gate truth table, conservative budget accounting, partition coverage, and generic read-only `turn/start`.
- [ ] Run the focused test and verify failures.
- [ ] Implement target freezing, manifests/packages, schema validation, bounded raw-output handling, role prompts, pass partitioning, synthesis, reports, and coordinator review operations.
- [ ] Re-run focused and full tests.
- [ ] Commit `feat: add structured worker review engine`.

### Task 6: Claude commands and skills

**Files:**
- Create: `plugins/codex/commands/develop.md`
- Create: `plugins/codex/commands/worker-review.md`
- Preserve: `plugins/codex/commands/sol-review.md` as a legacy alias
- Create: `plugins/codex/skills/codex-worker-runtime/SKILL.md`
- Create: `plugins/codex/skills/codex-worker-development/SKILL.md`
- Create: `plugins/codex/skills/codex-worker-development/references/implementation-loop.md`
- Create: `plugins/codex/skills/codex-worker-development/references/review-contract.md`
- Modify: `tests/commands.test.mjs`

**Interfaces:**
- Produces explicit `/codex:develop`, `/codex:worker-review`, the legacy alias, reusable runtime skill, and discoverable implementation workflow.

- [ ] Run fresh-context baseline scenarios without the new skill and record failures to discover/use explicit worker IDs, resolve blocking requests correctly, and preserve controller review authority.
- [ ] Add failing command-structure tests for thin CLI delegation, cost/concurrency preview, plan-task loop, canonical report handling, and Superpowers implementation-stage discovery wording.
- [ ] Implement the minimum skill/command text that corrects the baseline failures; keep runtime details in references and JavaScript.
- [ ] Forward-test the skill in fresh contexts, close observed loopholes, validate frontmatter, and run command/full tests.
- [ ] Commit `feat: add codex worker development workflow`.

### Task 7: Lifecycle hook, documentation, and end-to-end verification

**Files:**
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs`
- Modify: `plugins/codex/hooks/hooks.json`
- Modify: `plugins/codex/commands/setup.md`
- Modify: `README.md`
- Modify: `plugins/codex/CHANGELOG.md`
- Create: `tests/worker-development-e2e.test.mjs`

**Interfaces:**
- Consumes all prior tasks; produces restart/session cleanup, capability diagnostics, user documentation, and the release gate.

- [ ] Write a failing fake-runtime E2E test for two Implementer tasks, one blocking request, two fresh Reviews, a fix/re-review, trusted commits, and approved-only integration.
- [ ] Implement bounded session shutdown, capability/status diagnostics, setup text, usage examples, and local development instructions.
- [ ] Run `npm run build`, `npm test`, `npm run check-version`, `git diff --check`, and an opt-in fake coordinator smoke test.
- [ ] Run a fresh reviewer with explicitly selected model and effort; adjudicate findings and repeat verification after fixes. Normal tests use only fake fixtures.
- [ ] Commit `test: verify codex worker development workflow`.
