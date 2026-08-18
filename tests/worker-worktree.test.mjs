import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  applyReviewedCommits,
  closeTaskWorktree,
  commitTaskWorktree,
  createTaskWorktree,
  restoreTaskWorktree
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

test("multi-commit integration conflict restores the exact starting HEAD", () => {
  const repo = baseRepo();
  const base = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-conflict", base, worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.writeFileSync(path.join(created.worktree, "first.txt"), "first\n");
  commitTaskWorktree(created.worktree, { message: "first" });
  fs.writeFileSync(path.join(created.worktree, "app.js"), "worker\n");
  const final = commitTaskWorktree(created.worktree, { message: "conflicting second" });

  fs.writeFileSync(path.join(repo, "app.js"), "integration\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "integration change"], { cwd: repo });
  const integrationHead = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();

  assert.throws(
    () => applyReviewedCommits({ integrationCwd: repo, expectedHead: integrationHead, base, head: final.commit }),
    /failed and was aborted/i
  );
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim(), integrationHead);
  assert.equal(fs.existsSync(path.join(repo, "first.txt")), false);
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

test("a saved worker branch can reconstruct its missing clean worktree", () => {
  const repo = baseRepo();
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-restore", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  closeTaskWorktree({ repoRoot: repo, worktree: created.worktree });
  const restored = restoreTaskWorktree({ repoRoot: repo, branch: created.branch, worktree: created.worktree });
  assert.equal(fs.existsSync(restored.worktree), true);
  assert.equal(run("git", ["branch", "--show-current"], { cwd: restored.worktree }).stdout.trim(), created.branch);
});

test("a directory allowed path covers files beneath it, including both sides of a rename", () => {
  const repo = baseRepo();
  fs.mkdirSync(path.join(repo, "lane"));
  fs.writeFileSync(path.join(repo, "lane", "old.js"), "export const lane = 1;\n");
  run("git", ["add", "lane/old.js"], { cwd: repo });
  run("git", ["commit", "-m", "lane"], { cwd: repo });
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.mkdirSync(path.join(created.worktree, "lane", "nested"), { recursive: true });
  fs.writeFileSync(path.join(created.worktree, "lane", "README.md"), "docs\n");
  fs.writeFileSync(path.join(created.worktree, "lane", "nested", "deep.js"), "export const deep = 1;\n");
  run("git", ["mv", "lane/old.js", "lane/new.js"], { cwd: created.worktree });

  const committed = commitTaskWorktree(created.worktree, { message: "task", allowedPaths: ["lane"] });
  assert.deepEqual(committed.paths, ["lane/README.md", "lane/nested/deep.js", "lane/new.js"].sort());
  assert.equal(run("git", ["status", "--porcelain"], { cwd: created.worktree }).stdout, "");
  const tracked = run("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: created.worktree }).stdout.trim().split("\n").sort();
  assert.deepEqual(tracked, ["app.js", "lane/README.md", "lane/nested/deep.js", "lane/new.js"]);
});

test("a plain move is committed as a delete plus an add when git mv is unavailable", () => {
  const repo = baseRepo();
  fs.mkdirSync(path.join(repo, "lane"));
  fs.writeFileSync(path.join(repo, "lane", "old.js"), "export const lane = 1;\n");
  run("git", ["add", "lane/old.js"], { cwd: repo });
  run("git", ["commit", "-m", "lane"], { cwd: repo });
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.renameSync(path.join(created.worktree, "lane", "old.js"), path.join(created.worktree, "lane", "new.js"));

  const committed = commitTaskWorktree(created.worktree, { message: "task", allowedPaths: ["lane"] });
  assert.ok(committed.paths.includes("lane/new.js"));
  assert.equal(run("git", ["status", "--porcelain"], { cwd: created.worktree }).stdout, "");
  assert.equal(fs.existsSync(path.join(created.worktree, "lane", "old.js")), false);
});

test("a directory allowed path does not cover a sibling with the same prefix", () => {
  const repo = baseRepo();
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.mkdirSync(path.join(created.worktree, "lane"));
  fs.writeFileSync(path.join(created.worktree, "lane", "ok.js"), "ok\n");
  fs.writeFileSync(path.join(created.worktree, "lane-other.js"), "not ok\n");
  assert.throws(
    () => commitTaskWorktree(created.worktree, { message: "task", allowedPaths: ["lane"] }),
    /outside the allowed paths: lane-other\.js/
  );
});

test("an allowed path may not widen the assignment to the whole worktree", () => {
  const repo = baseRepo();
  const created = createTaskWorktree({ repoRoot: repo, workerId: "luna-1", base: "HEAD", worktreeRoot: makeTempDir("worker-worktrees-") });
  fs.writeFileSync(path.join(created.worktree, "app.js"), "changed\n");
  for (const entry of [".", "", "/etc", "lane/../.."]) {
    assert.throws(() => commitTaskWorktree(created.worktree, { message: "task", allowedPaths: [entry] }), /Invalid allowed path/);
  }
});
