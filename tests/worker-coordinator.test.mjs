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
  }
  setNotificationHandler(handler) { this.notifications = handler; }
  setServerRequestHandler(handler) { this.serverRequests = handler; }
  async request(method, params) {
    if (method === "thread/start") return { thread: { id: `thread-${params.cwd.split("/").pop()}` } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
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
  client.serverRequests({ id: 41, method: "item/tool/requestUserInput", params: { threadId: "thread-x", turnId: "turn-1", itemId: "item-1" } });

  const waiting = coordinator.status("luna-1");
  assert.equal(waiting.turn.status, "waiting-input");
  const resolved = await coordinator.resolveRequest(waiting.pendingRequest.id, { answers: { choice: { answers: ["yes"] } } }, "resolve-1");
  assert.equal(resolved.status, "resolved");
  assert.throws(() => coordinator.resolveRequest(waiting.pendingRequest.id, {}, "resolve-2"), /already resolved/i);
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

test("coordinator is the trusted commit authority for Luna worktrees", async () => {
  const cwd = makeTempDir("coordinator-git-");
  const dataRoot = makeTempDir("coordinator-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const coordinator = new WorkerCoordinator({ cwd, dataRoot, clientFactory: async () => new FakeClient() });
  const worker = await coordinator.dispatch("worker.start", {
    workerId: "luna-commit", orchestrationId: "orch-1", cwd, role: "luna"
  }, "start-commit");
  fs.writeFileSync(path.join(worker.cwd, "app.js"), "two\n");

  const committed = await coordinator.dispatch("integration.commit", {
    workerId: "luna-commit", message: "task: change app", allowedPaths: ["app.js"]
  }, "commit-1");
  assert.equal(committed.paths[0], "app.js");
  assert.equal(coordinator.status("luna-commit").headCommit, committed.commit);
});
