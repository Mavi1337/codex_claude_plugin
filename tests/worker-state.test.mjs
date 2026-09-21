import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { createWorkerStore } from "../plugins/codex/scripts/lib/worker-state.mjs";

test("worker store increments revisions and creates owner-only files", () => {
  const repo = makeTempDir("worker-state-repo-");
  const dataRoot = makeTempDir("worker-state-data-");
  initGitRepo(repo);
  const store = createWorkerStore(repo, { dataRoot });

  store.transaction((state) => {
    state.workers["implementer-1"] = { id: "implementer-1", status: "idle" };
  });
  const state = store.load();

  assert.equal(state.revision, 1);
  assert.equal(state.workers["implementer-1"].status, "idle");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.rootDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.stateFile).mode & 0o777, 0o600);
  }
});

test("worker store reports corrupt state and can recover from its backup", () => {
  const repo = makeTempDir("worker-state-repo-");
  const dataRoot = makeTempDir("worker-state-data-");
  initGitRepo(repo);
  const store = createWorkerStore(repo, { dataRoot });
  store.transaction((state) => {
    state.workers.first = { id: "first", status: "idle" };
  });
  store.transaction((state) => {
    state.workers.second = { id: "second", status: "idle" };
  });
  fs.writeFileSync(store.stateFile, "{broken", "utf8");

  assert.throws(() => store.load(), /corrupt worker state/i);
  const recovered = store.recoverBackup();
  assert.equal(recovered.workers.first.id, "first");
  assert.equal(fs.existsSync(path.join(store.rootDir, "state.json.corrupt")), true);
});

test("artifact paths cannot escape their orchestration", () => {
  const repo = makeTempDir("worker-state-repo-");
  const dataRoot = makeTempDir("worker-state-data-");
  initGitRepo(repo);
  const store = createWorkerStore(repo, { dataRoot });

  assert.throws(() => store.artifactPath("orch-1", "../secret"), /artifact path/i);
  const report = store.writeArtifact("orch-1", "tasks/task-1/report.md", "done\n");
  assert.equal(fs.readFileSync(report, "utf8"), "done\n");
});

test("worker state rejects a second live process lock owner", () => {
  const repo = makeTempDir("worker-state-repo-");
  const dataRoot = makeTempDir("worker-state-data-");
  initGitRepo(repo);
  const store = createWorkerStore(repo, { dataRoot });
  const release = store.acquireOwnership("test-owner");
  assert.throws(() => store.acquireOwnership("test-owner"), /already owned/i);
  release();
  const releaseAgain = store.acquireOwnership("test-owner");
  releaseAgain();
});

test("worker state does not reclaim a lock with corrupt owner metadata", () => {
  const root = makeTempDir("worker-state-corrupt-owner-");
  const repo = makeTempDir("worker-state-corrupt-repo-");
  initGitRepo(repo);
  const store = createWorkerStore(repo, { dataRoot: root });
  const lockDir = path.join(store.rootDir, "corrupt-owner.lock");
  const release = store.acquireOwnership("corrupt-owner");
  release();
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), "{corrupt", "utf8");
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, stale, stale);
  assert.throws(() => store.acquireOwnership("corrupt-owner"), /already owned/i);
});
