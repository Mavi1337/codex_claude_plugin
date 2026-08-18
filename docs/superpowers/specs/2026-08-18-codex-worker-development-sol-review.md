# Sol Review: Codex Worker Development Design

**Reviewed:** 2026-08-18  
**Design commit:** `99408bfcac1315618e5cbe4209473eb648e831af`  
**Design:** `docs/superpowers/specs/2026-08-18-codex-worker-development-design.md`  
**Review scope:** Specification completeness, internal consistency, feasibility, compatibility, security, concurrency, persistence, approval routing, context budgeting, testing, and upgrade risk.  
**Method:** Static review of the design and the current `codex-plugin-cc` implementation, with protocol cross-checks against the local Codex source checkout at `a16863f870`.

## Executive assessment

The design has a strong product direction and several sound architectural choices: explicit worker identities, dedicated supervisors, durable file artifacts, isolated task worktrees, independent fresh reviewers, bounded fix rounds, and fake-runtime CI. It is substantially better than reconstructing orchestration from chat history.

It is not complete enough for implementation planning yet. Three issues affect the core runtime contract rather than implementation detail:

1. a blocking app-server user-input or approval request cannot be answered by the specified CLI;
2. Luna is required to commit while its default Codex sandbox deliberately protects both `.git` and a linked worktree's external gitdir from writes;
3. independent worker supervisors have no defined single authority that can safely enforce the global turn limit, serialize integration, and prevent concurrent state loss.

The remaining important findings chiefly require the design to define state-machine boundaries, repository identity, crash semantics, review execution mode, snapshot integrity, schema/gate semantics, context-limit discovery, version negotiation, and artifact ownership. These choices will materially change the implementation plan, so they should be resolved in the specification first.

### Finding counts

| Severity | Count |
|---|---:|
| Critical | 3 |
| Important | 14 |
| Minor | 5 |

## Strengths

- **Correct ownership boundary.** The reusable runtime is assigned to common JavaScript modules rather than copied into skills (`Architecture`, lines 52-89).
- **Explicit identity.** Requiring worker/review IDs instead of a global “latest” selector is the right foundation for concurrency (`Runtime interface`, lines 91-113).
- **Useful isolation model.** A branch and worktree per task, based on the latest accepted integration commit, limits accidental cross-task edits (`Git worktrees and scheduling`, lines 219-233).
- **Independent review design.** Fresh Sol task reviewers, separate compliance/quality verdicts, scoped re-review, and controller adjudication avoid letting the implementer grade itself (`Role policies` and `Development and review loop`, lines 252-299).
- **Durable context strategy.** Briefs, reports, review packages, rulings, and progress are made canonical files instead of repeatedly traversing controller context (`Communication contract` and `Persistence and artifacts`, lines 160-217).
- **No silent review truncation.** Explicit partitioning and synthesis is the correct response to oversized reviews (`Context budgets`, lines 345-365).
- **Safe integration boundary.** The workflow does not push, publish, or merge to `main`, and task commits enter the integration branch only after review (`Git worktrees and scheduling`, lines 225-233).
- **Good CI direction.** The fake runtime, concurrency/cross-talk checks, crash recovery scenarios, Git integration tests, and end-to-end two-task scenario are appropriate (`Testing`, lines 418-453).

## Critical findings

### C-1 — The blocking input/approval round trip has no implementable runtime operation

**References**

- Design `Runtime interface`, lines 95-109: there is `worker send`, but no `respond`, `approve`, or `deny` operation.
- Design `Worker lifecycle`, lines 150-158: `send` is defined as starting a new turn, yet the controller is also told to answer `needs_input` with `send` or an unspecified “approval operation.”
- Design `Permissions and approvals`, lines 367-373.
- `plugins/codex/scripts/lib/app-server.mjs:131-160`: every server-initiated request currently receives JSON-RPC `-32601`.
- Codex protocol `codex-rs/app-server-protocol/src/protocol/common.rs:1537-1569`: command approval, file-change approval, tool user input, MCP elicitation, and permission approval are server requests that require typed responses on the original JSON-RPC request.
- Codex protocol `codex-rs/app-server-protocol/src/protocol/v2/item.rs:1442-1541` and `:1638-1692`: routing depends on request, thread, turn, item, and sometimes approval IDs; user-input responses map question IDs to typed answers.

