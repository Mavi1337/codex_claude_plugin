import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { CodexAppServerClient } from "./app-server.mjs";
import { assertSafeId } from "./worker-protocol.mjs";
import { createWorkerStore } from "./worker-state.mjs";
import { applyReviewedCommits, commitTaskWorktree, createTaskWorktree } from "./worker-worktree.mjs";
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
  "item/permissions/requestApproval",
  "item/tool/requestPermission"
]);

function nowIso() { return new Date().toISOString(); }
function turnInput(prompt) { return [{ type: "text", text: prompt, text_elements: [] }]; }

export class WorkerCoordinator {
  constructor(options) {
    this.cwd = options.cwd;
    this.store = options.store ?? createWorkerStore(options.cwd, { dataRoot: options.dataRoot });
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.clientFactory = options.clientFactory ?? ((cwd, clientOptions) => CodexAppServerClient.connect(cwd, { ...clientOptions, disableBroker: true }));
    this.clients = new Map();
    this.pendingRequests = new Map();
    this.waiters = new Map();
    this.activeTurns = 0;
    this.pumping = false;
    const persisted = this.store.load();
    const recoverable = Object.values(persisted.workers).filter((worker) => worker.supervisorStatus === "online");
    if (recoverable.length) {
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
        state.queue = [];
      });
    }
  }

  async dispatch(operation, params, idempotencyKey) {
    assertSafeId(idempotencyKey, "idempotencyKey");
    const prior = this.store.load().idempotency[idempotencyKey];
    if (prior) return prior;
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
        result = commitTaskWorktree(worker.cwd, { message: params.message, allowedPaths: params.allowedPaths });
        this.store.transaction((state) => {
          state.workers[params.workerId].headCommit = result.commit;
          state.workers[params.workerId].tree = result.tree;
        });
        break;
      }
      case "integration.apply": {
        const worker = this.status(params.workerId);
        if (worker.reviewGate !== "pass") throw new Error("Worker changes have not passed the Sol review gate.");
        result = applyReviewedCommits({
          integrationCwd: worker.integrationCwd,
          expectedHead: params.expectedHead,
          base: worker.baseCommit,
          head: worker.headCommit
        });
        break;
      }
      case "review.start": result = await this.startReview(params, idempotencyKey); break;
      case "review.status":
      case "review.result": {
        result = this.store.load().reviews?.[assertSafeId(params.reviewId, "reviewId")];
        if (!result) throw new Error(`Unknown review ${params.reviewId}.`);
        break;
      }
      case "coordinator.status": result = {
        status: "online", repositoryId: this.store.identity.repositoryId,
        activeTurns: this.activeTurns, queuedTurns: this.store.load().queue.length,
        workerCount: this.list().length, maxConcurrent: this.maxConcurrent
      }; break;
      case "coordinator.shutdown": result = { status: "shutting-down" }; break;
      default: throw new Error(`Unsupported worker operation: ${operation}.`);
    }
    this.store.transaction((state) => { state.idempotency[idempotencyKey] = result; });
    return result;
  }

  async startWorker(options) {
    const workerId = assertSafeId(options.workerId, "workerId");
    const orchestrationId = assertSafeId(options.orchestrationId, "orchestrationId");
    const existing = this.store.load().workers[workerId];
    if (existing && !["closed", "crashed"].includes(existing.supervisorStatus)) throw new Error(`Worker ${workerId} already exists.`);
    const role = options.role ?? "luna";
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
    if (role === "luna" && options.isolated !== false) {
      worktree = createTaskWorktree({
        repoRoot: options.cwd,
        workerId,
        base: options.base ?? "HEAD",
        worktreeRoot: options.worktreeRoot ?? this.store.artifactPath(orchestrationId, "worktrees")
      });
      workerCwd = worktree.worktree;
    }
    client.setNotificationHandler((message) => this.#handleNotification(workerId, message));
    client.setServerRequestHandler((message) => this.#handleServerRequest(workerId, message));
    const response = options.threadId
      ? await client.request("thread/resume", { threadId: options.threadId, cwd: workerCwd, model: profile.model, approvalPolicy: profile.approvalPolicy, sandbox: profile.sandbox, config: profile.config })
      : await client.request("thread/start", { cwd: workerCwd, model: profile.model, approvalPolicy: profile.approvalPolicy, sandbox: profile.sandbox, serviceName: "claude_code_codex_worker", ephemeral: profile.ephemeral, config: profile.config });
    const record = {
      id: workerId, orchestrationId, role, cwd: workerCwd, integrationCwd: options.cwd,
      branch: worktree?.branch ?? existing?.branch ?? null,
      baseCommit: worktree?.base ?? existing?.baseCommit ?? null,
      model: profile.model,
      effort: profile.effort, sandbox: profile.sandbox, approvalPolicy: profile.approvalPolicy,
      supervisorStatus: "online", thread: { id: response.thread.id, status: "ready" },
      headCommit: existing?.headCommit ?? null, tree: existing?.tree ?? null,
      turn: null, pendingRequest: null, createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso()
    };
    this.clients.set(workerId, client);
    this.store.transaction((state) => { state.workers[workerId] = record; });
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
    this.store.transaction((next) => {
      next.queue.push(entry);
      next.workers[workerId].turn = { id: null, status: "queued", queuedAt: entry.queuedAt };
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
    const reviewPackage = freezeReviewPackage(reviewCwd, target, { maxInputTokens: params.maxInputTokens ?? 190000 });
    const schema = JSON.parse(fs.readFileSync(SOL_SCHEMA_URL, "utf8"));
    const promptTemplate = fs.readFileSync(params.taskReview ? SOL_TASK_PROMPT_URL : SOL_BRANCH_PROMPT_URL, "utf8");
    const maxInputTokens = params.maxInputTokens ?? 190000;
    const packageFile = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/package.md`, reviewPackage.content);
    const packages = reviewPackage.partitions.length > 1
      ? reviewPackage.partitions.map((partition, index) => {
          const scoped = freezeReviewPackage(reviewCwd, { ...target, paths: partition.paths }, { maxInputTokens });
          const file = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/passes/pass-${index + 1}.md`, scoped.content);
          return { ...scoped, file, passId: `pass-${index + 1}` };
        })
      : [{ ...reviewPackage, file: packageFile, passId: "pass-1" }];
    const passReviews = [];
    for (let index = 0; index < packages.length; index += 1) {
      const item = packages[index];
      const executed = await this.#executeReviewPass({
        workerId: `sol-${reviewId}-p${index + 1}`,
        orchestrationId,
        cwd: reviewCwd,
        effort: params.taskReview ? "high" : (params.effort ?? "xhigh"),
        prompt: `${promptTemplate}\n\nReview package: ${item.file}\nPackage SHA-256: ${item.hash}`,
        schema,
        idempotencyKey: `${idempotencyKey}-pass-${index + 1}`,
        timeoutMs: params.timeoutMs,
        reviewId,
        passId: item.passId
      });
      passReviews.push(executed.review);
      this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/passes/${item.passId}.json`, `${JSON.stringify(executed.review, null, 2)}\n`);
    }
    let review = passReviews[0];
    let finalWorker = null;
    if (passReviews.length > 1) {
      const synthesisFile = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/synthesis-input.json`, `${JSON.stringify(passReviews, null, 2)}\n`);
      const executed = await this.#executeReviewPass({
        workerId: `sol-${reviewId}-synth`, orchestrationId, cwd: reviewCwd, effort: "xhigh",
        prompt: `${promptTemplate}\n\nSynthesize every bounded pass in ${synthesisFile}. Preserve material findings and verify coverage.`,
        schema, idempotencyKey: `${idempotencyKey}-synthesis`, timeoutMs: params.timeoutMs,
        reviewId, passId: "synthesis"
      });
      review = executed.review;
      finalWorker = executed.worker;
    }
    const gate = evaluateReviewGate(review);
    const reportFile = this.store.writeArtifact(orchestrationId, `reviews/${reviewId}/report.json`, `${JSON.stringify({ ...review, gate, packageHash: reviewPackage.hash }, null, 2)}\n`);
    const result = {
      id: reviewId, status: "completed", workerId: finalWorker?.id ?? `sol-${reviewId}-p1`,
      threadId: finalWorker?.thread.id ?? this.status(`sol-${reviewId}-p1`).thread.id,
      specVerdict: review.specVerdict, qualityVerdict: review.qualityVerdict,
      findings: review.findings, summary: review.summary, gate, packageFile,
      packageHash: reviewPackage.hash, reportFile,
      effort: finalWorker?.effort ?? this.status(`sol-${reviewId}-p1`).effort,
      passCount: passReviews.length, synthesized: passReviews.length > 1,
      completedAt: nowIso()
    };
    this.store.transaction((state) => {
      state.reviews ??= {};
      state.reviews[reviewId] = result;
      if (params.workerId && state.workers[params.workerId]) state.workers[params.workerId].reviewGate = gate.status;
    });
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
    await this.send(worker.id, options.prompt, `${options.idempotencyKey}-turn`, { outputSchema: options.schema });
    const finished = await this.wait(worker.id, options.timeoutMs ?? 30 * 60 * 1000);
    if (finished.turn?.status !== "completed") throw new Error(`Sol review did not complete: ${finished.turn?.status ?? "unknown"}.`);
    let parsed;
    try { parsed = JSON.parse(finished.lastOutput ?? ""); }
    catch (error) { throw new Error(`Sol returned invalid structured review output: ${error.message}`); }
    return { worker, review: validateSolReview(parsed, { reviewId: options.reviewId, passId: options.passId }) };
  }

  status(workerId) {
    const worker = this.store.load().workers[assertSafeId(workerId, "workerId")];
    if (!worker) throw new Error(`Unknown worker ${workerId}.`);
    return structuredClone(worker);
  }

  list() { return Object.values(this.store.load().workers).map((worker) => structuredClone(worker)); }

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
    pending.client.respondToServerRequest(pending.serverRequestId, result);
    this.pendingRequests.delete(requestId);
    const response = { requestId, status: "resolved" };
    this.store.transaction((state) => {
      const worker = state.workers[pending.workerId];
      worker.pendingRequest = { ...worker.pendingRequest, status: "resolved", resolvedAt: nowIso() };
      worker.turn.status = "running";
      state.idempotency[idempotencyKey] = response;
    });
    this.activeTurns += 1;
    return response;
  }

  async stop(workerId) {
    const worker = this.status(workerId);
    if (worker.pendingRequest?.status === "pending") {
      const pending = this.pendingRequests.get(worker.pendingRequest.id);
      pending?.client.rejectServerRequest?.(pending.serverRequestId, -32800, "Cancelled by controller");
      this.pendingRequests.delete(worker.pendingRequest.id);
    }
    if (worker.turn?.id && ["running", "waiting-input", "waiting-approval"].includes(worker.turn.status)) {
      await this.clients.get(workerId)?.request("turn/interrupt", { threadId: worker.thread.id, turnId: worker.turn.id });
    }
    return this.status(workerId);
  }

  async close(workerId) {
    await this.stop(workerId);
    await this.clients.get(workerId)?.close();
    this.clients.delete(workerId);
    this.store.transaction((state) => { state.workers[workerId].supervisorStatus = "closed"; });
    return this.status(workerId);
  }

  async #pump() {
    if (this.pumping) return new Set();
    this.pumping = true;
    const started = new Set();
    try {
      while (this.activeTurns < this.maxConcurrent) {
        const entry = this.store.load().queue[0];
        if (!entry) break;
        this.store.transaction((state) => { state.queue.shift(); });
        this.activeTurns += 1;
        started.add(entry.id);
        void this.#startEntry(entry).catch((error) => this.#failEntry(entry.workerId, error));
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
      const turn = state.workers[entry.workerId].turn;
      if (turn.status === "queued" || turn.status === "running") {
        state.workers[entry.workerId].turn = { id: response.turn.id, status: "running", startedAt: nowIso() };
      }
    });
  }

  #handleNotification(workerId, message) {
    if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "agentMessage" && item.text) {
        this.store.transaction((state) => { state.workers[workerId].lastOutput = item.text; });
      }
      return;
    }
    if (message.method !== "turn/started" && message.method !== "turn/completed") return;
    let terminal = false;
    this.store.transaction((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;
      if (message.method === "turn/started") {
        worker.turn = { id: message.params.turn.id, status: "running", startedAt: nowIso() };
      } else {
        const status = message.params.turn.status;
        worker.turn = { ...(worker.turn ?? {}), id: message.params.turn.id, status: status === "completed" ? "completed" : status, completedAt: nowIso() };
        terminal = true;
      }
    });
    if (terminal) {
      this.#finalizeWorkerResult(workerId);
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
    const record = {
      id: requestId, status: "pending", method: message.method,
      threadId: message.params?.threadId ?? worker.thread.id,
      turnId: message.params?.turnId ?? worker.turn?.id ?? null,
      itemId: message.params?.itemId ?? null, approvalId: message.params?.approvalId ?? null,
      isBlocking: true, createdAt: nowIso(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    };
    this.pendingRequests.set(requestId, { workerId, client: this.clients.get(workerId), serverRequestId: message.id });
    this.store.transaction((state) => {
      state.workers[workerId].pendingRequest = record;
      state.workers[workerId].turn.status = isApproval ? "waiting-approval" : "waiting-input";
    });
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    this.#notifyWaiters(workerId);
    void this.#pump();
  }

  #failEntry(workerId, error) {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    this.store.transaction((state) => {
      state.workers[workerId].turn = { ...(state.workers[workerId].turn ?? {}), status: "failed", error: String(error.message ?? error), completedAt: nowIso() };
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
