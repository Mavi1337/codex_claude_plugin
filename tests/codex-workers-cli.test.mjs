import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const SCRIPT = path.resolve("plugins/codex/scripts/codex-workers.mjs");

function invoke(args, options) {
  const result = run("node", [SCRIPT, ...args, "--json"], options);
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { ...result, parsed };
}

test("worker CLI lazily starts one authenticated coordinator and resumes the same thread", async (t) => {
  const repo = makeTempDir("worker-cli-repo-");
  const dataRoot = makeTempDir("worker-cli-data-");
  const binDir = makeTempDir("worker-cli-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "review-ok");
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: dataRoot
  };
  t.after(() => {
    invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env });
  });

  const started = invoke(["worker", "start", "--cwd", repo, "--worker", "luna-1", "--orchestration", "orch-1", "--role", "luna"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.parsed.result.model, "gpt-5.6-luna");
  assert.equal(started.parsed.result.effort, "xhigh");
  assert.notEqual(started.parsed.result.cwd, repo);
  assert.equal(fs.existsSync(started.parsed.result.cwd), true);

  const sent = invoke(["worker", "send", "--cwd", repo, "--worker", "luna-1", "--prompt", "Inspect the task", "--idempotency-key", "send-1"], { cwd: repo, env });
  assert.equal(sent.status, 0, sent.stderr);
  const waited = invoke(["worker", "wait", "--cwd", repo, "--worker", "luna-1", "--timeout", "2000"], { cwd: repo, env });
  assert.equal(waited.parsed.result.turn.status, "completed");

  const status = invoke(["worker", "status", "--cwd", repo, "--worker", "luna-1"], { cwd: repo, env });
  assert.equal(status.parsed.result.thread.id, started.parsed.result.thread.id);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.appServerStarts, 1);
});

test("worker CLI rejects an unsafe explicit ID before contacting the coordinator", () => {
  const repo = makeTempDir("worker-cli-repo-");
  const dataRoot = makeTempDir("worker-cli-data-");
  initGitRepo(repo);
  const result = run("node", [SCRIPT, "worker", "status", "--cwd", repo, "--worker", "../escape", "--json"], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot }
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /worker/i);
});

test("worker CLI fails compatibly instead of silently substituting a missing model", (t) => {
  const repo = makeTempDir("worker-model-repo-");
  const dataRoot = makeTempDir("worker-model-data-");
  const binDir = makeTempDir("worker-model-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "missing-worker-models");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }));
  const result = run("node", [SCRIPT, "worker", "start", "--cwd", repo, "--worker", "luna-1", "--orchestration", "orch-1", "--json"], { cwd: repo, env });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /gpt-5\.6-luna.*unavailable/i);
});

test("review CLI runs a fresh Sol xhigh turn over a frozen worktree package", (t) => {
  const repo = makeTempDir("review-cli-repo-");
  const dataRoot = makeTempDir("review-cli-data-");
  const binDir = makeTempDir("review-cli-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "base\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "changed\n");
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }));

  const reviewed = invoke(["review", "start", "--cwd", repo, "--review", "review-1", "--orchestration", "orch-1", "--worktree", "--effort", "xhigh"], { cwd: repo, env });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(reviewed.parsed.result.gate.status, "pass");
  assert.equal(reviewed.parsed.result.specVerdict, "pass");
  assert.equal(reviewed.parsed.result.qualityVerdict, "approve");
  assert.equal(fs.existsSync(reviewed.parsed.result.reportFile), true);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(state.lastTurnStart.effort, "xhigh");
  assert.equal(state.lastThreadStart.config.model_context_window, 258000);
  assert.equal(state.lastThreadStart.config.model_auto_compact_token_limit, 220000);
});

test("oversized Sol review runs bounded passes and a fresh xhigh synthesis", (t) => {
  const repo = makeTempDir("review-split-repo-");
  const dataRoot = makeTempDir("review-split-data-");
  const binDir = makeTempDir("review-split-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "a".repeat(300));
  fs.writeFileSync(path.join(repo, "b.txt"), "b".repeat(300));
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }));

  const reviewed = invoke(["review", "start", "--cwd", repo, "--review", "review-split", "--orchestration", "orch-1", "--worktree", "--max-input-tokens", "40"], { cwd: repo, env });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.ok(reviewed.parsed.result.passCount >= 2);
  assert.equal(reviewed.parsed.result.synthesized, true);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(state.appServerStarts >= 3);
  assert.equal(state.lastTurnStart.effort, "xhigh");
});
