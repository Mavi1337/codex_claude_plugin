import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { WorkerCoordinator } from "../plugins/codex/scripts/lib/worker-coordinator.mjs";

const IMPLEMENTER_PROFILE = { role: "implementer", model: "gpt-6-astra", effort: "low" };
const REVIEWER_PROFILE = { role: "reviewer", model: "gpt-6-astra", effort: "low" };

for (const [role, model, effort] of [
  ["implementer", "gpt-5.6-luna", "high"],
  ["reviewer", "gpt-5.6-sol", "xhigh"],
  ["implementer", "gpt-6-astra", "low"],
  ["reviewer", "gpt-6-astra", "high"],
  ["reviewer", "gpt-5.6-luna", "medium"],
  ["implementer", "gpt-5.6-sol", "high"]
]) {
  test(`${role} forwards ${model}/${effort} on start, resume and turns`, async () => {
    const cwd = makeTempDir("coordinator-profile-");
    initGitRepo(cwd);
    run("git", ["commit", "--allow-empty", "-m", "base"], { cwd });
    const clients = [];
    const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("profile-data-"), clientFactory: async () => {
      const client = new FakeClient(); clients.push(client); return client;
    } });
    const worker = await coordinator.dispatch("worker.start", {
      workerId: "profile", orchestrationId: "profile", cwd, role, model, effort
    }, "start-profile");
    assert.equal(worker.role, role);
    assert.equal(worker.model, model);
    assert.equal(worker.effort, effort);
    if (role === "implementer") assert.notEqual(worker.cwd, cwd);
    else assert.equal(worker.cwd, cwd);
    const started = clients[0].requests.find((entry) => entry.method === "thread/start").params;
    assert.equal(started.model, model);
    assert.equal(started.config.model_reasoning_effort, effort);
    assert.equal(started.sandbox, role === "implementer" ? "workspace-write" : "read-only");
    assert.equal(started.approvalPolicy, role === "implementer" ? "on-request" : "never");
    assert.equal(started.ephemeral, role === "reviewer");
    await coordinator.send(worker.id, "Perform the assigned task", "profile-turn");
    assert.equal(clients[0].startedTurns[0].params.model, model);
    assert.equal(clients[0].startedTurns[0].params.effort, effort);
    await coordinator.close(worker.id);
    const resumed = await coordinator.dispatch("worker.resume", { workerId: worker.id }, "resume-profile");
    assert.equal(resumed.thread.id, worker.thread.id);
    const request = clients[1].requests.find((entry) => entry.method === "thread/resume").params;
    assert.equal(request.model, model);
    assert.equal(request.config.model_reasoning_effort, effort);
    assert.equal(request.sandbox, started.sandbox);
    assert.equal(request.approvalPolicy, started.approvalPolicy);
    await coordinator.send(worker.id, "Continue", "profile-resumed-turn");
    assert.equal(clients[1].startedTurns[0].params.model, model);
    assert.equal(clients[1].startedTurns[0].params.effort, effort);
    await coordinator.close(worker.id);
  });
}

test("coordinator requires model and effort even for duplicate start requests", async () => {
  const cwd = makeTempDir("coordinator-required-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("required-data-"), clientFactory: async () => {
    assert.fail("invalid profiles must fail before opening an app-server");
  } });
  for (const operation of ["worker.start", "review.start"]) {
    for (const missing of ["model", "effort"]) {
      for (const value of [undefined, "", "   "]) {
        const params = { workerId: "required", reviewId: "required", orchestrationId: "required", cwd, ...REVIEWER_PROFILE, [missing]: value };
        await assert.rejects(coordinator.dispatch(operation, params, "new-key"), new RegExp(`${missing}.*required`, "i"));
        coordinator.store.transaction((state) => { state.idempotency.cached = { status: "running" }; });
        await assert.rejects(coordinator.dispatch(operation, params, "cached"), new RegExp(`${missing}.*required`, "i"));
      }
    }
  }
  assert.deepEqual(coordinator.list(), []);
  assert.deepEqual(coordinator.store.load().reviews, {});
});

