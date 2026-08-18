import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CodexAppServerClient } from "./app-server.mjs";
import { assertSafeId } from "./worker-protocol.mjs";
import { createWorkerStore } from "./worker-state.mjs";
import {
  applyReviewedCommits,
  commitTaskWorktree,
  createTaskWorktree,
  inspectTaskWorktree,
  restoreTaskWorktree,
  rollbackTaskWorktreeCreation
} from "./worker-worktree.mjs";
import { resolveWorkerReviewTarget } from "./review-target.mjs";
import { freezeReviewPackage } from "./review-package.mjs";
import { evaluateReviewGate, validateSolReview, validateWorkerResult } from "./worker-review.mjs";

const SOL_SCHEMA_URL = new URL("../../schemas/sol-review-output.schema.json", import.meta.url);
const SOL_TASK_PROMPT_URL = new URL("../../prompts/sol-task-reviewer.md", import.meta.url);
const SOL_BRANCH_PROMPT_URL = new URL("../../prompts/sol-branch-reviewer.md", import.meta.url);
const WORKER_SCHEMA_URL = new URL("../../schemas/worker-turn-output.schema.json", import.meta.url);
const LUNA_PROMPT_URL = new URL("../../prompts/luna-implementer.md", import.meta.url);

const INPUT_METHODS = new Set(["item/tool/requestUserInput", "mcpServer/elicitation/request"]);
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
]);

function nowIso() { return new Date().toISOString(); }
function turnInput(prompt) { return [{ type: "text", text: prompt, text_elements: [] }]; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function reviewWorkerId(reviewId, suffix) { return `sol-${sha256(reviewId).slice(0, 16)}-${suffix}`; }
function boundedOutput(value) {
  const source = String(value);
  return source.length > 131072 ? `${source.slice(0, 131072)}\n[truncated; canonical full output belongs in an artifact]` : source;
}

function sanitizeRequestValue(value, key = "", depth = 0) {
  if (depth > 6) return "[truncated-depth]";
  if (/token|secret|password|authorization|cookie/i.test(key)) return "[redacted]";
  if (typeof value === "string") return value.length > 4096 ? `${value.slice(0, 4096)}…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeRequestValue(entry, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([name, entry]) => [name, sanitizeRequestValue(entry, name, depth + 1)]));
  }
  return value;
}

function allowedRequestDecisions(method, params) {
  if (Array.isArray(params?.availableDecisions)) return sanitizeRequestValue(params.availableDecisions);
  if (method === "item/commandExecution/requestApproval") {
    if (params?.networkApprovalContext) {
      const decisions = ["accept", "acceptForSession"];
      const amendment = (params.proposedNetworkPolicyAmendments ?? []).find((entry) => entry?.action === "allow");
      if (amendment) decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
      return [...decisions, "cancel"];
    }
    if (params?.additionalPermissions) return ["accept", "cancel"];
    const decisions = ["accept"];
    if (params?.proposedExecpolicyAmendment) {
      decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
    }
    return [...decisions, "cancel"];
  }
  if (method === "item/fileChange/requestApproval") return ["accept", "acceptForSession", "decline", "cancel"];
  if (method === "mcpServer/elicitation/request") return ["accept", "decline", "cancel"];
  return [];
}

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function assertObjectKeys(value, allowed, label) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unknown fields or is not an object.`);
}

function validateOptionalStringArray(value, label) {
  if (value !== undefined && value !== null && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new Error(`${label} must be an array of strings or null.`);
  }
}

function validateFileSystemPath(value) {
  if (!isPlainObject(value) || !["path", "glob_pattern", "special"].includes(value.type)) throw new Error("Permission file-system entries must contain a valid path type.");
  if (value.type === "path" && (typeof value.path !== "string" || Object.keys(value).some((key) => !["type", "path"].includes(key)))) {
    throw new Error("Permission path entries must contain a string path.");
  }
  if (value.type === "glob_pattern" && (typeof value.pattern !== "string" || Object.keys(value).some((key) => !["type", "pattern"].includes(key)))) {
    throw new Error("Permission glob entries must contain a string pattern.");
  }
  if (value.type === "special" && (!isPlainObject(value.value) || typeof value.value.kind !== "string" || Object.keys(value).some((key) => !["type", "value"].includes(key)))) {
    throw new Error("Permission special entries must contain a valid special path.");
  }
}

function validateGrantedPermissions(value) {
  assertObjectKeys(value, ["network", "fileSystem"], "Permission grants");
  if (value.network !== undefined && value.network !== null) {
    assertObjectKeys(value.network, ["enabled"], "Network permission");
    if (value.network.enabled !== undefined && value.network.enabled !== null && typeof value.network.enabled !== "boolean") {
      throw new Error("Network permission enabled must be boolean or null.");
    }
  }
  if (value.fileSystem !== undefined && value.fileSystem !== null) {
    assertObjectKeys(value.fileSystem, ["read", "write", "globScanMaxDepth", "entries"], "File-system permission");
    validateOptionalStringArray(value.fileSystem.read, "File-system read roots");
    validateOptionalStringArray(value.fileSystem.write, "File-system write roots");
    if (value.fileSystem.globScanMaxDepth !== undefined && (!Number.isInteger(value.fileSystem.globScanMaxDepth) || value.fileSystem.globScanMaxDepth < 1)) {
      throw new Error("File-system globScanMaxDepth must be a positive integer.");
    }
    if (value.fileSystem.entries !== undefined && (!Array.isArray(value.fileSystem.entries) || value.fileSystem.entries.some((entry) => {
      try {
        assertObjectKeys(entry, ["path", "access"], "File-system permission entry");
        if (!["read", "write", "deny"].includes(entry.access)) throw new Error("invalid access");
        validateFileSystemPath(entry.path);
        return false;
      } catch { return true; }
    }))) throw new Error("File-system permission entries are invalid.");
  }
}

