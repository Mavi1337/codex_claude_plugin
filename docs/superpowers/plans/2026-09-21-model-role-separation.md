# Model and role separation

Binding requirements: the user-approved model/role brief and
`../specs/2026-08-18-codex-worker-development-design.md` (updated by this change).

Preserve the five existing partial implementation files and extend their changes.
Work only in the existing `codex-worker-development` worktree. No live inference
in tests, installed-cache edits, Codex source changes, or force pushes.

## Implementation and verification

1. Add regression coverage for explicit model/effort at CLI and coordinator
   boundaries, discovery including pagination, exact start/resume/turn forwarding,
   role permissions, legacy-role rejection and saved-state resumption.
2. Complete runtime validation and migration. Rename responsibility-specific
   prompts, schemas, errors, findings and helpers to generic names.
3. Update development/runtime skills, their references, Astra-only prompting,
   generic worker-review command plus legacy alias, design, original plan, README,
   changelog and all four version files to 1.0.11.
4. Verify review passes/synthesis and command contracts using fake app-server
   fixtures. Run build, full tests, version check and diff check; record totals.
5. Review the complete diff, commit on the feature branch, and publish the same
   validated commit to fork/main and fork/codex-worker-development without force.

## Progress

- Inspected the full incoming partial diff and applicable workspace instructions;
  no additional repository-local AGENTS.md or CLAUDE.md exists.
- Gaps found: first-page-only discovery, compatibility exit-code precedence,
  legacy-role creation bypass via threadId, old responsibility terminology,
  incomplete mandatory-profile and resumption tests.
- Model selection is runtime data from model/list. Astra is an explicit workflow
  recommendation, never a runtime fallback. Resume uses the saved exact profile.
- Runtime and documentation implementation complete. Incoming partial changes
  retained and extended. Resume also preserves canonical briefs, reports and
  review bindings; new protocol starts cannot disable implementer isolation.
- RED→GREEN regressions reproduced missing-profile idempotency bypass, first-page
  discovery, profile trimming, legacy start bypass, dropped resume artifacts,
  isolation bypass, thread-substitution cleanup, incorrect compatibility exit
  classification and missing asynchronous review error codes. Workflow contract
  tests first failed on absent generic entry points and explicit selection flags.
- Watchtower filtering reproduced an internal reviewer leaking into worker
  status; a direct Python fixture check passed after filtering by responsibility.
- Verification: `npm run build` passed (Codex emitted a non-fatal sandbox warning
  that it could not create PATH aliases); `npm test` passed 181/181, zero failures,
  cancelled, skipped or todo; `npm run check-version` passed at 1.0.11;
  `git diff --check` passed. Full command output was read.
- Managed nested-process runs suppressed test output. Verification was rerun
  outside that process sandbox, using fake Codex/app-server fixtures only.
- Local loading: `claude --plugin-dir ./plugins/codex plugin details codex` loaded
  codex@inline 1.0.11 with 17 skills/commands, one agent and three hooks, including
  worker-review and the legacy alias. `claude plugin validate ./plugins/codex --json`
  reported success with zero errors and zero warnings. No live inference needed.
- Publication preflight: fetched fork; both fork/main and
  fork/codex-worker-development point at the existing feature HEAD and permit
  fast-forward publication. Official origin unchanged. Upstream main checkout is
  separate and is not part of this feature change.
- Independent final review: `model_role_review`, selected model `gpt-6-astra`,
  effort `high`, read-only. Approved with no material findings after checking
  runtime profile/permission/resume invariants and active documentation. The
  reviewer did not run live inference or duplicate the full verification.
- Residual validation limit: provider availability and live model behavior were
  not exercised; starts verify the exact model/effort against discovery at runtime.
  The existing review context cap remains a requested policy value, as documented.