test("discovery accepts future models and efforts from later model/list pages without rewriting them", async () => {
  const cwd = makeTempDir("coordinator-future-");
  initGitRepo(cwd);
  const cursors = [];
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method !== "model/list") return request(method, params);
    cursors.push(params.cursor ?? null);
    assert.equal(params.includeHidden, true);
    return params.cursor === "page-2"
      ? { data: [{ id: "provider/future", model: "provider/future", supportedReasoningEfforts: [{ reasoningEffort: "adaptive" }] }], nextCursor: null }
      : { data: [], nextCursor: "page-2" };
  };
  const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("future-data-"), clientFactory: async () => client });
  const worker = await coordinator.startWorker({ workerId: "future", orchestrationId: "future", cwd, role: "reviewer", model: "provider/future", effort: "adaptive" });
  assert.deepEqual(cursors, [null, "page-2"]);
  await coordinator.send(worker.id, "Review", "future-turn");
  assert.equal(client.startedTurns[0].params.model, "provider/future");
  assert.equal(client.startedTurns[0].params.effort, "adaptive");
});

for (const [model, effort] of [["unavailable-model", "high"], ["gpt-6-astra", "unsupported-effort"], [" gpt-6-astra ", "high"]]) {
  test(`unavailable profile ${model}/${effort} fails compatibly before thread creation`, async () => {
    const cwd = makeTempDir("coordinator-unavailable-");
    initGitRepo(cwd);
    const client = new FakeClient();
    const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("unavailable-data-"), clientFactory: async () => client });
    await assert.rejects(coordinator.startWorker({ workerId: "bad", orchestrationId: "bad", cwd, role: "reviewer", model, effort }), { code: "COMPATIBILITY" });
    assert.equal(client.requests.some((entry) => entry.method.startsWith("thread/")), false);
    assert.equal(client.closed, true);
    assert.deepEqual(coordinator.list(), []);
  });
}

for (const [legacyRole, role, model, effort] of [["luna", "implementer", "gpt-5.6-luna", "high"], ["sol", "reviewer", "gpt-5.6-sol", "xhigh"]]) {
  test(`persisted ${legacyRole} resumes as ${role} without changing identity or profile`, async () => {
    const cwd = makeTempDir("coordinator-legacy-");
    initGitRepo(cwd);
    const clients = [];
    const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("legacy-data-"), clientFactory: async () => {
      const client = new FakeClient(); clients.push(client); return client;
    } });
    coordinator.store.transaction((state) => {
      state.workers.legacy = { id: "legacy", orchestrationId: "old-orchestration", role: legacyRole, cwd, integrationCwd: cwd,
        model, effort, supervisorStatus: "closed", thread: { id: "old-thread", status: "ready" }, createdAt: "2026-08-18T00:00:00Z",
        taskBriefFile: "/saved/brief.md", reportFile: "/saved/report.json", result: { status: "completed" },
        instructionFiles: [{ file: "/saved/brief.md", hash: "saved-hash" }], reviewBinding: { reviewId: "saved-review" } };
    });
    const resumed = await coordinator.dispatch("worker.resume", { workerId: "legacy" }, "resume-legacy");
    assert.equal(resumed.role, role);
    assert.equal(coordinator.store.load().workers.legacy.role, role);
    assert.equal(resumed.thread.id, "old-thread");
    assert.equal(resumed.createdAt, "2026-08-18T00:00:00Z");
    assert.equal(resumed.taskBriefFile, "/saved/brief.md");
    assert.equal(resumed.reportFile, "/saved/report.json");
    assert.equal(resumed.result.status, "completed");
    assert.equal(resumed.instructionFiles[0].hash, "saved-hash");
    assert.equal(resumed.reviewBinding.reviewId, "saved-review");
    const params = clients[0].requests.find((entry) => entry.method === "thread/resume").params;
    assert.equal(params.model, model);
    assert.equal(params.config.model_reasoning_effort, effort);
    await coordinator.send("legacy", "Continue the saved task", "legacy-turn");
    assert.equal(clients[0].startedTurns[0].params.model, model);
    assert.equal(clients[0].startedTurns[0].params.effort, effort);
    await coordinator.close("legacy");
    for (const workerId of ["legacy", "new-worker"]) {
      await assert.rejects(coordinator.dispatch("worker.start", {
        workerId, orchestrationId: "new-orchestration", cwd, role: legacyRole, model, effort, threadId: "old-thread", isolated: false
      }, `reject-${workerId}`), /legacy role|use implementer or reviewer/i);
    }
  });
}