function validateRequestResult(record, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Request resolution must be a JSON object.");
  if (record.method === "item/commandExecution/requestApproval" || record.method === "item/fileChange/requestApproval") {
    if (Object.keys(result).some((key) => key !== "decision") || !record.allowedDecisions.some((decision) => sameJson(decision, result.decision))) {
      throw new Error("Approval decision must exactly match one of the request's available decisions.");
    }
  } else if (record.method === "item/permissions/requestApproval") {
    if (!isPlainObject(result.permissions) || (result.scope !== undefined && !["turn", "session"].includes(result.scope))) throw new Error("Permission approval requires permissions and a turn/session scope.");
    if (Object.keys(result).some((key) => !["permissions", "scope", "strictAutoReview"].includes(key))) throw new Error("Permission approval contains unknown fields.");
    validateGrantedPermissions(result.permissions);
    if (result.strictAutoReview !== undefined && result.strictAutoReview !== null && typeof result.strictAutoReview !== "boolean") throw new Error("strictAutoReview must be boolean.");
  } else if (record.method === "item/tool/requestUserInput") {
    if (!result.answers || typeof result.answers !== "object" || Array.isArray(result.answers)) throw new Error("User-input resolution must contain an answers object.");
    if (Object.keys(result).some((key) => key !== "answers")) throw new Error("User-input resolution contains unknown fields.");
    for (const answer of Object.values(result.answers)) {
      if (!isPlainObject(answer) || Object.keys(answer).some((key) => key !== "answers") || !Array.isArray(answer.answers) || answer.answers.some((entry) => typeof entry !== "string")) throw new Error("Each user-input answer must contain an array of strings.");
    }
  } else if (record.method === "mcpServer/elicitation/request") {
    if (!record.allowedDecisions.includes(result.action)) throw new Error(`Elicitation action must be one of: ${record.allowedDecisions.join(", ")}.`);
    if (Object.keys(result).some((key) => !["action", "content", "_meta"].includes(key))) throw new Error("Elicitation response contains unknown fields.");
    if (!("content" in result) || !("_meta" in result)) throw new Error("Elicitation response must include content and _meta.");
    if (result.action === "accept" && record.payload.mode !== "url" && !isPlainObject(result.content)) throw new Error("Accepted form elicitation requires structured content.");
    if (result.action === "accept" && record.payload.mode === "url" && result.content !== null) throw new Error("Accepted URL elicitation must not include form content.");
    if (result.action !== "accept" && result.content !== null) throw new Error("Declined or cancelled elicitation must not include content.");
  }
}

// A task worktree is created from a commit, so anything the integration checkout only holds
// untracked, ignored, or uncommitted — `.venv`, `.env`, generated data files — is simply absent
// there. Report it at start so a brief can carry absolute paths instead of failing mid-turn.
const MAX_REPORTED_ABSENT_INPUTS = 50;

function absentWorktreeInputs(repoRoot) {
  try {
    const { paths, ignored } = inspectTaskWorktree(repoRoot);
    const all = [...new Set([...paths, ...ignored])].sort();
    return { count: all.length, paths: all.slice(0, MAX_REPORTED_ABSENT_INPUTS), truncated: all.length > MAX_REPORTED_ABSENT_INPUTS };
  } catch {
    return { count: 0, paths: [], truncated: false };
  }
}

