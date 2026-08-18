import { randomUUID } from "node:crypto";

import { CodexAppServerClient } from "./app-server.mjs";
import { assertSafeId } from "./worker-protocol.mjs";
import { createWorkerStore } from "./worker-state.mjs";

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
        result = await this.startWorker({ ...record, workerId: record.id, threadId: record.thread.id, cwd: record.cwd });
        break;
      }
      case "worker.resolve-request": return this.resolveRequest(params.requestId, params.result, idempotencyKey);
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
    if (existing && existing.supervisorStatus !== "closed") throw new Error(`Worker ${workerId} already exists.`);
    const role = options.role ?? "luna";
    const profile = role === "sol"
      ? { model: "gpt-5.6-sol", effort: options.effort ?? "high", sandbox: "read-only", approvalPolicy: "never", ephemeral: true }
      : { model: "gpt-5.6-luna", effort: "xhigh", sandbox: "workspace-write", approvalPolicy: "on-request", ephemeral: false };
    const client = await this.clientFactory(options.cwd, { role, profile });
    client.setNotificationHandler((message) => this.#handleNotification(workerId, message));
    client.setServerRequestHandler((message) => this.#handleServerRequest(workerId, message));
    const response = options.threadId
      ? await client.request("thread/resume", { threadId: options.threadId, cwd: options.cwd, model: profile.model, approvalPolicy: profile.approvalPolicy, sandbox: profile.sandbox })
      : await client.request("thread/start", { cwd: options.cwd, model: profile.model, approvalPolicy: profile.approvalPolicy, sandbox: profile.sandbox, serviceName: "claude_code_codex_worker", ephemeral: profile.ephemeral });
    const record = {
      id: workerId, orchestrationId, role, cwd: options.cwd, model: profile.model,
      effort: profile.effort, sandbox: profile.sandbox, approvalPolicy: profile.approvalPolicy,
      supervisorStatus: "online", thread: { id: response.thread.id, status: "ready" },
      turn: null, pendingRequest: null, createdAt: nowIso(), updatedAt: nowIso()
    };
    this.clients.set(workerId, client);
    this.store.transaction((state) => { state.workers[workerId] = record; });
    return record;
  }

  async send(workerId, prompt, idempotencyKey) {
    assertSafeId(workerId, "workerId");
    assertSafeId(idempotencyKey, "idempotencyKey");
    const state = this.store.load();
    if (state.idempotency[idempotencyKey]) return state.idempotency[idempotencyKey];
    const worker = state.workers[workerId];
    if (!worker) throw new Error(`Unknown worker ${workerId}.`);
    if (worker.turn && !["completed", "failed", "interrupted", "indeterminate"].includes(worker.turn.status)) {
      throw new Error(`Worker ${workerId} already has an active turn.`);
    }
    const entry = { id: `queue-${randomUUID()}`, workerId, prompt: String(prompt), idempotencyKey, queuedAt: nowIso() };
    this.store.transaction((next) => {
      next.queue.push(entry);
      next.workers[workerId].turn = { id: null, status: "queued", queuedAt: entry.queuedAt };
    });
    const started = await this.#pump();
    const result = started.has(entry.id) ? { workerId, status: "running" } : { workerId, status: "queued" };
    this.store.transaction((next) => { next.idempotency[idempotencyKey] = result; });
    return result;
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
      effort: worker.effort, outputSchema: null
    });
    this.store.transaction((state) => {
      const turn = state.workers[entry.workerId].turn;
      if (turn.status === "queued" || turn.status === "running") {
        state.workers[entry.workerId].turn = { id: response.turn.id, status: "running", startedAt: nowIso() };
      }
    });
  }

  #handleNotification(workerId, message) {
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
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      this.#notifyWaiters(workerId);
      void this.#pump();
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
