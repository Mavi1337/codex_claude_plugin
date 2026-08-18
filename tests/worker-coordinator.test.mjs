import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { WorkerCoordinator } from "../plugins/codex/scripts/lib/worker-coordinator.mjs";

class FakeClient {
  constructor() {
    this.notifications = null;
    this.serverRequests = null;
    this.startedTurns = [];
    this.exitPromise = new Promise((resolve) => { this.exit = resolve; });
  }
  setNotificationHandler(handler) { this.notifications = handler; }
  setServerRequestHandler(handler) { this.serverRequests = handler; }
  async request(method, params) {
    if (method === "model/list") return { data: [
      { id: "gpt-5.6-luna", model: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] },
      { id: "gpt-5.6-sol", model: "gpt-5.6-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] }
    ] };
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
  async close() {}
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

test("transport loss durably marks a running worker indeterminate", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "luna-lost", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.send("luna-lost", "work", "send-lost");
  await new Promise((resolve) => setImmediate(resolve));
  client.exit(new Error("transport lost"));
  await new Promise((resolve) => setImmediate(resolve));
  const worker = coordinator.status("luna-lost");
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
  await coordinator.startWorker({ workerId: "luna-1", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.startWorker({ workerId: "luna-2", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });

  const first = await coordinator.send("luna-1", "first", "send-1");
  const second = await coordinator.send("luna-2", "second", "send-2");
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
  await coordinator.startWorker({ workerId: "luna-1", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.send("luna-1", "first", "send-1");
  await new Promise((resolve) => setImmediate(resolve));
  client.serverRequests({
    id: 41,
    method: "item/tool/requestUserInput",
    params: {
      threadId: coordinator.status("luna-1").thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{ id: "choice", question: "Continue?", options: [{ label: "yes" }, { label: "no" }] }]
    }
  });

  const waiting = coordinator.status("luna-1");
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
  await coordinator.startWorker({ workerId: "luna-approval", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.send("luna-approval", "first", "send-approval");
  await new Promise((resolve) => setImmediate(resolve));
  const worker = coordinator.status("luna-approval");
  client.serverRequests({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: worker.thread.id, turnId: "turn-1", command: "npm test", reason: "verify", availableDecisions: ["accept", "decline"] }
  });
  const request = coordinator.status("luna-approval").pendingRequest;
  assert.deepEqual(request.allowedDecisions, ["accept", "decline"]);
  assert.equal(request.payload.command, "npm test");
  assert.throws(() => coordinator.resolveRequest(request.id, { decision: "allow-forever" }, "bad-decision"), /decision/i);
  coordinator.store.transaction((state) => { state.workers["luna-approval"].pendingRequest.expiresAt = new Date(0).toISOString(); });
  assert.throws(() => coordinator.resolveRequest(request.id, { decision: "accept" }, "expired-decision"), /expired/i);
});

test("permission approvals use the generated permissions response shape", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  let client;
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => (client = new FakeClient()) });
  await coordinator.startWorker({ workerId: "luna-permission", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.send("luna-permission", "work", "send-permission");
  await new Promise((resolve) => setImmediate(resolve));
  const worker = coordinator.status("luna-permission");
  client.serverRequests({
    id: 44,
    method: "item/permissions/requestApproval",
    params: { threadId: worker.thread.id, turnId: worker.turn.id, itemId: "item-1", cwd, reason: "write tests", permissions: { fileSystem: { write: [cwd] } } }
  });
  const request = coordinator.status("luna-permission").pendingRequest;
  assert.throws(() => coordinator.resolveRequest(request.id, { decision: "accept" }, "permission-invalid"), /permissions/i);
  const valid = { permissions: { fileSystem: { write: [cwd] } }, scope: "turn", strictAutoReview: true };
  const resolved = coordinator.resolveRequest(request.id, valid, "permission-valid");
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
  await coordinator.startWorker({ workerId: "luna-a", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.startWorker({ workerId: "luna-b", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await coordinator.send("luna-a", "a", "send-a");
  await new Promise((resolve) => setImmediate(resolve));
  clients[0].serverRequests({
    id: 43, method: "item/tool/requestUserInput",
    params: { threadId: coordinator.status("luna-a").thread.id, turnId: "turn-1", questions: [] }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.send("luna-b", "b", "send-b");
  const request = coordinator.status("luna-a").pendingRequest;
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
    workerId: "sol-1", orchestrationId: "orch-1", cwd, role: "sol"
  }, "start-sol-1");
  assert.equal(started.model, "gpt-5.6-sol");
  const listed = await coordinator.dispatch("worker.list", {}, "list-1");
  assert.deepEqual(listed.map((worker) => worker.id), ["sol-1"]);
  await assert.rejects(() => coordinator.dispatch("worker.unknown", {}, "bad-1"), /unsupported worker operation/i);
});

test("controller ruling can explicitly waive cannot-verify but not failed quality", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  coordinator.store.transaction((state) => {
    state.workers["luna-rule"] = { id: "luna-rule", reviewGate: "block", reviewBinding: { reviewId: "review-rule", gate: "block" } };
    state.reviews["review-rule"] = {
      id: "review-rule", status: "completed", reviewedWorkerId: "luna-rule",
      specVerdict: "cannot-verify", qualityVerdict: "approve", findings: [], summary: "Missing external evidence."
    };
  });
  const ruled = await coordinator.dispatch("review.rule", {
    reviewId: "review-rule", reason: "Controller supplied and checked the missing external evidence.", waiveCannotVerify: true
  }, "rule-key");
  assert.equal(ruled.gate.status, "pass-with-ruling");
  assert.equal(coordinator.status("luna-rule").reviewGate, "pass-with-ruling");
});

test("review start claims idempotency before long-running side effects", async () => {
  const cwd = makeTempDir("coordinator-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  let finish;
  coordinator.startReview = () => new Promise((resolve) => { finish = resolve; });
  const first = await coordinator.dispatch("review.start", { reviewId: "review-long", orchestrationId: "orch-1", cwd }, "review-long-key");
  assert.equal(first.status, "running");
  const duplicate = await coordinator.dispatch("review.start", { reviewId: "review-long", orchestrationId: "orch-1", cwd }, "review-long-key");
  assert.equal(duplicate.status, "running");
  assert.equal(coordinator.store.load().reviews["review-long"].status, "running");
  finish({ id: "review-long", status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.store.load().idempotency["review-long-key"].status, "completed");
});

test("coordinator is the trusted commit authority for Luna worktrees", async () => {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "luna-commit", orchestrationId: "orch-1", cwd, role: "luna", allowedPaths: ["app.js"]
  }, "start-commit");
  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-done", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "two\n");

  const committed = await coordinator.dispatch("integration.commit", {
    workerId: "luna-commit", message: "task: change app", allowedPaths: ["app.js"]
  }, "commit-1");
  assert.equal(committed.paths[0], "app.js");
  assert.equal(coordinator.status("luna-commit").headCommit, committed.commit);
});

test("a later Luna commit invalidates the exact review binding", async () => {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "luna-reviewed", orchestrationId: "orch-1", cwd, role: "luna", allowedPaths: ["app.js"]
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
  let solClient;
  const coordinator = new WorkerCoordinator({
    cwd,
    dataRoot,
    clientFactory: async (_clientCwd, options) => {
      const client = options.role === "sol" ? new DelayedReviewClient() : new FakeClient();
      if (options.role === "sol") solClient = client;
      return client;
    }
  });
  const worker = await coordinator.startWorker({
    workerId: "luna-race", orchestrationId: "orch-race", cwd, role: "luna", allowedPaths: ["app.js"]
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
    reviewId: "review-race", orchestrationId: "orch-race", workerId: worker.id, cwd
  }, "review-race-key");
  assert.equal(accepted.status, "running");
  while (!solClient?.startedTurns.length) await new Promise((resolve) => setImmediate(resolve));

  coordinator.store.transaction((state) => {
    state.workers[worker.id].turn = { id: "turn-h2", status: "completed" };
    state.workers[worker.id].result = { status: "completed" };
  });
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "h2\n");
  const h2 = await coordinator.dispatch("integration.commit", {
    workerId: worker.id, message: "h2", allowedPaths: ["app.js"]
  }, "commit-h2");
  assert.notEqual(h1.commit, h2.commit);
  solClient.releaseReview();
  while (coordinator.store.load().reviews["review-race"].status === "running") await new Promise((resolve) => setImmediate(resolve));

  const review = coordinator.store.load().reviews["review-race"];
  assert.equal(review.status, "stale");
  assert.equal(review.gate.status, "block");
  assert.equal(coordinator.status(worker.id).reviewBinding, null);
  await assert.rejects(
    () => coordinator.dispatch("integration.apply", { workerId: worker.id, expectedHead: worker.baseCommit }, "apply-race"),
    /review binding/i
  );
});

test("coordinator restart marks in-flight work indeterminate and resumes the saved thread", async () => {
  const cwd = makeTempDir("coordinator-restart-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  const first = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const started = await first.startWorker({ workerId: "luna-restart", orchestrationId: "orch-1", cwd, role: "luna", isolated: false });
  await first.send("luna-restart", "work", "send-restart");

  const second = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const crashed = second.status("luna-restart");
  assert.equal(crashed.supervisorStatus, "crashed");
  assert.equal(crashed.turn.status, "indeterminate");
  const resumed = await second.dispatch("worker.resume", { workerId: "luna-restart" }, "resume-restart");
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
    reviewId: "review-stuck", orchestrationId: "orch-1", cwd
  }, "review-new-key");
  assert.equal(retried.status, "running");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.store.load().idempotency["review-new-key"].status, "completed");
});