**Evidence**

A blocking `item/tool/requestUserInput` is not a completed turn followed by another `turn/start`. The app-server is awaiting a response to its own request ID while the same turn remains active. Approval requests work the same way. Starting a new turn with `worker send` either fails because a turn is active or leaves the original request unresolved. The current client cannot hold or answer such a request at all.

The spec also does not distinguish:

- a model ending a turn with a structured `needs_input` result, which can legitimately be followed by a new `send`; and
- a blocking app-server server request inside an active turn, which must be answered on the existing connection.

**Impact**

Interactive turns can deadlock, time out, or be incorrectly failed. An approval could be applied to the wrong callback when one item produces multiple approval IDs. Stop, close, app-server crash, and CLI retry behavior is undefined while a request is pending. The primary interactive feature is therefore not implementable from this interface.

**Required resolution**

Define an explicit, versioned request/response protocol before planning:

- Add operations such as `worker respond` and `worker decide-approval`, or one typed `worker resolve-request` operation. Do not overload `send`.
- Return and persist a runtime request ID plus server request ID, method, thread ID, turn ID, item ID, approval ID, `isBlocking`, allowed decisions, sanitized command/path data, and creation/expiry timestamps.
- Define exactly-once/idempotent behavior, stale-decision rejection, secret-answer redaction, and what happens if a second request arrives.
- Define whether a pending request releases a scheduler inference slot while still counting against a separate live/pending-turn bound.
- Define stop/close behavior (normally deny/cancel outstanding requests before interruption) and state clearly that an app-server connection loss invalidates its JSON-RPC request IDs.
- Set Luna's effective app-server settings explicitly. To route requests to Claude, the role needs an approval policy that can ask (normally `on-request`) and `approvalsReviewer: user`; current plugin defaults are `approvalPolicy: "never"` in `plugins/codex/scripts/lib/codex.mjs:63-83`.
- Enumerate supported server request methods and fail closed on unknown mutating requests. Include MCP elicitation and permission requests in the policy decision, not only command/file approval.

### C-2 — The required Luna commit step conflicts with the proposed sandbox

**References**

- Design `Git worktrees and scheduling`, lines 221-225: Luna “must commit completed work.”
- Design `Luna implementer`, lines 241-250: `workspace-write`, writable roots limited to the assigned worktree, and Luna commits its task.
- Codex protocol `codex-rs/protocol/src/protocol.rs:1054-1069`: sensitive metadata, especially `.git` and hooks, is protected below writable roots.
- Codex protocol `codex-rs/protocol/src/permissions.rs:1601-1621`: both a worktree `.git` pointer and the external gitdir it identifies are made read-only.
- Codex sandbox test `codex-rs/sandboxing/src/seatbelt_tests.rs:1179-1275`: writes to both the `.git` pointer and linked gitdir are expected to fail.
- This feature worktree itself demonstrates the shape: `.git` points to `codex-plugin-cc/.git/worktrees/codex-worker-development`, outside the worktree.

**Evidence**

A Git commit must update the linked worktree index, object database, lock files, and branch ref under the common Git directory. Codex workspace-write intentionally protects those paths even when the worktree root is writable. The legacy `sandbox: "workspace-write"` currently sent by this plugin (`plugins/codex/scripts/lib/codex.mjs:63-83`) cannot express a safe narrow exception. Broadly adding the common `.git` directory as writable would allow modification of hooks, config, refs belonging to other worktrees, and other security-sensitive repository metadata.

The sandbox also writes `/tmp` and possibly `$TMPDIR` by default (`codex-rs/protocol/src/protocol.rs:1191-1231`), so “assigned worktree only” is not the effective policy unless those defaults are explicitly disabled.

**Impact**