test("worker.start protocol cannot bypass implementer isolation or masquerade as resume", async () => {
  const cwd = makeTempDir("coordinator-isolation-");
  initGitRepo(cwd);
  run("git", ["commit", "--allow-empty", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("isolation-data-"), clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "isolated", orchestrationId: "isolated", cwd, ...IMPLEMENTER_PROFILE, isolated: false, workerCwd: cwd
  }, "start-isolated");
  assert.notEqual(worker.cwd, cwd);
  await assert.rejects(coordinator.dispatch("worker.start", {
    workerId: "forged-resume", orchestrationId: "isolated", cwd, ...IMPLEMENTER_PROFILE, threadId: worker.thread.id
  }, "forged-resume"), /worker.resume/i);
});

test("thread profile substitution closes the app-server and rolls back a new worktree", async () => {
  const cwd = makeTempDir("coordinator-substitution-");
  initGitRepo(cwd);
  run("git", ["commit", "--allow-empty", "-m", "base"], { cwd });
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    const response = await request(method, params);
    if (method === "thread/start") response.model = "substituted-model";
    return response;
  };
  const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("substitution-data-"), clientFactory: async () => client });
  await assert.rejects(coordinator.startWorker({ workerId: "substituted", orchestrationId: "profile", cwd, ...IMPLEMENTER_PROFILE }), { code: "COMPATIBILITY" });
  assert.equal(client.closed, true);
  const assignedCwd = client.requests.find((entry) => entry.method === "thread/start").params.cwd;
  assert.equal(fs.existsSync(assignedCwd), false);
  assert.deepEqual(coordinator.list(), []);
});

test("reviewers reject every mutation approval method without persisting an approvable request", async () => {
  const cwd = makeTempDir("coordinator-readonly-");
  initGitRepo(cwd);
  const client = new FakeClient();
  const coordinator = new WorkerCoordinator({ cwd, dataRoot: makeTempDir("readonly-data-"), clientFactory: async () => client });
  const worker = await coordinator.startWorker({ workerId: "readonly", orchestrationId: "readonly", cwd, ...REVIEWER_PROFILE });
  await coordinator.send(worker.id, "Review", "readonly-turn");
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    assert.throws(() => client.serverRequests({ id: 41, method, params: { threadId: worker.thread.id, turnId: "turn-1" } }), /cannot request mutation approval/i);
    assert.equal(coordinator.status(worker.id).pendingRequest, null);
    assert.equal(client.lastResponse, undefined);
  }
});