function snapshotRequirementFiles(store, orchestrationId, workerId, repoRoot, requirementPaths = []) {
  return requirementPaths.map((entry, index) => {
    const absolute = path.resolve(repoRoot, String(entry));
    const root = path.resolve(repoRoot);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Requirement path escapes the integration worktree: ${entry}.`);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`Requirement path is not a file: ${entry}.`);
    const source = fs.readFileSync(absolute);
    const file = store.writeArtifact(orchestrationId, `tasks/${workerId}/requirements/${index + 1}-${path.basename(absolute)}`, source);
    return { sourcePath: path.relative(root, absolute).replaceAll(path.sep, "/"), file, hash: sha256(source), bytes: source.length };
  });
}

export class WorkerCoordinator {
  constructor(options) {
    this.cwd = fs.realpathSync(options.cwd);
    this.store = options.store ?? createWorkerStore(options.cwd, { dataRoot: options.dataRoot });
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.clientFactory = options.clientFactory ?? ((cwd, clientOptions) => CodexAppServerClient.connect(cwd, { ...clientOptions, disableBroker: true }));
    this.clients = new Map();
    this.pendingRequests = new Map();
    this.pendingResolutions = [];
    this.closingWorkers = new Set();
    this.waiters = new Map();
    this.activeTurns = 0;
    this.pumping = false;
    const persisted = this.store.load();
    const recoverable = Object.values(persisted.workers).filter((worker) => worker.supervisorStatus === "online");
    const runningReviews = Object.values(persisted.reviews ?? {}).filter((review) => review.status === "running");
    if (recoverable.length || runningReviews.length) {
      this.store.transaction((state) => {
        for (const worker of Object.values(state.workers)) {
          if (worker.supervisorStatus !== "online") continue;
          worker.supervisorStatus = "crashed";
          worker.thread.status = "unavailable";
          if (worker.turn && ["queued", "running", "waiting-input", "waiting-approval"].includes(worker.turn.status)) {
            worker.turn.status = "indeterminate";
            worker.turn.error = "Coordinator transport was lost; retry explicitly from the resumed thread.";
          }
          if (worker.pendingRequest?.status === "pending") worker.pendingRequest.status = "cancelled";
        }
        state.recoveryQueue ??= [];
        state.recoveryQueue.push(
          ...state.queue.map((entry) => ({ ...entry, recoveryStatus: "indeterminate", recoveredAt: nowIso() })),
          ...Object.values(state.inFlightQueue ?? {}).map((entry) => ({ ...entry, recoveryStatus: "indeterminate", recoveredAt: nowIso() }))
        );
        state.queue = [];
        state.inFlightQueue = {};
        for (const review of Object.values(state.reviews ?? {})) {
          if (review.status !== "running") continue;
          review.status = "indeterminate";
          review.error = "Coordinator transport was lost while this review was running; retry explicitly with a new idempotency key.";
          review.completedAt = nowIso();
        }
        for (const [key, value] of Object.entries(state.idempotency)) {
          if (value?.status === "running" && state.reviews?.[value.id]?.status === "indeterminate") {
            state.idempotency[key] = structuredClone(state.reviews[value.id]);
          }
        }
      });
    }
  }

  async dispatch(operation, params, idempotencyKey) {
    assertSafeId(idempotencyKey, "idempotencyKey");
    if (params.cwd && fs.realpathSync(params.cwd) !== this.cwd) {
      throw new Error(`Coordinator is bound to integration worktree ${this.cwd}; refusing ${params.cwd}.`);
    }
    const prior = this.store.load().idempotency[idempotencyKey];
    if (prior) return prior;
    if (operation === "review.start") {
      const reviewId = assertSafeId(params.reviewId, "reviewId");
      const running = { id: reviewId, status: "running", startedAt: nowIso() };
      this.store.transaction((state) => {
        if (state.reviews[reviewId] && !["failed", "indeterminate", "stale"].includes(state.reviews[reviewId].status)) throw new Error(`Review ${reviewId} already exists.`);
        state.reviews[reviewId] = running;
        state.idempotency[idempotencyKey] = running;
      });
      void this.startReview(params, idempotencyKey).then((completed) => {
        this.store.transaction((state) => { state.idempotency[idempotencyKey] = completed; });
      }).catch((error) => {
        this.store.transaction((state) => {
          state.reviews[reviewId] = { ...running, status: "failed", error: String(error.message ?? error), completedAt: nowIso() };
          state.idempotency[idempotencyKey] = state.reviews[reviewId];
        });
      });
      return running;
    }
    let result;
    switch (operation) {
      case "worker.start": result = await this.startWorker(params); break;
      case "worker.send": return this.send(params.workerId, params.prompt, idempotencyKey);
      case "worker.wait": result = await this.wait(params.workerId, params.timeoutMs ?? 0); break;
      case "worker.status": result = this.status(params.workerId); break;
      case "worker.list": result = this.list(); break;
      case "worker.stop": result = await this.stop(params.workerId); break;
      case "worker.close": result = await this.close(params.workerId); break;
      case "worker.resume": {
        const record = this.status(params.workerId);
        result = await this.startWorker({
          ...record,
          workerId: record.id,
          threadId: record.thread.id,
          cwd: record.integrationCwd ?? record.cwd,
          workerCwd: record.cwd,
          isolated: false
        });
        break;
      }
      case "worker.resolve-request": return this.resolveRequest(params.requestId, params.result, idempotencyKey);
      case "integration.commit": {
        const worker = this.status(params.workerId);
        if (worker.role !== "luna") throw new Error("Only Luna implementation workers have task worktrees to commit.");
        if (worker.turn?.status !== "completed" || !["completed", "completed_with_concerns"].includes(worker.result?.status)) {
          throw new Error("integration.commit requires a terminal Luna turn with a validated implementation report.");
        }
        if (!Array.isArray(params.allowedPaths) || params.allowedPaths.length === 0) {
          throw new Error("integration.commit requires explicit allowed paths from the task assignment.");
        }
        const assigned = [...(worker.assignmentPaths ?? [])].sort();
        const requested = [...params.allowedPaths].map(String).sort();
        if (!assigned.length || JSON.stringify(assigned) !== JSON.stringify(requested)) {
          throw new Error("integration.commit allowed paths must exactly match the worker's runtime-owned task assignment.");
        }
        result = this.#withIntegrationLease("commit", worker.id, () => commitTaskWorktree(worker.cwd, {
          message: params.message,
          allowedPaths: params.allowedPaths,
          expected: { commonDir: worker.commonDir, gitDir: worker.gitDir, branch: worker.branch, base: worker.baseCommit }
        }));
        this.store.transaction((state) => {
          state.workers[params.workerId].headCommit = result.commit;
          state.workers[params.workerId].tree = result.tree;
          state.workers[params.workerId].reviewGate = null;
          state.workers[params.workerId].reviewBinding = null;
        });
        break;
      }
      case "integration.rule": {
        const worker = this.status(params.workerId);
        if (worker.role !== "luna") throw new Error("Only Luna implementation workers carry integrable commits.");
        if (!worker.headCommit || !worker.tree) throw new Error("A controller ruling requires a committed task worktree.");
        const reason = String(params.reason ?? "").trim();
        if (!reason) throw new Error("Controller ruling requires a reason.");
        const controllerRuling = { waive: true, reason, recordedAt: nowIso() };
        this.store.transaction((state) => {
          const record = state.workers[params.workerId];
          record.reviewGate = "pass-with-ruling";
          record.reviewBinding = {
            kind: "controller-ruling",
            gate: "pass-with-ruling",
            reviewId: null,
            baseCommit: record.baseCommit,
            headCommit: record.headCommit,
            tree: record.tree,
            controllerRuling
          };
          state.controllerRulings ??= [];
          state.controllerRulings.push({
            id: `ruling-${randomUUID()}`, workerId: record.id, orchestrationId: record.orchestrationId,
            baseCommit: record.baseCommit, headCommit: record.headCommit, tree: record.tree, ...controllerRuling
          });
        });
        result = this.status(params.workerId).reviewBinding;
        break;
      }
      case "integration.apply": {
        const worker = this.status(params.workerId);
        const binding = worker.reviewBinding;
        if (!["pass", "pass-with-ruling"].includes(worker.reviewGate) || worker.reviewGate !== binding?.gate) {
          throw new Error("Worker changes have not passed an exact Sol review or controller ruling binding.");
        }
        if (binding.baseCommit !== worker.baseCommit || binding.headCommit !== worker.headCommit || binding.tree !== worker.tree) {
          throw new Error("Worker Git facts no longer match the passing integration binding.");
        }
        if (binding.kind !== "controller-ruling") {
          if (binding.reviewTarget?.mode !== "committed" || binding.reviewTarget.base !== binding.baseCommit || binding.reviewTarget.head !== binding.headCommit) {
            throw new Error("The Sol review target does not match the bound worker commit range.");
          }
          if (!binding.packageFile || !fs.existsSync(binding.packageFile) || sha256(fs.readFileSync(binding.packageFile)) !== binding.packageHash) {
            throw new Error("The immutable Sol review package no longer matches its recorded hash.");
          }
        }
        result = this.#withIntegrationLease("apply", worker.id, () => applyReviewedCommits({
          integrationCwd: worker.integrationCwd,
          expectedHead: params.expectedHead,
          base: worker.baseCommit,
          head: worker.headCommit,
          expectedTree: binding.tree
        }));
        break;
      }
      case "review.status":
      case "review.result": {
        result = this.store.load().reviews?.[assertSafeId(params.reviewId, "reviewId")];
        if (!result) throw new Error(`Unknown review ${params.reviewId}.`);
        break;
      }
      case "review.rule": {
        const reviewId = assertSafeId(params.reviewId, "reviewId");
        const review = this.store.load().reviews?.[reviewId];
        if (!review || review.status !== "completed") throw new Error("Only a completed review can receive a controller ruling.");
        const reason = String(params.reason ?? "").trim();
        if (!reason) throw new Error("Controller ruling requires a reason.");
        const controllerRuling = { waive: params.waiveCannotVerify === true, reason, recordedAt: nowIso() };
        const ruledGate = evaluateReviewGate(review, { controllerRuling });
        this.store.transaction((state) => {
          const current = state.reviews[reviewId];
          current.controllerRuling = controllerRuling;
          current.gate = ruledGate;
          const worker = current.reviewedWorkerId ? state.workers[current.reviewedWorkerId] : null;
          if (worker?.reviewBinding?.reviewId === reviewId) {
            worker.reviewGate = ruledGate.status;
            worker.reviewBinding.gate = ruledGate.status;
            worker.reviewBinding.controllerRuling = controllerRuling;
          }
        });
        const updated = this.store.load().reviews[reviewId];
        if (updated.reportFile && updated.orchestrationId && fs.existsSync(updated.reportFile)) {
          const expectedReport = this.store.artifactPath(updated.orchestrationId, `reviews/${reviewId}/report.json`);
          if (updated.reportFile === expectedReport) {
            const report = JSON.parse(fs.readFileSync(updated.reportFile, "utf8"));
            this.store.writeArtifact(updated.orchestrationId, `reviews/${reviewId}/report.json`, `${JSON.stringify({ ...report, controllerRuling, gate: ruledGate }, null, 2)}\n`);
          }
        }
        result = this.store.load().reviews[reviewId];
        break;
      }
      case "coordinator.status": result = {
        status: "online", repositoryId: this.store.identity.repositoryId,
        coordinatorPid: process.pid, integrationCwd: this.cwd,
        activeTurns: this.activeTurns, queuedTurns: this.store.load().queue.length,
        workerCount: this.list().length, maxConcurrent: this.maxConcurrent
      }; break;
      case "coordinator.shutdown": result = { status: "shutting-down" }; break;
      default: throw new Error(`Unsupported worker operation: ${operation}.`);
    }
    this.store.transaction((state) => { state.idempotency[idempotencyKey] = result; });
    return result;
  }

  #withIntegrationLease(operation, workerId, callback) {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.store.transaction((state) => {
      const existing = state.integrationLease;
      if (existing && Date.parse(existing.expiresAt) > Date.now()) {
        throw new Error(`Integration authority is leased by ${existing.operation} for worker ${existing.workerId}.`);
      }
      state.integrationLease = { token, operation, workerId, acquiredAt: nowIso(), expiresAt };
    });
    try { return callback(); }
    catch (error) {
      if (operation === "apply") {
        this.store.transaction((state) => {
          state.integrationConflicts ??= [];
          state.integrationConflicts.push({
            id: `conflict-${randomUUID()}`, workerId, operation,
            error: String(error.message ?? error), recordedAt: nowIso()
          });
        });
      }
      throw error;
    }
    finally {
      this.store.transaction((state) => {
        if (state.integrationLease?.token === token) state.integrationLease = null;
      });
    }
  }

  async startWorker(options) {
    const workerId = assertSafeId(options.workerId, "workerId");
    const orchestrationId = assertSafeId(options.orchestrationId, "orchestrationId");
    const existing = this.store.load().workers[workerId];
    if (existing && !["closed", "crashed"].includes(existing.supervisorStatus)) throw new Error(`Worker ${workerId} already exists.`);
    const role = options.role ?? "luna";
    const requirementFiles = existing?.requirementFiles
      ?? (role === "luna" ? snapshotRequirementFiles(this.store, orchestrationId, workerId, options.cwd, options.requirementPaths ?? []) : []);
    const profile = role === "sol"
      ? {
          model: "gpt-5.6-sol", effort: options.effort ?? "high", sandbox: "read-only",
          approvalPolicy: "never", ephemeral: true,
          config: { model_context_window: 258000, model_auto_compact_token_limit: 220000 }
        }
      : { model: "gpt-5.6-luna", effort: "xhigh", sandbox: "workspace-write", approvalPolicy: "on-request", ephemeral: false, config: null };
    const client = await this.clientFactory(options.cwd, { role, profile });
    try {
      const models = await client.request("model/list", { includeHidden: true });
      const selected = models.data?.find((candidate) => candidate.model === profile.model || candidate.id === profile.model);
      if (!selected) throw Object.assign(new Error(`Required worker model ${profile.model} is unavailable; update Codex or select an account/provider that offers it.`), { code: "COMPATIBILITY" });
      const efforts = new Set((selected.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort));
      if (!efforts.has(profile.effort)) throw Object.assign(new Error(`Model ${profile.model} does not support required effort ${profile.effort}.`), { code: "COMPATIBILITY" });
    } catch (error) {
      await client.close().catch(() => {});
      if (!error.code) error.code = "COMPATIBILITY";
      throw error;
    }
    let workerCwd = options.workerCwd ?? options.cwd;
    let worktree = null;
    let absentInputs = existing?.absentInputs ?? { count: 0, paths: [], truncated: false };
    if (role === "luna" && options.isolated !== false) {
      absentInputs = absentWorktreeInputs(options.cwd);
      worktree = createTaskWorktree({
        repoRoot: options.cwd,
        workerId,
        base: options.base ?? "HEAD",
        worktreeRoot: options.worktreeRoot ?? this.store.artifactPath(orchestrationId, "worktrees")
      });
      workerCwd = worktree.worktree;
    } else if (role === "luna" && options.threadId && !fs.existsSync(workerCwd) && existing?.branch) {
      worktree = restoreTaskWorktree({ repoRoot: options.cwd, branch: existing.branch, worktree: workerCwd });
    }
    client.setNotificationHandler((message) => this.#handleNotification(workerId, message));
    client.setServerRequestHandler((message) => this.#handleServerRequest(workerId, message));
    let response;
    try {
      response = options.threadId
        ? await client.request("thread/resume", { threadId: options.threadId, cwd: workerCwd, model: profile.model, approvalPolicy: profile.approvalPolicy, sandbox: profile.sandbox, config: profile.config })
        : await client.request("thread/start", { cwd: workerCwd, model: profile.model, approvalPolicy: profile.approvalPolicy, sandbox: profile.sandbox, serviceName: "claude_code_codex_worker", ephemeral: profile.ephemeral, config: profile.config });
    } catch (error) {
      await client.close().catch(() => {});
      if (worktree && !options.threadId) {
        rollbackTaskWorktreeCreation({ repoRoot: options.cwd, worktree: worktree.worktree, branch: worktree.branch });
      }
      throw error;
    }
    const expectedSandboxType = profile.sandbox === "read-only" ? "readOnly" : "workspaceWrite";
    if (response.model !== undefined && response.model !== profile.model) throw Object.assign(new Error(`Codex selected ${response.model} instead of required ${profile.model}.`), { code: "COMPATIBILITY" });
    if (response.reasoningEffort !== undefined && response.reasoningEffort !== null && response.reasoningEffort !== profile.effort) throw Object.assign(new Error(`Codex selected effort ${response.reasoningEffort} instead of ${profile.effort}.`), { code: "COMPATIBILITY" });
    if (response.approvalPolicy !== undefined && !sameJson(response.approvalPolicy, profile.approvalPolicy)) throw Object.assign(new Error("Codex did not apply the required approval policy."), { code: "COMPATIBILITY" });
    if (response.sandbox?.type && response.sandbox.type !== expectedSandboxType) throw Object.assign(new Error(`Codex applied sandbox ${response.sandbox.type} instead of ${expectedSandboxType}.`), { code: "COMPATIBILITY" });
    if (response.cwd && fs.realpathSync(response.cwd) !== fs.realpathSync(workerCwd)) throw Object.assign(new Error("Codex thread cwd does not match the assigned worker directory."), { code: "COMPATIBILITY" });
    const record = {
      id: workerId, orchestrationId, role, cwd: workerCwd, integrationCwd: options.cwd,
      branch: worktree?.branch ?? existing?.branch ?? null,
      commonDir: worktree?.commonDir ?? existing?.commonDir ?? null,
      gitDir: worktree?.gitDir ?? existing?.gitDir ?? null,
      baseCommit: existing?.baseCommit ?? worktree?.base ?? null,
      model: profile.model,
      effort: profile.effort, sandbox: profile.sandbox, approvalPolicy: profile.approvalPolicy,
      supervisorStatus: "online", thread: { id: response.thread.id, status: "ready" },
      headCommit: existing?.headCommit ?? null, tree: existing?.tree ?? null,
      assignmentPaths: options.allowedPaths?.map(String).sort() ?? existing?.assignmentPaths ?? [],
      requirementFiles, absentInputs,
      turn: null, pendingRequest: null, createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso()
    };
    this.clients.set(workerId, client);
    this.store.transaction((state) => {
      state.workers[workerId] = record;
      state.capabilities ??= {};
      state.capabilities[role] = {
        checkedAt: nowIso(), model: profile.model, effort: profile.effort,
        sandbox: expectedSandboxType, approvalPolicy: profile.approvalPolicy,
        contextConfig: profile.config,
        verifiedMethods: ["model/list", options.threadId ? "thread/resume" : "thread/start"],
        requiredTurnMethods: ["turn/start", "turn/interrupt"],
        cliVersion: response.thread?.cliVersion ?? null
      };
    });
    if (client.exitPromise && typeof client.exitPromise.then === "function") {
      void client.exitPromise.then((error) => this.#handleTransportExit(workerId, error));
    }
    return record;
  }

  async send(workerId, prompt, idempotencyKey, turnOptions = {}) {
    assertSafeId(workerId, "workerId");
    assertSafeId(idempotencyKey, "idempotencyKey");
    const state = this.store.load();
    if (state.idempotency[idempotencyKey]) return state.idempotency[idempotencyKey];
    const worker = state.workers[workerId];
    if (!worker) throw new Error(`Unknown worker ${workerId}.`);
    if (worker.turn && !["completed", "failed", "interrupted", "indeterminate"].includes(worker.turn.status)) {
      throw new Error(`Worker ${workerId} already has an active turn.`);
    }
    const lunaSchema = worker.role === "luna" && turnOptions.outputSchema === undefined
      ? JSON.parse(fs.readFileSync(WORKER_SCHEMA_URL, "utf8"))
      : null;
    const rolePrompt = worker.role === "luna" && turnOptions.outputSchema === undefined
      ? `${fs.readFileSync(LUNA_PROMPT_URL, "utf8")}\n\nTask instruction:\n${String(prompt)}`
      : String(prompt);
    const entry = {
      id: `queue-${randomUUID()}`, workerId, prompt: rolePrompt, idempotencyKey,
      outputSchema: turnOptions.outputSchema ?? lunaSchema, queuedAt: nowIso()
    };
    if (worker.role === "luna") {
      const source = `${String(prompt).trim()}\n`;
      const instructionFile = this.store.writeArtifact(worker.orchestrationId, `tasks/${worker.id}/instructions/${entry.id}.md`, source);
      this.store.transaction((next) => {
        const record = next.workers[workerId];
        record.instructionFiles ??= [];
        record.instructionFiles.push({ file: instructionFile, hash: sha256(source), queuedAt: entry.queuedAt });
        if (!record.taskBriefFile) {
          record.taskBriefFile = instructionFile;
          record.taskBriefHash = sha256(source);
        }
      });
    }
    this.store.transaction((next) => {
      next.queue.push(entry);
      next.workers[workerId].turn = { id: null, status: "queued", slotHeld: false, queuedAt: entry.queuedAt };
    });
    const started = await this.#pump();
    const result = started.has(entry.id) ? { workerId, status: "running" } : { workerId, status: "queued" };
    this.store.transaction((next) => { next.idempotency[idempotencyKey] = result; });
    return result;
  }

  async startReview(params, idempotencyKey) {
    const reviewId = assertSafeId(params.reviewId, "reviewId");
    const orchestrationId = assertSafeId(params.orchestrationId, "orchestrationId");
    const reviewedWorker = params.workerId ? this.status(params.workerId) : null;
    if (reviewedWorker && (!reviewedWorker.baseCommit || !reviewedWorker.headCommit)) {
      throw new Error(`Worker ${params.workerId} has no coordinator-created commit to review.`);
    }
    const reviewCwd = reviewedWorker?.cwd ?? params.cwd;
    const targetOptions = reviewedWorker
      ? { range: `${reviewedWorker.baseCommit}..${reviewedWorker.headCommit}` }
      : (params.target ?? {});
    const target = resolveWorkerReviewTarget(reviewCwd, targetOptions);
    const maxInputTokens = params.maxInputTokens ?? 190000;
    if (!Number.isInteger(maxInputTokens) || maxInputTokens < 64 || maxInputTokens > 190000) {
      throw new Error("Review max-input-tokens must be an integer between 64 and 190000, preserving the 258K context reserves.");
    }
    let evidenceSections = [];
    if (params.taskReview) {
      if (!reviewedWorker) throw new Error("Task review requires an explicit Luna worker.");
      if (!reviewedWorker.taskBriefFile || !fs.existsSync(reviewedWorker.taskBriefFile)) throw new Error("Task review is missing its canonical task brief.");
      if (!reviewedWorker.reportFile || !fs.existsSync(reviewedWorker.reportFile) || !reviewedWorker.result) throw new Error("Task review is missing the validated Luna implementation report and test evidence.");
      if (!Array.isArray(reviewedWorker.assignmentPaths) || reviewedWorker.assignmentPaths.length === 0) throw new Error("Task review is missing the runtime-owned path assignment.");
      if (!Array.isArray(reviewedWorker.requirementFiles) || reviewedWorker.requirementFiles.length === 0) throw new Error("Task review requires at least one immutable requirement or specification file.");
      const lunaConstraints = fs.readFileSync(LUNA_PROMPT_URL, "utf8");
      evidenceSections = [
        {
          title: "Binding task brief and follow-up instructions",
          body: (reviewedWorker.instructionFiles ?? []).map((entry) => `### ${entry.hash}\n\n${fs.readFileSync(entry.file, "utf8")}`).join("\n")
        },
        {
          title: "Binding requirement and specification sources",
          body: reviewedWorker.requirementFiles.map((entry) => `### ${entry.sourcePath} (${entry.hash})\n\n${fs.readFileSync(entry.file, "utf8")}`).join("\n")
        },
        { title: "Validated Luna implementation report, tests, and concerns", body: fs.readFileSync(reviewedWorker.reportFile, "utf8") },
        {
          title: "Binding runtime constraints",
          body: JSON.stringify({
            workerId: reviewedWorker.id, model: reviewedWorker.model, effort: reviewedWorker.effort,
            sandbox: reviewedWorker.sandbox, approvalPolicy: reviewedWorker.approvalPolicy,
            baseCommit: reviewedWorker.baseCommit, headCommit: reviewedWorker.headCommit,
            tree: reviewedWorker.tree, allowedPaths: reviewedWorker.assignmentPaths,
            taskBriefHash: reviewedWorker.taskBriefHash,
            implementerConstraintHash: sha256(lunaConstraints),
            implementerConstraints: lunaConstraints
          }, null, 2)
        }
      ];
    }
    const reviewPackage = freezeReviewPackage(reviewCwd, target, {
      maxInputTokens,
      extraSections: evidenceSections
    });
    const schema = JSON.parse(fs.readFileSync(SOL_SCHEMA_URL, "utf8"));
    const promptTemplate = fs.readFileSync(params.taskReview ? SOL_TASK_PROMPT_URL : SOL_BRANCH_PROMPT_URL, "utf8");
    const packageFile = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/package.md`, reviewPackage.content);
    const packages = reviewPackage.requiresPartitioning
      ? reviewPackage.partitions.map((partition, index) => {
          if (partition.estimatedTokens > maxInputTokens) throw new Error("A Sol review pass exceeds the configured input bound.");
          const file = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/passes/${partition.id}.md`, partition.content);
          return { ...partition, file, passId: partition.id };
        })
      : [{ ...reviewPackage, file: packageFile, passId: "pass-1" }];
    const passReviews = [];
    for (let index = 0; index < packages.length; index += 1) {
      const item = packages[index];
      const executed = await this.#executeReviewPass({
        workerId: reviewWorkerId(reviewId, `p${index + 1}`),
        orchestrationId,
        cwd: path.dirname(item.file),
        effort: params.taskReview ? "high" : (params.effort ?? "xhigh"),
        prompt: `${promptTemplate}\n\nUse only the immutable evidence in this package; do not inspect any live repository or external path.\nReview package: ${item.file}\nPackage SHA-256: ${item.hash}`,
        schema,
        idempotencyKey: `${idempotencyKey}-pass-${index + 1}`,
        timeoutMs: params.timeoutMs,
        reviewId,
        passId: item.passId
      });
      passReviews.push({ passId: item.passId, paths: item.paths ?? [], packageHash: item.hash, review: executed.review });
      this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/passes/${item.passId}.json`, `${JSON.stringify(executed.review, null, 2)}\n`);
    }
    let review = passReviews[0].review;
    let finalWorker = null;
    if (passReviews.length > 1) {
      const synthesisFile = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/synthesis-input.json`, `${JSON.stringify({ coverageMap: reviewPackage.coverageMap, passReviews }, null, 2)}\n`);
      const synthesisTokens = Math.ceil(fs.statSync(synthesisFile).size / 4) + 1024;
      if (synthesisTokens > maxInputTokens) throw new Error("Sol synthesis evidence exceeds the configured input bound; narrow the review target.");
      const executed = await this.#executeReviewPass({
        workerId: reviewWorkerId(reviewId, "synth"), orchestrationId, cwd: path.dirname(synthesisFile), effort: "xhigh",
        prompt: `${promptTemplate}\n\nUse only ${synthesisFile}. Synthesize every bounded pass, preserve material findings, and fail cannot-verify if any coverage-map entry lacks a corresponding pass report.`,
        schema, idempotencyKey: `${idempotencyKey}-synthesis`, timeoutMs: params.timeoutMs,
        reviewId, passId: "synthesis"
      });
      review = executed.review;
      finalWorker = executed.worker;
    }
    const gate = evaluateReviewGate(review);
    const contextBudget = {
      contextWindow: 258000,
      packageInputLimit: maxInputTokens,
      fixedInstructionsAndSchemaReserve: 22000,
      toolExpansionReserve: 24000,
      outputReserve: 14000,
      measurementAndErrorReserve: 8000,
      unallocatedSafetyMargin: 258000 - maxInputTokens - 68000,
      requestedSettings: { modelContextWindow: 258000, autoCompactTokenLimit: 220000 },
      confirmedSettings: null,
      confirmationStatus: "Current app-server thread responses do not echo context settings; request was fail-closed on protocol error."
    };
    const reportFile = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/report.json`, `${JSON.stringify({ ...review, gate, packageHash: reviewPackage.hash, contextBudget }, null, 2)}\n`);
    const result = {
      id: reviewId, orchestrationId, status: "completed", reviewedWorkerId: params.workerId ?? null, workerId: finalWorker?.id ?? reviewWorkerId(reviewId, "p1"),
      threadId: finalWorker?.thread.id ?? this.status(reviewWorkerId(reviewId, "p1")).thread.id,
      specVerdict: review.specVerdict, qualityVerdict: review.qualityVerdict,
      findings: review.findings, summary: review.summary, gate, packageFile,
      packageHash: reviewPackage.hash, reportFile,
      contextBudget,
      effort: finalWorker?.effort ?? this.status(reviewWorkerId(reviewId, "p1")).effort,
      passCount: passReviews.length, synthesized: passReviews.length > 1,
      completedAt: nowIso()
    };
    this.store.transaction((state) => {
      state.reviews ??= {};
      if (params.workerId && state.workers[params.workerId]) {
        const worker = state.workers[params.workerId];
        const unchanged = worker.baseCommit === reviewedWorker.baseCommit
          && worker.headCommit === reviewedWorker.headCommit
          && worker.tree === reviewedWorker.tree;
        if (!unchanged) {
          result.status = "stale";
          result.gate = { status: "block", reason: "Worker Git facts changed while this review was running." };
          worker.reviewGate = null;
          worker.reviewBinding = null;
          state.reviews[reviewId] = result;
          return;
        }
        worker.reviewRound = (worker.reviewRound ?? 0) + 1;
        worker.reviewGate = result.gate.status;
        worker.reviewBinding = {
          reviewId,
          baseCommit: reviewedWorker.baseCommit,
          headCommit: reviewedWorker.headCommit,
          tree: reviewedWorker.tree,
          reviewTarget: structuredClone(target),
          packageFile, packageHash: reviewPackage.hash, gate: result.gate.status,
          round: worker.reviewRound,
          completedAt: result.completedAt
        };
      }
      state.reviews[reviewId] = result;
    });
    this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/report.json`, `${JSON.stringify({ ...review, status: result.status, gate: result.gate, packageHash: reviewPackage.hash, contextBudget }, null, 2)}\n`);
    return result;
  }

  async #executeReviewPass(options) {
    const worker = await this.startWorker({
      workerId: options.workerId,
      orchestrationId: options.orchestrationId,
      cwd: options.cwd,
      role: "sol",
      effort: options.effort
    });
    try {
      await this.send(worker.id, options.prompt, `${options.idempotencyKey}-turn`, { outputSchema: options.schema });
      let finished = await this.wait(worker.id, options.timeoutMs ?? 30 * 60 * 1000);
      if (finished.turn?.status !== "completed") throw new Error(`Sol review did not complete: ${finished.turn?.status ?? "unknown"}.`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const parsed = JSON.parse(finished.lastOutput ?? "");
          return { worker, review: validateSolReview(parsed, { reviewId: options.reviewId, passId: options.passId }) };
        } catch (error) {
          const diagnostic = String(finished.lastOutput ?? "").slice(0, 16384);
          this.store.writeArtifact(options.orchestrationId, `reviews/${options.reviewId}/passes/${options.passId}-invalid-${attempt + 1}.txt`, diagnostic);
          if (attempt === 1) throw new Error(`Sol returned invalid structured review output after one repair attempt: ${error.message}`);
          await this.send(
            worker.id,
            `Your previous structured review was invalid: ${error.message}. Return a corrected complete JSON review only; preserve all supported findings.`,
            `${options.idempotencyKey}-repair`,
            { outputSchema: options.schema }
          );
          finished = await this.wait(worker.id, options.timeoutMs ?? 30 * 60 * 1000);
          if (finished.turn?.status !== "completed") throw new Error(`Sol review repair did not complete: ${finished.turn?.status ?? "unknown"}.`);
        }
      }
      throw new Error("Sol review validation failed.");
    } finally {
      await this.close(worker.id).catch(() => {});
    }
  }

  // `turnError` is a top-level mirror of `turn.error` so a failed turn is visible to a controller
  // reading the head of a `worker wait`/`worker status` payload rather than only deep inside it.
  status(workerId) {
    const worker = this.store.load().workers[assertSafeId(workerId, "workerId")];
    if (!worker) throw new Error(`Unknown worker ${workerId}.`);
    const clone = structuredClone(worker);
    return { ...clone, turnError: clone.turn?.error ?? null };
  }

  list() {
    return Object.values(this.store.load().workers).map((worker) => {
      const clone = structuredClone(worker);
      return { ...clone, turnError: clone.turn?.error ?? null };
    });
  }

  async wait(workerId, timeoutMs = 0) {
    const current = this.status(workerId);
    if (!current.turn || ["completed", "failed", "interrupted", "indeterminate", "waiting-input", "waiting-approval"].includes(current.turn.status)) return current;
    return new Promise((resolve) => {
      const waiters = this.waiters.get(workerId) ?? [];
      const waiter = { resolve, timer: null };
      if (timeoutMs > 0) waiter.timer = setTimeout(() => resolve(this.status(workerId)), timeoutMs);
      waiters.push(waiter);
      this.waiters.set(workerId, waiters);
    });
  }

  resolveRequest(requestId, result, idempotencyKey) {
    assertSafeId(requestId, "requestId");
    assertSafeId(idempotencyKey, "idempotencyKey");
    const prior = this.store.load().idempotency[idempotencyKey];
    if (prior) return prior;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) throw new Error(`Request ${requestId} is already resolved, stale, or unknown.`);
    const worker = this.status(pending.workerId);
    const record = worker.pendingRequest;
    if (!record || record.id !== requestId || record.status !== "pending") throw new Error(`Request ${requestId} is stale.`);
    if (Date.parse(record.expiresAt) <= Date.now()) throw new Error(`Request ${requestId} has expired.`);
    if (record.threadId !== worker.thread.id || (record.turnId !== null && record.turnId !== worker.turn?.id)) throw new Error(`Request ${requestId} no longer matches the active thread and turn.`);
    validateRequestResult(record, result);
    const canResume = this.activeTurns < this.maxConcurrent;
    const response = { requestId, status: canResume ? "resolved" : "queued" };
    if (canResume) this.#completeResolution({ requestId, pending, result });
    else this.pendingResolutions.push({ requestId, pending, result });
    this.store.transaction((state) => { state.idempotency[idempotencyKey] = response; });
    return response;
  }

  #completeResolution({ requestId, pending, result }) {
    pending.client.respondToServerRequest(pending.serverRequestId, result);
    this.pendingRequests.delete(requestId);
    let resumedTurn = false;
    this.store.transaction((state) => {
      const worker = state.workers[pending.workerId];
      worker.pendingRequest = { ...worker.pendingRequest, status: "resolved", resolvedAt: nowIso() };
      if (worker.turn) {
        worker.turn.status = "running";
        worker.turn.slotHeld = true;
        resumedTurn = true;
      }
    });
    if (resumedTurn) this.activeTurns += 1;
  }

  async stop(workerId) {
    const worker = this.status(workerId);
    if (worker.pendingRequest?.status === "pending") {
      const pending = this.pendingRequests.get(worker.pendingRequest.id);
      pending?.client.rejectServerRequest?.(pending.serverRequestId, -32800, "Cancelled by controller");
      this.pendingRequests.delete(worker.pendingRequest.id);
      this.pendingResolutions = this.pendingResolutions.filter((entry) => entry.requestId !== worker.pendingRequest.id);
      this.store.transaction((state) => {
        state.workers[workerId].pendingRequest.status = "cancelled";
        state.workers[workerId].pendingRequest.resolvedAt = nowIso();
      });
    }
    if (worker.turn?.id && ["running", "waiting-input", "waiting-approval"].includes(worker.turn.status)) {
      await this.clients.get(workerId)?.request("turn/interrupt", { threadId: worker.thread.id, turnId: worker.turn.id });
      this.store.transaction((state) => {
        const record = state.capabilities?.[worker.role];
        if (record && !record.verifiedMethods.includes("turn/interrupt")) record.verifiedMethods.push("turn/interrupt");
      });
    }
    return this.status(workerId);
  }

  async close(workerId) {
    this.closingWorkers.add(workerId);
    await this.stop(workerId);
    await this.clients.get(workerId)?.close();
    this.clients.delete(workerId);
    this.store.transaction((state) => { state.workers[workerId].supervisorStatus = "closed"; });
    this.closingWorkers.delete(workerId);
    return this.status(workerId);
  }

  #handleTransportExit(workerId, error) {
    if (this.closingWorkers.has(workerId)) return;
    const current = this.store.load().workers[workerId];
    if (!current || current.supervisorStatus !== "online") return;
    const held = current.turn?.slotHeld === true;
    const requestId = current.pendingRequest?.status === "pending" ? current.pendingRequest.id : null;
    if (requestId) this.pendingRequests.delete(requestId);
    this.clients.delete(workerId);
    this.store.transaction((state) => {
      const worker = state.workers[workerId];
      worker.supervisorStatus = "crashed";
      worker.thread.status = "unavailable";
      if (worker.turn && !["completed", "failed", "interrupted"].includes(worker.turn.status)) {
        worker.turn.status = "indeterminate";
        worker.turn.slotHeld = false;
        worker.turn.error = `Codex app-server transport was lost: ${error?.message ?? "closed"}. Resume and retry explicitly.`;
      }
      if (worker.pendingRequest?.status === "pending") {
        worker.pendingRequest.status = "cancelled";
        worker.pendingRequest.resolvedAt = nowIso();
      }
    });
    if (held) this.activeTurns = Math.max(0, this.activeTurns - 1);
    this.#notifyWaiters(workerId);
    void this.#pump();
  }

  async #pump() {
    if (this.pumping) return new Set();
    this.pumping = true;
    const started = new Set();
    try {
      while (this.activeTurns < this.maxConcurrent) {
        const resolution = this.pendingResolutions.shift();
        if (resolution) {
          this.#completeResolution(resolution);
          continue;
        }
        const entry = this.store.load().queue[0];
        if (!entry) break;
        this.store.transaction((state) => {
          state.queue.shift();
          state.inFlightQueue ??= {};
          state.inFlightQueue[entry.id] = { ...entry, claimedAt: nowIso() };
          state.workers[entry.workerId].turn.slotHeld = true;
        });
        this.activeTurns += 1;
        started.add(entry.id);
        void this.#startEntry(entry).catch((error) => this.#failEntry(entry, error));
      }
    } finally { this.pumping = false; }
    return started;
  }

  async #startEntry(entry) {
    const worker = this.status(entry.workerId);
    const client = this.clients.get(entry.workerId);
    if (!client) throw new Error(`Worker ${entry.workerId} is not connected.`);
    const response = await client.request("turn/start", {
      threadId: worker.thread.id, input: turnInput(entry.prompt), model: worker.model,
      effort: worker.effort, outputSchema: entry.outputSchema
    });
    this.store.transaction((state) => {
      delete state.inFlightQueue?.[entry.id];
      const capability = state.capabilities?.[worker.role];
      if (capability && !capability.verifiedMethods.includes("turn/start")) capability.verifiedMethods.push("turn/start");
      const turn = state.workers[entry.workerId].turn;
      if (turn.status === "queued" || turn.status === "running") {
        state.workers[entry.workerId].turn = { id: response.turn.id, status: "running", slotHeld: true, startedAt: nowIso() };
      }
    });
  }

  #handleNotification(workerId, message) {
    if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "agentMessage" && item.text) {
        const worker = this.status(workerId);
        const rawOutputFile = this.store.writeArtifact(worker.orchestrationId, `workers/${workerId}/latest-output.txt`, item.text);
        this.store.transaction((state) => {
          state.workers[workerId].lastOutput = boundedOutput(item.text);
          state.workers[workerId].rawOutputFile = rawOutputFile;
        });
      }
      return;
    }
    if (message.method !== "turn/started" && message.method !== "turn/completed") return;
    let terminal = false;
    this.store.transaction((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;
      if (message.method === "turn/started") {
        worker.turn = { id: message.params.turn.id, status: "running", slotHeld: worker.turn?.slotHeld === true, startedAt: nowIso() };
      } else {
        const status = message.params.turn.status;
        const turnError = message.params.turn.error;
        worker.turn = { ...(worker.turn ?? {}), id: message.params.turn.id, status: status === "completed" ? "completed" : status, completedAt: nowIso() };
        if (turnError) worker.turn.error = typeof turnError === "string" ? turnError : JSON.stringify(turnError);
        terminal = worker.turn.slotHeld === true;
        worker.turn.slotHeld = false;
      }
    });
    if (terminal) {
      if (message.params.turn.status === "completed") this.#finalizeWorkerResult(workerId);
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      this.#notifyWaiters(workerId);
      void this.#pump();
    }
  }

  #finalizeWorkerResult(workerId) {
    const worker = this.status(workerId);
    if (worker.role !== "luna") return;
    try {
      const result = validateWorkerResult(JSON.parse(worker.lastOutput ?? ""));
      const reportFile = this.store.writeArtifact(
        worker.orchestrationId,
        `tasks/${worker.id}/implementation-report.json`,
        `${JSON.stringify(result, null, 2)}\n`
      );
      this.store.transaction((state) => {
        state.workers[workerId].result = result;
        state.workers[workerId].reportFile = reportFile;
      });
    } catch (error) {
      this.store.transaction((state) => {
        state.workers[workerId].turn.status = "failed";
        state.workers[workerId].turn.error = `Invalid structured worker output: ${error.message}`;
      });
    }
  }

  #handleServerRequest(workerId, message) {
    const isInput = INPUT_METHODS.has(message.method);
    const isApproval = APPROVAL_METHODS.has(message.method);
    if (!isInput && !isApproval) throw new Error(`Unsupported server request: ${message.method}`);
    const requestId = `req-${randomUUID()}`;
    const worker = this.status(workerId);
    const threadId = message.params?.threadId ?? worker.thread.id;
    const turnId = message.params?.turnId === undefined ? (worker.turn?.id ?? null) : message.params.turnId;
    if (worker.role === "sol" && isApproval) throw new Error("Sol review workers cannot request mutation approval.");
    if (threadId !== worker.thread.id || (message.method !== "mcpServer/elicitation/request" && (!turnId || turnId !== worker.turn?.id)) || (message.method === "mcpServer/elicitation/request" && turnId !== null && turnId !== worker.turn?.id)) {
      throw new Error("Server request does not match the active worker thread and turn.");
    }
    const payload = sanitizeRequestValue(message.params ?? {});
    const record = {
      id: requestId, status: "pending", method: message.method,
      threadId,
      turnId,
      itemId: message.params?.itemId ?? null, approvalId: message.params?.approvalId ?? null,
      isBlocking: true,
      payload,
      allowedDecisions: allowedRequestDecisions(message.method, message.params),
      createdAt: nowIso(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    };
    this.pendingRequests.set(requestId, { workerId, client: this.clients.get(workerId), serverRequestId: message.id });
    const held = worker.turn?.slotHeld === true;
    this.store.transaction((state) => {
      state.workers[workerId].pendingRequest = record;
      if (state.workers[workerId].turn) {
        state.workers[workerId].turn.status = isApproval ? "waiting-approval" : "waiting-input";
        state.workers[workerId].turn.slotHeld = false;
      }
    });
    if (held) this.activeTurns = Math.max(0, this.activeTurns - 1);
    this.#notifyWaiters(workerId);
    void this.#pump();
  }

  #failEntry(entry, error) {
    const workerId = entry.workerId;
    const held = this.status(workerId).turn?.slotHeld === true;
    if (held) this.activeTurns = Math.max(0, this.activeTurns - 1);
    this.store.transaction((state) => {
      delete state.inFlightQueue?.[entry.id];
      state.recoveryQueue ??= [];
      state.recoveryQueue.push({ ...entry, recoveryStatus: "failed-to-start", error: String(error.message ?? error), recoveredAt: nowIso() });
      state.workers[workerId].turn = { ...(state.workers[workerId].turn ?? {}), status: "failed", slotHeld: false, error: String(error.message ?? error), completedAt: nowIso() };
    });
    this.#notifyWaiters(workerId);
    void this.#pump();
  }

  #notifyWaiters(workerId) {
    const current = this.status(workerId);
    for (const waiter of this.waiters.get(workerId) ?? []) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(current);
    }
    this.waiters.delete(workerId);
  }
}
