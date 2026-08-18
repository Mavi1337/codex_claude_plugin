import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  applyReviewedCommits,
  closeTaskWorktree,
  commitTaskWorktree,
  createTaskWorktree
} from "../plugins/codex/scripts/lib/worker-worktree.mjs";

function baseRepo() {
  const repo = makeTempDir("worktree-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  return repo;
}

test("trusted runtime creates and commits an isolated task worktree with hooks disabled", () => {
  const repo = baseRepo();
  const root = makeTempDir("worker-worktrees-");
  const marker = path.join(repo, "hook-ran");
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: root });
  fs.writeFileSync(path.join(created.worktree, "app.js"), "export const value = 2;\n");

  const committed = commitTaskWorktree(created.worktree, { message: "task: update value" });
  assert.match(committed.commit, /^[a-f0-9]{40,64}$/);
  assert.match(committed.tree, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(committed.paths, ["app.js"]);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: created.worktree }).stdout, "");
});

test("trusted commit rejects paths outside the allowed task set", () => {
  const repo = baseRepo();
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.writeFileSync(path.join(created.worktree, "app.js"), "changed\n");
  fs.writeFileSync(path.join(created.worktree, "surprise.txt"), "unexpected\n");
  assert.throws(() => commitTaskWorktree(created.worktree, { message: "task", allowedPaths: ["app.js"] }), /outside the allowed paths/i);
});

test("integration applies only reviewed commits with compare-and-swap HEAD", () => {
  const repo = baseRepo();
  const base = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base, worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.writeFileSync(path.join(created.worktree, "app.js"), "export const value = 3;\n");
  const committed = commitTaskWorktree(created.worktree, { message: "task" });

  const applied = applyReviewedCommits({ integrationCwd: repo, expectedHead: base, base, head: committed.commit });
  assert.deepEqual(applied.commits, [committed.commit]);
  assert.equal(fs.readFileSync(path.join(repo, "app.js"), "utf8"), "export const value = 3;\n");
  assert.throws(() => applyReviewedCommits({ integrationCwd: repo, expectedHead: base, base, head: committed.commit }), /expected HEAD/i);
});

test("worktree close refuses ignored or untracked material", () => {
  const repo = baseRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "artifact.bin\n");
  run("git", ["add", ".gitignore"], { cwd: repo });
  run("git", ["commit", "-m", "ignore"], { cwd: repo });
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.writeFileSync(path.join(created.worktree, "artifact.bin"), "keep me\n");
  assert.throws(() => closeTaskWorktree({ repoRoot: repo, worktree: created.worktree }), /ignored or untracked/i);
});