Under the stated defaults, routine task completion will stall on commit or require escalation. If implementation grants the whole common Git directory to make commits work, one worker can corrupt or influence every worktree and can install executable hooks. This defeats the isolation and approval guarantees.

**Required resolution**

Choose and specify one safe commit authority:

1. **Recommended:** Luna edits and tests only. After Luna returns a structured implementation result, the trusted runtime/controller validates the worktree, stages only allowed paths, and creates the commit mechanically. The runtime should disable hooks for this operation, avoid interactive signing, record the exact staged tree and resulting commit, and leave integration to the controller.
2. Alternatively, design and verify a narrow Codex permission profile that permits only the linked worktree index/object/ref operations needed for commit while keeping hooks, config, other refs, and other worktrees protected. This is substantially more complex and likely requires Codex-side support.

Whichever option is chosen, revise all “Luna commits” language, define commit authorship/signing behavior, and add a real linked-worktree sandbox test on Linux, macOS, and Windows. Also decide whether `/tmp` is intentionally writable; if not, pass a structured workspace-write policy with both temporary-root exclusions enabled.

### C-3 — No component owns global scheduling, integration serialization, or multi-process state

**References**

- Design `Worker supervisors and concurrency`, lines 115-131: one detached supervisor per worker and a global limit of five Codex turns.
- Design `Git worktrees and scheduling`, lines 219-233: the controller owns one integration branch and may run tasks concurrently.
- Design `Persistence and artifacts`, lines 191-217: multiple actors persist orchestration transitions.
- `plugins/codex/scripts/lib/state.mjs:58-77` and `:92-121`: current state is an unlocked read-modify-write file; concurrent writers can overwrite one another.
- `plugins/codex/scripts/app-server-broker.mjs:68-72` and `:173-205`: the existing broker has a single in-process owner for its active request; the proposed per-worker replacement has no corresponding global owner.

**Evidence**

Five independent supervisor processes cannot enforce one shared limit without a coordinator or durable lease protocol. Atomic rename makes each write indivisible but does not prevent two processes from reading the same revision and then losing one update. The same problem applies to queue ordering, worker IDs, controller rulings, progress, and integration-branch expected HEAD.

Multiple Claude sessions may also address the same repository and orchestration. The design does not define whether scheduling is per orchestration, repository, plugin installation, or machine, nor which controller is allowed to cherry-pick. Two controllers can both see a task as approved and mutate the integration branch concurrently.

**Impact**

The runtime can exceed the advertised limit, start duplicate turns, lose terminal states or reports, and race two cherry-picks. A crash can leave a slot permanently leased or a queued turn started twice. These are correctness and repository-integrity failures at the center of the architecture.

**Required resolution**

- Define a single coordination authority. A per-repository scheduler/coordinator process that owns the queue and integration lease is the cleanest design; a cross-platform locked state store with expiring leases is possible but more complex.
- State the concurrency scope. At minimum, all orchestrations sharing a repository identity should coordinate; if the intended cap is machine-wide, introduce a machine-level arbiter.
- Give start/send requests idempotency keys and durable queue entries. Define lease acquisition, heartbeat, stale-lease recovery, fairness, cancellation, and crash reconciliation.
- Require a compare-and-swap check on the integration branch's expected HEAD before cherry-pick. Only one controller may hold the integration-writer lease.
- Make supervisors publish transitions through the coordinator or use revisioned conditional writes; do not let every process overwrite a shared JSON document.

## Important findings

### I-1 — The lifecycle conflates worker, supervisor, thread, turn, and pending-request state

**References:** Design `Worker lifecycle`, lines 133-158; `Communication contract`, lines 160-174.

**Evidence:** The diagram reads as one linear state chain, although `COMPLETED`, `STOPPED`, and `CLOSED` concern different objects. `resume` is modeled as a state after `CLOSED`, and immediately leads to `RUNNING`, even though recreating a supervisor/thread normally leaves an idle worker until a new turn is sent. `NEEDS_INPUT` can mean either a finished structured turn or a still-active blocking server request. `blocked` appears as both a terminal status and an approval outcome. `completed_with_concerns` is a turn result but does not appear in the lifecycle.

