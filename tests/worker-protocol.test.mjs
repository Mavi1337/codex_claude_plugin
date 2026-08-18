import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  MAX_FRAME_BYTES,
  resolveRepositoryIdentity,
  validateEnvelope
} from "../plugins/codex/scripts/lib/worker-protocol.mjs";

test("linked worktrees share one repository identity", () => {
  const repo = makeTempDir("worker-repo-");
  const linked = makeTempDir("worker-linked-parent-");
  const linkedPath = path.join(linked, "task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  run("git", ["add", "file.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  run("git", ["worktree", "add", "-b", "task-test", linkedPath], { cwd: repo });

  assert.equal(resolveRepositoryIdentity(repo).repositoryId, resolveRepositoryIdentity(linkedPath).repositoryId);
  assert.equal(resolveRepositoryIdentity(repo).commonGitDir, resolveRepositoryIdentity(linkedPath).commonGitDir);
});

test("worker envelope rejects unsafe IDs and oversized frames", () => {
  const valid = {
    version: 1,
    requestId: "request-1",
    idempotencyKey: "retry-1",
    repositoryId: "repo-1",
    token: "secret-token",
    operation: "worker.status",
    params: { workerId: "luna-1" }
  };
  assert.deepEqual(validateEnvelope(valid), valid);
  assert.throws(() => validateEnvelope({ ...valid, requestId: "../escape" }), /requestId/);
  assert.throws(() => validateEnvelope({ ...valid, token: "" }), /token/);
  assert.throws(() => validateEnvelope(valid, { frameBytes: MAX_FRAME_BYTES + 1 }), /maximum frame size/i);
});