class FakeClient {
  constructor() {
    this.notifications = null;
    this.serverRequests = null;
    this.startedTurns = [];
    this.requests = [];
    this.exitPromise = new Promise((resolve) => { this.exit = resolve; });
  }
  setNotificationHandler(handler) { this.notifications = handler; }
  setServerRequestHandler(handler) { this.serverRequests = handler; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "model/list") return { data: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"].map((model) => ({
      id: model, model, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort }))
    })), nextCursor: null };
    if (method === "thread/start") return { thread: { id: `thread-${params.cwd.split("/").pop()}` }, model: params.model, reasoningEffort: params.effort ?? null, cwd: params.cwd, approvalPolicy: params.approvalPolicy, sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly" } };
    if (method === "thread/resume") return { thread: { id: params.threadId }, model: params.model, reasoningEffort: params.effort ?? null, cwd: params.cwd, approvalPolicy: params.approvalPolicy, sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly" } };
    if (method === "turn/start") {
      const turn = { id: `turn-${this.startedTurns.length + 1}`, status: "inProgress" };
      this.startedTurns.push({ params, turn });
      queueMicrotask(() => this.notifications?.({ method: "turn/started", params: { threadId: params.threadId, turn } }));
      return { turn };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected ${method}`);
  }
  respondToServerRequest(id, result) { this.lastResponse = { id, result }; }
  async close() { this.closed = true; }
  complete(index = 0) {
    const entry = this.startedTurns[index];
    this.notifications?.({ method: "turn/completed", params: { threadId: entry.params.threadId, turn: { ...entry.turn, status: "completed" } } });
  }
}

class DelayedReviewClient extends FakeClient {
  releaseReview() {
    const payload = JSON.stringify({
      schemaVersion: 1,
      specVerdict: "pass",
      qualityVerdict: "approve",
      summary: "Reviewed frozen package.",
      findings: []
    });
    this.notifications?.({ method: "item/completed", params: { item: { type: "agentMessage", text: payload } } });
    this.complete();
  }
}

class GlobalEffortPinnedClient extends FakeClient {
  constructor() {
    super();
    this.threadRequests = [];
  }
  async request(method, params) {
    if (method === "thread/start" || method === "thread/resume") {
      this.threadRequests.push({ method, params });
      const response = await super.request(method, params);
      response.reasoningEffort = params.config?.model_reasoning_effort ?? "xhigh";
      return response;
    }
    return super.request(method, params);
  }
}

test("transport loss durably marks a running worker indeterminate", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "implementer-lost", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-lost", "work", "send-lost");
  await new Promise((resolve) => setImmediate(resolve));
  client.exit(new Error("transport lost"));
  await new Promise((resolve) => setImmediate(resolve));
  const worker = coordinator.status("implementer-lost");
  assert.equal(worker.supervisorStatus, "crashed");
  assert.equal(worker.turn.status, "indeterminate");
});

test("coordinator queues turns above the repository concurrency limit", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const clients = [];
  const coordinator = new WorkerCoordinator({
    cwd,
    dataRoot,
    maxConcurrent: 1,
    clientFactory: async () => { const client = new FakeClient(); clients.push(client); return client; }
  });
  await coordinator.startWorker({ workerId: "implementer-1", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.startWorker({ workerId: "implementer-2", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });

  const first = await coordinator.send("implementer-1", "first", "send-1");
  const second = await coordinator.send("implementer-2", "second", "send-2");
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.equal(clients[1].startedTurns.length, 0);

  clients[0].complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients[1].startedTurns.length, 1);
});

test("coordinator exposes blocking requests and rejects conflicting resolution", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "implementer-1", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-1", "first", "send-1");
  await new Promise((resolve) => setImmediate(resolve));
  client.serverRequests({
    id: 41,
    method: "item/tool/requestUserInput",
    params: {
      threadId: coordinator.status("implementer-1").thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{ id: "choice", question: "Continue?", options: [{ label: "yes" }, { label: "no" }] }]
    }
  });

  const waiting = coordinator.status("implementer-1");
  assert.equal(waiting.turn.status, "waiting-input");
  assert.equal(waiting.pendingRequest.payload.questions[0].question, "Continue?");
  const resolved = await coordinator.resolveRequest(waiting.pendingRequest.id, { answers: { choice: { answers: ["yes"] } } }, "resolve-1");
  assert.equal(resolved.status, "resolved");
  assert.throws(() => coordinator.resolveRequest(waiting.pendingRequest.id, {}, "resolve-2"), /already resolved/i);
});

test("coordinator rejects expired or malformed approval decisions", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "implementer-approval", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-approval", "first", "send-approval");
  await new Promise((resolve) => setImmediate(resolve));
  const worker = coordinator.status("implementer-approval");
  client.serverRequests({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: worker.thread.id, turnId: "turn-1", command: "npm test", reason: "verify", availableDecisions: ["accept", "decline"] }
  });
  const request = coordinator.status("implementer-approval").pendingRequest;
  assert.deepEqual(request.allowedDecisions, ["accept", "decline"]);
  assert.equal(request.payload.command, "npm test");
  assert.throws(() => coordinator.resolveRequest(request.id, { decision: "allow-forever" }, "bad-decision"), /decision/i);
  coordinator.store.transaction((state) => { state.workers["implementer-approval"].pendingRequest.expiresAt = new Date(0).toISOString(); });
  assert.throws(() => coordinator.resolveRequest(request.id, { decision: "accept" }, "expired-decision"), /expired/i);
});

test("permission approvals use the generated permissions response shape", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "implementer-permission", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-permission", "work", "send-permission");
  await new Promise((resolve) => setImmediate(resolve));
  const worker = coordinator.status("implementer-permission");
  client.serverRequests({
    id: 44,
    method: "item/permissions/requestApproval",
    params: { threadId: worker.thread.id, turnId: worker.turn.id, itemId: "item-1", cwd, reason: "write tests", permissions: { fileSystem: { write: [cwd] } } }
  });
  const request = coordinator.status("implementer-permission").pendingRequest;
  assert.throws(() => coordinator.resolveRequest(request.id, { decision: "accept" }, "permission-invalid"), /permissions/i);
  assert.throws(() => coordinator.resolveRequest(request.id, {
    permissions: {}, scope: null
  }, "permission-invalid-scope"), /scope/i);
  assert.throws(() => coordinator.resolveRequest(request.id, {
    permissions: { network: { enabled: "yes" } }, scope: "turn"
  }, "permission-invalid-nested"), /enabled/i);
  const valid = { permissions: { network: null, fileSystem: { write: [cwd] } }, scope: "turn", strictAutoReview: null };
  const resolved = coordinator.resolveRequest(request.id, valid, "permission-valid");
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(client.lastResponse.result, valid);
});

test("standalone URL elicitations accept the generated nullable response shape", async () => {
  const cwd = makeTempDir("coordinator-mcp-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  const worker = await coordinator.startWorker({ workerId: "implementer-mcp", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  client.serverRequests({
    id: 45,
    method: "mcpServer/elicitation/request",
    params: { threadId: worker.thread.id, turnId: null, mode: "url", serverName: "example", message: "Open the login page?", url: "https://example.test", elicitationId: "elicit-1" }
  });
  const request = coordinator.status(worker.id).pendingRequest;
  assert.equal(coordinator.status(worker.id).turn, null);
  const valid = { action: "accept", content: null, _meta: null };
  const resolved = coordinator.resolveRequest(request.id, valid, "resolve-mcp");
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(client.lastResponse.result, valid);
});

test("a blocked turn reacquires the repository slot before it resumes", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const clients = [];
  const coordinator = new WorkerCoordinator({
    cwd, dataRoot, maxConcurrent: 1,
    clientFactory: async () => { const client = new FakeClient(); clients.push(client); return client; }
  });
  await coordinator.startWorker({ workerId: "implementer-a", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.startWorker({ workerId: "implementer-b", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-a", "a", "send-a");
  await new Promise((resolve) => setImmediate(resolve));
  clients[0].serverRequests({
    id: 43, method: "item/tool/requestUserInput",
    params: { threadId: coordinator.status("implementer-a").thread.id, turnId: "turn-1", questions: [] }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.send("implementer-b", "b", "send-b");
  const request = coordinator.status("implementer-a").pendingRequest;
  const resolution = coordinator.resolveRequest(request.id, { answers: {} }, "resolve-a");
  assert.equal(resolution.status, "queued");
  assert.equal(clients[0].lastResponse, undefined);
  clients[1].complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients[0].lastResponse.id, 43);
});

test("coordinator dispatch uses explicit operations and idempotency", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const started = await coordinator.dispatch("worker.start", {
    workerId: "reviewer-1", orchestrationId: "orch-1", cwd, ...REVIEWER_PROFILE
  }, "start-reviewer-1");
  assert.equal(started.model, "gpt-6-astra");
  const listed = await coordinator.dispatch("worker.list", {}, "list-1");
  assert.deepEqual(listed.map((worker) => worker.id), ["reviewer-1"]);
  await assert.rejects(() => coordinator.dispatch("worker.unknown", {}, "bad-1"), /unsupported worker operation/i);
});

test("worker thread requests override a globally pinned reasoning effort on start and resume", async () => {
  const cwd = makeTempDir("coordinator-effort-");
  const dataRoot = makeTempDir("coordinator-effort-data-");
  initGitRepo(cwd);
  const clients = [];
  const clientFactory = async () => {
    const client = new GlobalEffortPinnedClient();
    clients.push(client);
    return client;
  };
  const first = new WorkerCoordinator({ cwd, dataRoot, clientFactory });
  const started = await first.startWorker({
    workerId: "reviewer-pinned", orchestrationId: "orch-1", cwd, ...REVIEWER_PROFILE
  });
  assert.deepEqual(clients[0].threadRequests[0].params.config, {
    model_context_window: 258000,
    model_auto_compact_token_limit: 220000,
    model_reasoning_effort: "low"
  });

  const second = new WorkerCoordinator({ cwd, dataRoot, clientFactory });
  await second.dispatch("worker.resume", { workerId: started.id }, "resume-reviewer-pinned");
  assert.equal(clients[1].threadRequests[0].method, "thread/resume");
  assert.deepEqual(clients[1].threadRequests[0].params.config, clients[0].threadRequests[0].params.config);
});

test("coordinator shutdown flushes blocking waiters with a restart marker", async () => {
  const cwd = makeTempDir("coordinator-shutdown-wait-");
  const dataRoot = makeTempDir("coordinator-shutdown-wait-data-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  await coordinator.startWorker({ workerId: "implementer-shutdown-wait", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-shutdown-wait", "work", "send-shutdown-wait");
  await new Promise((resolve) => setImmediate(resolve));

  const waiting = coordinator.wait("implementer-shutdown-wait");
  await coordinator.dispatch("coordinator.shutdown", {}, "shutdown-wait");
  const result = await Promise.race([
    waiting,
    new Promise((resolve) => setTimeout(() => resolve(null), 100))
  ]);
  assert.equal(result?.coordinator, "restarting");
  assert.equal(coordinator.waiters.size, 0);
});

test("controller ruling can explicitly waive cannot-verify but not failed quality", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  coordinator.store.transaction((state) => {
    state.workers["implementer-rule"] = { id: "implementer-rule", reviewGate: "block", reviewBinding: { reviewId: "review-rule", gate: "block" } };
    state.reviews["review-rule"] = {
      id: "review-rule", status: "completed", reviewedWorkerId: "implementer-rule",
      orchestrationId: "orch-1", reportFile: coordinator.store.writeArtifact("orch-1", "reviews/review-rule/report.json", JSON.stringify({ gate: { status: "block" } })),
      specVerdict: "cannot-verify", qualityVerdict: "approve", findings: [], summary: "Missing external evidence."
    };
  });
  const ruled = await coordinator.dispatch("review.rule", {
    reviewId: "review-rule", reason: "Controller supplied and checked the missing external evidence.", waiveCannotVerify: true
  }, "rule-key");
  assert.equal(ruled.gate.status, "pass-with-ruling");
  assert.equal(coordinator.status("implementer-rule").reviewGate, "pass-with-ruling");
  const report = JSON.parse(fs.readFileSync(ruled.reportFile, "utf8"));
  assert.equal(report.gate.status, "pass-with-ruling");
  assert.equal(report.controllerRuling.reason, "Controller supplied and checked the missing external evidence.");
});

test("review start claims idempotency before long-running side effects", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  let finish;
  coordinator.startReview = () => new Promise((resolve) => { finish = resolve; });
  const first = await coordinator.dispatch("review.start", { reviewId: "review-long", orchestrationId: "orch-1", cwd, model: "gpt-6-astra", effort: "low" }, "review-long-key");
  assert.equal(first.status, "running");
  const duplicate = await coordinator.dispatch("review.start", { reviewId: "review-long", orchestrationId: "orch-1", cwd, model: "gpt-6-astra", effort: "low" }, "review-long-key");
  assert.equal(duplicate.status, "running");
  assert.equal(coordinator.store.load().reviews["review-long"].status, "running");
  finish({ id: "review-long", status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.store.load().idempotency["review-long-key"].status, "completed");
});

test("coordinator is the trusted commit authority for Implementer worktrees", async () => {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "implementer-commit", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, allowedPaths: ["app.js"]
  }, "start-commit");
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-done", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "two\n");

  const committed = await coordinator.dispatch("integration.commit", {
    workerId: "implementer-commit", message: "task: change app", allowedPaths: ["app.js"]
  }, "commit-1");
  assert.equal(committed.paths[0], "app.js");
  assert.equal(coordinator.status("implementer-commit").headCommit, committed.commit);
});

test("a later Implementer commit invalidates the exact review binding", async () => {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "implementer-reviewed", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, allowedPaths: ["app.js"]
  }, "start-reviewed");
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-done", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "two\n");
  const first = await coordinator.dispatch("integration.commit", {
    workerId: worker.id, message: "first", allowedPaths: ["app.js"]
  }, "commit-first");
  coordinator.store.transaction((state) => {
    state.workers[worker.id].reviewGate = "pass";
    state.workers[worker.id].reviewBinding = {
      reviewId: "review-1", baseCommit: worker.baseCommit, headCommit: first.commit,
      tree: first.tree, packageHash: "a".repeat(64), gate: "pass"
    };
  });

  fs.writeFileSync(path.join(worker.cwd, "app.js"), "three\n");
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-done-2", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  await coordinator.dispatch("integration.commit", {
    workerId: worker.id, message: "second", allowedPaths: ["app.js"]
  }, "commit-second");

  const updated = coordinator.status(worker.id);
  assert.equal(updated.reviewGate, null);
  assert.equal(updated.reviewBinding, null);
  await assert.rejects(
    () => coordinator.dispatch("integration.apply", { workerId: worker.id, expectedHead: worker.baseCommit }, "apply-stale"),
    /not passed|binding/i
  );
});

test("an in-flight H1 review cannot bind or integrate a later H2 commit", async () => {
  const cwd = makeTempDir("coordinator-race-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "base\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  let reviewerClient;
  const coordinator = new WorkerCoordinator({
    cwd,
    dataRoot,
    clientFactory: async (_clientCwd, options) => {
      const client = options.role === "reviewer" ? new DelayedReviewClient() : new FakeClient();
      if (options.role === "reviewer") reviewerClient = client;
      return client;
    }
  });
  const worker = await coordinator.startWorker({
    workerId: "implementer-race", orchestrationId: "orch-race", cwd, ...IMPLEMENTER_PROFILE, allowedPaths: ["app.js"]
  });
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-h1", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "h1\n");
  const h1 = await coordinator.dispatch("integration.commit", {
    workerId: worker.id, message: "h1", allowedPaths: ["app.js"]
  }, "commit-h1");

  const accepted = await coordinator.dispatch("review.start", {
    reviewId: "review-race", orchestrationId: "orch-race", workerId: worker.id, cwd, model: "gpt-6-astra", effort: "low"
  }, "review-race-key");
  assert.equal(accepted.status, "running");
  while (!reviewerClient?.startedTurns.length) await new Promise((resolve) => setImmediate(resolve));

  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-h2", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "h2\n");
  const h2 = await coordinator.dispatch("integration.commit", {
    workerId: worker.id, message: "h2", allowedPaths: ["app.js"]
  }, "commit-h2");
  assert.notEqual(h1.commit, h2.commit);
  reviewerClient.releaseReview();
  while (coordinator.store.load().reviews["review-race"].status === "running") await new Promise((resolve) => setImmediate(resolve));

  const review = coordinator.store.load().reviews["review-race"];
  assert.equal(review.status, "stale");
  assert.equal(review.gate.status, "block");
  assert.equal(coordinator.status(worker.id).reviewBinding, null);
  await assert.rejects(
    () => coordinator.dispatch("integration.apply", { workerId: worker.id, expectedHead: worker.baseCommit }, "apply-race"),
    /have not passed an exact review or controller ruling binding/i
  );
});

test("coordinator restart marks in-flight work indeterminate and resumes the saved thread", async () => {
  const cwd = makeTempDir("coordinator-restart-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const first = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const started = await first.startWorker({ workerId: "implementer-restart", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await first.send("implementer-restart", "work", "send-restart");

  const second = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const crashed = second.status("implementer-restart");
  assert.equal(crashed.supervisorStatus, "crashed");
  assert.equal(crashed.turn.status, "indeterminate");
  const resumed = await second.dispatch("worker.resume", { workerId: "implementer-restart" }, "resume-restart");
  assert.equal(resumed.thread.id, started.thread.id);
  assert.equal(resumed.supervisorStatus, "online");
});

test("coordinator restart reconciles a running review and permits explicit retry", async () => {
  const cwd = makeTempDir("coordinator-review-restart-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const first = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  first.store.transaction((state) => {
    const running = { id: "review-stuck", status: "running", startedAt: new Date().toISOString() };
    state.reviews["review-stuck"] = running;
    state.idempotency["review-old-key"] = running;
  });
  const second = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  assert.equal(second.store.load().reviews["review-stuck"].status, "indeterminate");
  assert.equal((await second.dispatch("review.status", { reviewId: "review-stuck" }, "status-stuck")).status, "indeterminate");
  second.startReview = async () => ({ id: "review-stuck", status: "completed" });
  const retried = await second.dispatch("review.start", {
    reviewId: "review-stuck", orchestrationId: "orch-1", cwd, model: "gpt-6-astra", effort: "low"
  }, "review-new-key");
  assert.equal(retried.status, "running");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.store.load().idempotency["review-new-key"].status, "completed");
});

async function committedImplementerWorker(workerId) {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId, orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, allowedPaths: ["app.js"]
  }, `start-${workerId}`);
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-done", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "two\n");
  const commit = await coordinator.dispatch("integration.commit", {
    workerId, message: "task: change app", allowedPaths: ["app.js"]
  }, `commit-${workerId}`);
  return { coordinator, cwd, worker, commit };
}

test("a recorded controller ruling integrates a commit with no review", async () => {
  const { coordinator, worker, commit } = await committedImplementerWorker("implementer-ruled");
  const binding = await coordinator.dispatch("integration.rule", {
    workerId: worker.id, reason: "reviews disabled for this lane by the operator."
  }, "rule-1");
  assert.equal(binding.kind, "controller-ruling");
  assert.equal(binding.gate, "pass-with-ruling");
  assert.equal(binding.headCommit, commit.commit);
  assert.match(coordinator.store.load().controllerRulings[0].reason, /reviews disabled/);

  const applied = await coordinator.dispatch("integration.apply", {
    workerId: worker.id, expectedHead: worker.baseCommit
  }, "apply-ruled");
  assert.deepEqual(applied.commits, [commit.commit]);
});

test("a controller ruling requires a reason and a committed worktree", async () => {
  const { coordinator, worker } = await committedImplementerWorker("implementer-ruled-bad");
  await assert.rejects(
    () => coordinator.dispatch("integration.rule", { workerId: worker.id, reason: "   " }, "rule-blank"),
    /requires a reason/i
  );
  coordinator.store.transaction((state) => { state.workers[worker.id].headCommit = null; });
  await assert.rejects(
    () => coordinator.dispatch("integration.rule", { workerId: worker.id, reason: "why" }, "rule-uncommitted"),
    /requires a committed task worktree/i
  );
});

test("a later commit invalidates a controller ruling just as it invalidates a review", async () => {
  const { coordinator, worker } = await committedImplementerWorker("implementer-ruled-stale");
  await coordinator.dispatch("integration.rule", { workerId: worker.id, reason: "operator ruling" }, "rule-stale");
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "three\n");
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-done-2", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  await coordinator.dispatch("integration.commit", {
    workerId: worker.id, message: "second", allowedPaths: ["app.js"]
  }, "commit-stale-second");

  assert.equal(coordinator.status(worker.id).reviewGate, null);
  await assert.rejects(
    () => coordinator.dispatch("integration.apply", { workerId: worker.id, expectedHead: worker.baseCommit }, "apply-stale-ruling"),
    /have not passed/i
  );
});

test("worker start reports inputs a fresh task worktree will not carry", async () => {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".venv/\n");
  run("git", ["add", "app.js", ".gitignore"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.mkdirSync(path.join(cwd, ".venv"));
  fs.writeFileSync(path.join(cwd, ".venv", "pyvenv.cfg"), "home = /usr\n");
  fs.writeFileSync(path.join(cwd, "scratch.csv"), "a,b\n");

  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "implementer-inputs", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, allowedPaths: ["app.js"]
  }, "start-inputs");
  assert.ok(worker.absentInputs.paths.includes("scratch.csv"));
  assert.ok(worker.absentInputs.paths.some((entry) => entry.startsWith(".venv")));
  assert.equal(fs.existsSync(path.join(worker.cwd, "scratch.csv")), false);
});

test("a failed turn surfaces its error at the head of the worker payload", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "implementer-failed", orchestrationId: "orch-1", cwd, ...IMPLEMENTER_PROFILE, isolated: false });
  await coordinator.send("implementer-failed", "work", "send-failed");
  await new Promise((resolve) => setImmediate(resolve));
  const entry = client.startedTurns[0];
  client.notifications?.({
    method: "turn/completed",
    params: { threadId: entry.params.threadId, turn: { ...entry.turn, status: "failed", error: { message: "invalid_json_schema" } } }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const worker = coordinator.status("implementer-failed");
  assert.equal(worker.turn.status, "failed");
  assert.match(worker.turnError, /invalid_json_schema/);
  assert.equal(worker.result, undefined);
  assert.match(coordinator.list().find((entry) => entry.id === "implementer-failed").turnError, /invalid_json_schema/);
});