**Impact:** Invalid transitions, slot leakage, and recovery ambiguity will be encoded differently by the CLI, supervisor, state store, and skills.

**Required resolution:** Specify separate state machines and invariants for supervisor (`starting/online/stopped/crashed/closed`), thread (`new/ready/unavailable`), turn (`queued/running/waiting-input/waiting-approval/completed/failed/interrupted`), and controller task (`pending/implemented/in-review/accepted/integrated/blocked`). Make `resume` an operation, define an idle worker state, and provide an explicit transition table including which transitions are durable and which process owns them.

### I-2 — The persistence contract is not sufficient for crash or concurrent recovery

**References:** Design `Persistence and artifacts`, lines 191-217; `Failure recovery`, lines 375-387; `plugins/codex/scripts/lib/state.mjs:58-77`, `:92-121`.

**Evidence:** “Temporary sibling plus atomic rename” covers torn replacement but not lost updates, fsync durability, stale temporary files, schema migration, or corruption. The current loader silently turns malformed JSON into default empty state, which would make durable orchestration disappear. The design says defaults are versioned but does not version the orchestration schema or define forward/backward compatibility.

**Impact:** Power loss or concurrent processes can lose accepted commits and approval decisions. Silent reset can make the controller repeat work or clean the wrong resources.

**Required resolution:** Define revisioned records, a lock/single writer, write-file fsync plus rename and directory fsync where supported, stale-temp recovery, checksums/backups, strict schema validation, and migrations. Corruption must surface as a recoverable error, never an empty orchestration. Store immutable append-only events or per-worker records where practical so unrelated writers do not contend on one large file.

### I-3 — Repository identity will split when commands run inside task worktrees

**References:** Design `Persistence and artifacts`, lines 191-194; `plugins/codex/scripts/lib/workspace.mjs:3-8`; `plugins/codex/scripts/lib/state.mjs:29-44`.

**Evidence:** Existing state keys use the canonical `git rev-parse --show-toplevel`. Each linked worktree has a different top-level path, so the integration worktree and every task worktree hash to different state directories. The design says “canonical repository path” but does not define whether that means a worktree path, common Git directory, remote identity, or integration root.

**Impact:** A supervisor started with a task worktree as cwd can be invisible to `/codex:develop`, `/codex:status`, session cleanup, and recovery from the integration worktree.

**Required resolution:** Define a stable local repository ID, preferably the canonical `git rev-parse --git-common-dir` plus an explicit integration-worktree identity. Pass that ID and orchestration root to every worker rather than deriving it from worker cwd. Test main checkouts, linked worktrees, subdirectories, symlinked paths, bare repositories, and moved checkouts.

### I-4 — Supervisor and app-server crash recovery is over-promised and ownerless

**References:** Design `Worker supervisors and concurrency`, lines 119-127; `Failure recovery`, lines 375-385; `Session shutdown`, lines 217-218.

**Evidence:** A process cannot restart itself after it has crashed; no watchdog/coordinator is named. If app-server dies during an active turn or while holding a server request, resuming the persisted thread restores history but does not guarantee that the in-flight inference or JSON-RPC callback resumes. A supervisor crash can also leave its app-server child orphaned. PID alone is unsafe because operating systems reuse PIDs. Existing process termination (`plugins/codex/scripts/lib/process.mjs:57-117`) does not verify process identity.

**Impact:** Recovery may duplicate a non-idempotent turn, wait forever on an invalid request, or kill an unrelated reused PID. The stated automatic recovery guarantee may not be achievable.

**Required resolution:** Name the watchdog/repair trigger and define reconciliation. Persist process start time or another identity token, verify executable/ownership before signaling, and make supervisor/app-server process-group behavior explicit. On transport loss, mark an active turn indeterminate or failed; resume the thread to a known idle boundary and require an explicit bounded retry with a new turn ID. Never claim an outstanding server request survives reconnection unless the Codex protocol guarantees re-emission. Define how the five-second `SessionEnd` hook in `plugins/codex/hooks/hooks.json:15-23` can signal all supervisors without blocking past its deadline.

### I-5 — Canonical artifact ownership contradicts worker filesystem permissions

**References:** Design `Communication contract`, lines 174-189; `Persistence and artifacts`, lines 191-215; `Luna implementer`, lines 241-250; `Sol task reviewer`, lines 252-274.

**Evidence:** Canonical task reports live under `CLAUDE_PLUGIN_DATA`, while Luna can write only its assigned worktree. Sol is correctly described as read-only with the supervisor writing its report, but Luna is said to write an implementation report. Letting Luna write plugin data broadens its sandbox and lets it alter orchestration state; writing the report in the worktree pollutes the task diff.

**Impact:** The implementation must either violate the sandbox, trust model-selected paths, or store noncanonical reports in Git.

**Required resolution:** Make the trusted runtime the sole writer of all canonical artifacts. Luna should return a schema-validated result containing report fields; the supervisor writes those fields to its precomputed artifact path. Never accept an arbitrary output path from a worker. If large free-form output is first produced in the worktree, copy it through a size-bounded, path-validated ingestion step and remove/exclude it before commit.

### I-6 — The Sol review execution primitive is unspecified and existing `review/start` cannot satisfy the contract as written

**References:** Design `Runtime interface`, lines 91-113; `Review targets`, lines 301-343; `Role policies`, lines 252-277.

**Evidence:** Current native review uses `review/start` (`plugins/codex/scripts/lib/codex.mjs:1002-1055`). The Codex protocol `ReviewTarget` supports only uncommitted changes, base branch, one commit, or custom instructions (`codex-rs/app-server-protocol/src/protocol/v2/review.rs:17-64`). `review/start` has no output-schema field and does not express staged-only, unstaged-only, last-N, arbitrary ranges, file audits, or the proposed structured dual-verdict report. Generic `turn/start` already accepts `outputSchema` in the plugin (`plugins/codex/scripts/lib/codex.mjs:1132-1143`).

**Impact:** Implementers may attempt to stretch native review targets, lose schema enforcement, or unexpectedly require a Codex-side protocol change.

**Required resolution:** State explicitly whether Sol reviews are generic read-only worker turns over runtime-built packages (recommended for this design) or native `review/start` calls. If native review is required, list the Codex protocol extensions and make them a prerequisite rollout stage. Do not build two independent review engines with divergent target and output semantics.

### I-7 — The context-budget formula depends on model-limit data the current public model API does not expose

**References:** Design `Context budgets`, lines 345-365.

**Evidence:** `model/list` exposes model ID and supported reasoning efforts but not a context-window size (`codex-rs/app-server-protocol/src/protocol/v2/model.rs:92-121`). Thread start/resume accepts arbitrary config overrides (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:95` and `:381`), but its response does not report the effective context window (`:171-202`). Context-window telemetry appears later in thread token-usage data, too late to enforce the first package. The design also budgets only the package, not system/developer instructions, repository instructions, tool results, output allowance, synthesis inputs, or tokenizer error.

**Impact:** `min(user budget, advertised model limit)` cannot be computed reliably through the named interface. A nominal 190K package may overflow after other context is added, and setting an excessive `model_context_window` can misconfigure compaction rather than safely clamp it.

**Required resolution:** Define an authoritative source for supported context limits or treat the configured role ceiling as a conservative policy cap without claiming model-advertised clamping. Reserve explicit budgets for fixed instructions, tool exploration, output, and estimation error; enforce the sum, not only package bytes. Record requested and effective config in the report, verify configuration application where possible, and specify fail-closed behavior when the model/provider limit is unknown. Add tokenizer-version and approximation tests.

### I-8 — Model, effort, and app-server capability negotiation is missing

**References:** Design `Role policies`, lines 235-277; `Context budgets`, lines 355-365; `Compatibility and rollout`, lines 404-416.

**Evidence:** The design assumes `gpt-5.6-luna`, `gpt-5.6-sol`, `high`, and `xhigh` are available and that the installed CLI accepts all required methods/config. `model/list` does expose supported efforts, so this is detectable. The current generated type adapter lists only the methods the existing plugin uses (`plugins/codex/scripts/lib/app-server-protocol.d.ts:59-69`), the runtime initializes with `experimentalApi: false` (`plugins/codex/scripts/lib/app-server.mjs:32-42`), and no minimum CLI/protocol version is stated.

**Impact:** Rollout behavior will vary by Codex CLI version/provider. Silent provider fallback would violate role selection; hard failure without diagnostics makes setup unusable. Experimental runtime workspace roots/permission profiles cannot be assumed while the client opts out of experimental API.

**Required resolution:** Add a startup capability probe and compatibility matrix: minimum Codex version, required request/notification methods, config keys, output schema, model availability, supported effort, and experimental features. Fail with actionable diagnostics if the required role model is unavailable; do not silently substitute a provider default. Pin or test a minimum fake-protocol fixture plus a latest fixture. Expose the checks through setup/status.

### I-9 — Structured report, stable-ID, and integration-gate semantics are underdefined

**References:** Design `Sol task reviewer`, lines 252-274; `Development and review loop`, lines 279-299; `Testing`, lines 449-451.

**Evidence:** A schema file is proposed, but the actual schema contract is not described. “Stable ID” has no generation rule across partitioned passes and re-reviews. Findings require file and line even when the issue is a missing requirement, deleted file, binary, or cross-cutting design problem. The loop says both verdicts must pass, but does not define how `cannot-verify`, a quality `changes-required` caused only by minor findings, or a controller waiver after round five affects integration. Current `parseStructuredOutput` performs only `JSON.parse` (`plugins/codex/scripts/lib/codex.mjs:1188-1212`), not schema validation.

**Impact:** Different reviewers/synthesis runs cannot reconcile findings reliably, and controller decisions may not deterministically open or close the gate.

**Required resolution:** Put a versioned canonical schema and gate truth table in the spec. Define severity values, optional/multi-location evidence, confidence, disposition, stable ID derivation, supersession/duplicate rules, partial-pass identity, and re-review statuses. State that `cannot-verify` blocks automatic integration unless the controller writes a reasoned ruling, and define whether minor findings can coexist with `approve`. Choose a schema validator and define handling of unknown fields/schema versions/raw-output retries.

### I-10 — Review packages are not immutable snapshots and the “evidence boundary” is ambiguous

**References:** Design `Review targets`, lines 301-343; `Context budgets`, lines 363-365.

**Evidence:** Committed ranges are naturally addressable by object IDs, but staged, unstaged, untracked, and current-state audit targets can change while the review runs. A read-only reviewer whose cwd is the live repository can inspect state outside the package, conflicting with the statement that the package is its evidence boundary. Partition passes are called non-overlapping, but the required cross-cutting pass deliberately needs overlapping interfaces/tests. No manifest hash, source snapshot, skipped-file record, or dependency-discovery record is specified.

**Impact:** A verdict can apply to different bytes than the controller later integrates or displays. Synthesis may miss files skipped due to size/binary rules, and reruns cannot reproduce evidence.

**Required resolution:** Freeze every target at review start. For committed changes, resolve and store full object IDs; for index/worktree/audit targets, create a bounded immutable snapshot or synthetic tree and hash the manifest/package. Record every included, skipped, binary, symlink, submodule, generated, and discovered dependency path with a reason. Define whether reviewers may inspect beyond the package; if yes, log/hash additional evidence, and if no, run them against the snapshot artifact. Describe partition ownership, deliberate cross-cutting overlap, and synthesis coverage checks.

### I-11 — Git integration and conflict repair need a deterministic, model-independent protocol

**References:** Design `Git worktrees and scheduling`, lines 219-233; `Development and review loop`, lines 281-299.

**Evidence:** The design trusts Luna to report commit hashes and says the controller cherry-picks task commits, but does not require the runtime to derive the ordered set from `base..head`, verify ancestry/no unexpected merges, or ensure the branch still points at the reviewed head. “Resume the owning Luna thread with the new integration base” does not say whether to create a new branch, rebase, merge, or replay the task. Parallel tasks mean the integration HEAD will normally move after each review. Close safety checks only “dirty” work; ignored files can still be deleted when a dedicated worktree is removed.

**Impact:** A stale or model-reported commit set can bypass the reviewed snapshot. Conflict repair can rewrite already-reviewed commits, duplicate changes, or silently drop task work. Cleanup may destroy ignored but meaningful worker-created files.

**Required resolution:** Make Git facts runtime-derived. Persist base/head object IDs, require expected ancestry, enumerate commits with a shell-free Git invocation, and cherry-pick only the exact reviewed IDs after rechecking branch head and integration expected HEAD. Define merge-commit policy. For conflicts, prefer a new repair branch from the latest integration head with the task patch replayed, then review the entire resulting task delta. Specify abort/rollback commands and state. Before worktree removal, inspect ignored/untracked files and either preserve them as artifacts or allow only explicit disposable patterns. State submodule and LFS support or reject them up front.

### I-12 — The supervisor CLI and local IPC contract lacks security, retry, and transactional guarantees

**References:** Design `Runtime interface`, lines 91-113; `Worker supervisors and concurrency`, lines 119-129; `Worker lifecycle`, lines 148-157.

**Evidence:** Operations are listed but their request/response schemas, exit codes, timeouts, framing, maximum payload, authentication, and idempotency are absent. A detached process can complete an operation after its CLI caller disconnects, so a retry can create a duplicate worker or turn. `start` spans branch creation, worktree creation, supervisor spawn, app-server initialize, thread creation, and state persistence with no transaction/reconciliation sequence. Local sockets/named pipes are mentioned without permissions or repository binding.

**Impact:** Crashes at step boundaries leak branches/processes; retries duplicate work; another local process could forge worker requests if the endpoint is accessible; malformed IDs can become path traversal or endpoint-selection inputs.

**Required resolution:** Define a versioned JSON envelope for every operation, stable exit-code classes, stdout/stderr rules, request IDs/idempotency keys, bounded `wait` timeout/poll behavior, and maximum frame sizes. Resolve endpoints only from validated repo-bound state; never accept an arbitrary socket path from the caller. Use owner-only directories/socket permissions or a capability token, validate IDs before path construction, and protect against symlink substitution. Specify the start transaction and a reconciliation scan that cleans or adopts each partially created resource.

### I-13 — Sensitive artifacts, logs, and retention lack a concrete security policy

**References:** Design `Persistence and artifacts`, lines 191-217; `Configuration`, lines 389-402; `Permissions and approvals`, lines 367-373.

**Evidence:** Reports and raw failed structured output can contain proprietary source, shell output, environment details, approval commands, or secret user-input answers. The spec names retention/cleanup as configurable but gives no default, directory/file mode, redaction rule, size quota, or cleanup authorization. Existing state/log creation uses default process umask and appends raw messages (`plugins/codex/scripts/lib/tracked-jobs.mjs:36-57`).

**Impact:** Durable recovery artifacts can become a local data leak or grow without bound. A secret request answer may be copied to state/progress/logs.

**Required resolution:** Require owner-only state directories and files, never persist secret answers, redact environment/auth material and sensitive approval payloads, cap raw output/log/artifact sizes, and make cleanup explicit and repo/orchestration scoped. Define conservative default retention and ensure existing 50-job pruning (`plugins/codex/scripts/lib/state.mjs:80-115`) can never delete active worker artifacts.

### I-14 — The test plan omits the failure cases that exercise the new architecture's hardest invariants

**References:** Design `Testing`, lines 418-453.

**Evidence:** The listed coverage is broad, but it does not explicitly cover simultaneous CLI processes, lost-update prevention, idempotent retries, two controllers, stale scheduler leases, PID reuse, socket authorization, partial `start`, a crash with a pending server request, corrupt/migrated state, model/protocol feature mismatch, or actual Git commit behavior inside a linked-worktree sandbox. The current fake app-server emits notifications but does not exercise a server-request response loop (`tests/fake-codex-fixture.mjs`).

**Impact:** CI can pass while the critical coordination, approval, and commit paths remain broken.

**Required resolution:** Add these scenarios to the normative test list. The fake app-server must emit request messages containing `id` and `method`, wait for typed responses, support multiple approval IDs, and simulate connection loss before/after resolution. Add multi-process tests with barriers, crash-injection at every start/persist/Git boundary, state migration/corruption tests, worktree/common-git identity tests, linked-worktree commit-policy tests, and platform-specific IPC/process mocks. Retain the real-model smoke test only as opt-in.

## Minor findings

### M-1 — `completed_with_concerns` has no normative semantics

**Reference:** Design `Communication contract`, lines 162-172.

Define whether it is terminal, whether it consumes the same integration gate as `completed`, which concerns must be represented structurally, and whether it is permitted for implementers, reviewers, or both.

### M-2 — Review target syntax needs precise Git semantics

**Reference:** Design `Review targets`, lines 301-341.

Specify `A..B` versus `A...B`, how `--last N` handles merge commits, the exact baseline for staged and unstaged changes, rename/deletion handling, path-pattern grammar, filenames containing commas/newlines, symlink behavior, and whether filters apply before or after rename detection. Use argv arrays and Git pathspec terminators; never interpolate refs or paths into a shell command.

### M-3 — Findings cannot always have a single file and line

**Reference:** Design `Sol task reviewer`, lines 266-274.

Permit zero or multiple structured locations. A specification omission, missing test, deleted file, cross-file race, package-level coverage gap, or binary artifact may have no valid current line. Require concrete evidence without inventing a location.

### M-4 — IPC endpoint placement must account for Unix path limits and Windows ownership

**Reference:** Design `Worker supervisors and concurrency`, lines 119-127.

Long `CLAUDE_PLUGIN_DATA` paths can exceed Unix-domain socket path limits. Use a short owner-only runtime directory with a hashed name, persist only the mapping, and define Windows named-pipe ACL behavior. Existing broker code deliberately creates a short temporary session directory (`plugins/codex/scripts/lib/broker-lifecycle.mjs:15-17`, `:131-169`).

### M-5 — User-visible cost and queue expectations should be part of `/codex:develop`

**References:** Design `Worker supervisors and concurrency`, lines 129-130; `Role policies`, lines 241-277.

Five concurrent high/xhigh model turns can consume usage rapidly. The command/skill should show the resolved task count, concurrency cap, selected roles/efforts, and whether final xhigh review is enabled before dispatching a large plan, then expose accumulated turn/review counts in status. This does not require per-turn confirmation after the user has authorized the workflow.

## Required design revisions before implementation planning

The specification should be revised with, at minimum, these normative decisions:

1. A typed blocking server-request resolution API and explicit Luna approval settings.
2. A safe commit authority compatible with protected Git metadata.
3. A single coordination authority, concurrency scope, durable leases, and integration-writer lock.
4. Separate supervisor/thread/turn/request/task state machines with transition ownership.
5. Stable repository identity based on the common Git repository, not each worktree root.
6. Honest crash semantics for in-flight turns and pending requests, plus PID/process identity.
7. Runtime-owned canonical artifacts and a redaction/retention policy.
8. A declared Sol execution primitive (`turn/start` versus Codex protocol work).
9. A reproducible snapshot/evidence package and exact Git integrity checks.
10. A versioned review schema, stable-ID rules, and integration-gate truth table.
11. A feasible context-limit discovery/accounting policy and model/protocol capability checks.
12. A versioned, idempotent, repo-bound supervisor CLI/IPC contract.
13. Expanded adversarial multi-process, crash, protocol, and sandbox tests.

These revisions should land in the design before a task-by-task implementation plan is written. Otherwise the plan will have to choose core product and security semantics ad hoc, and several early modules will likely need redesign once approval and Git behavior are exercised.

## Verdicts

- **Spec completeness:** changes-required
- **Architecture quality:** changes-required
- **Ready for implementation planning:** no

