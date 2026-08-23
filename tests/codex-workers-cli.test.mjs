import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { ensureCoordinatorSession, shutdownCoordinatorSession } from "../plugins/codex/scripts/lib/worker-coordinator-lifecycle.mjs";
import { createWorkerStore } from "../plugins/codex/scripts/lib/worker-state.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const SCRIPT = path.resolve("plugins/codex/scripts/codex-workers.mjs");
const SESSION_HOOK = path.resolve("plugins/codex/scripts/session-lifecycle-hook.mjs");

function invoke(args, options) {
  const result = run("node", [SCRIPT, ...args, "--json"], options);
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { ...result, parsed };
}

function invokeAsync(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, "--json"], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      let parsed = null;
      try { parsed = stdout.trim() ? JSON.parse(stdout) : null; }
      catch (error) { reject(Object.assign(error, { stdout, stderr, status, signal })); return; }
      resolve({ status, signal, stdout, stderr, parsed });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function invokeWithEarlyStdoutClose(args, options) {
  return new Promise((resolve, reject) => {
    const cli = [process.execPath, SCRIPT, ...args, "--json"].map(shellQuote).join(" ");
    const consumer = [
      process.execPath,
      "-e",
      "let bytes = 0; process.stdin.on('data', (chunk) => { bytes += chunk.length; if (bytes >= 200) process.exit(0); });"
    ].map(shellQuote).join(" ");
    const child = spawn("bash", ["-o", "pipefail", "-c", `${cli} | ${consumer}`], options);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stderr }));
  });
}

function waitForReview(reviewId, repo, env) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = invoke(["review", "status", "--cwd", repo, "--review", reviewId], { cwd: repo, env });
    if (observed.parsed?.result?.status !== "running") return observed;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`Timed out waiting for review ${reviewId}.`);
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
  assert.equal(fakeState.lastTurnStart.outputSchema.properties.status.enum.includes("completed"), true);
  assert.match(fakeState.lastTurnStart.prompt, /do not run `git commit`/i);
  assert.equal(fs.existsSync(waited.parsed.result.reportFile), true);
});

test("worker CLI exits cleanly when stdout closes before JSON is consumed", async (t) => {
  if (process.platform === "win32") t.skip("the regression uses bash pipefail");
  const repo = makeTempDir("worker-stdout-epipe-repo-");
  const dataRoot = makeTempDir("worker-stdout-epipe-data-");
  const binDir = makeTempDir("worker-stdout-epipe-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => { invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }); });

  const started = invoke(["worker", "start", "--cwd", repo, "--worker", "luna-epipe", "--orchestration", "orch-epipe"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const store = createWorkerStore(repo, { dataRoot });
  store.transaction((state) => { state.workers["luna-epipe"].lastOutput = "x".repeat(128 * 1024); });
  const full = invoke(["worker", "status", "--cwd", repo, "--worker", "luna-epipe"], { cwd: repo, env });
  assert.ok(full.stdout.length > 128 * 1024);
  const closed = await invokeWithEarlyStdoutClose(["worker", "status", "--cwd", repo, "--worker", "luna-epipe"], { cwd: repo, env });
  assert.equal(closed.status, 0, closed.stderr);
  assert.doesNotMatch(closed.stderr, /EPIPE|Unhandled 'error' event|node:events/i);
});

test("simultaneous coordinator discovery publishes one live owner", async (t) => {
  const repo = makeTempDir("worker-race-repo-");
  const dataRoot = makeTempDir("worker-race-data-");
  const binDir = makeTempDir("worker-race-bin-");
  initGitRepo(repo);
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => shutdownCoordinatorSession(repo, { dataRoot }));
  const [first, second] = await Promise.all([
    ensureCoordinatorSession(repo, { dataRoot, env }),
    ensureCoordinatorSession(repo, { dataRoot, env })
  ]);
  assert.equal(first.pid, second.pid);
  assert.equal(first.tokenFile, second.tokenFile);
  fs.writeFileSync(first.metadataFile, "{corrupt", "utf8");
  fs.writeFileSync(path.join(first.store.rootDir, "coordinator-owner.lock", "owner.json"), "{corrupt", "utf8");
  const recovered = await ensureCoordinatorSession(repo, { dataRoot, env });
  assert.equal(recovered.pid, first.pid);
  assert.equal(fs.existsSync(parseBrokerEndpoint(recovered.endpoint).path), true);
  assert.equal(JSON.parse(fs.readFileSync(recovered.metadataFile, "utf8")).pid, first.pid);
});

test("metadata recovery refuses to replace an unauthenticated live owner", async () => {
  const repo = makeTempDir("worker-owner-repo-");
  const dataRoot = makeTempDir("worker-owner-data-");
  initGitRepo(repo);
  const store = createWorkerStore(repo, { dataRoot });
  const lockDir = path.join(store.rootDir, "coordinator-owner.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, executable: "/not-the-current-runtime", startIdentity: "reused" }));
  fs.writeFileSync(path.join(store.rootDir, "coordinator.token"), "token");
  await assert.rejects(
    () => ensureCoordinatorSession(repo, { dataRoot, env: process.env }),
    /live but could not be authenticated/i
  );
  assert.equal(fs.existsSync(path.join(lockDir, "owner.json")), true);
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

  const accepted = invoke(["review", "start", "--cwd", repo, "--review", "review-1", "--orchestration", "orch-1", "--worktree", "--effort", "xhigh"], { cwd: repo, env });
  assert.equal(accepted.parsed.result.status, "running");
  const reviewed = waitForReview("review-1", repo, env);
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
  fs.writeFileSync(path.join(repo, "a.txt"), "a".repeat(10000));
  fs.writeFileSync(path.join(repo, "b.txt"), "b".repeat(10000));
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }));

  const accepted = invoke(["review", "start", "--cwd", repo, "--review", "review-split", "--orchestration", "orch-1", "--worktree", "--max-input-tokens", "2000"], { cwd: repo, env });
  assert.equal(accepted.parsed.result.status, "running");
  const reviewed = waitForReview("review-split", repo, env);
  assert.ok(reviewed.parsed.result.passCount >= 2);
  assert.equal(reviewed.parsed.result.synthesized, true);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(state.appServerStarts >= 3);
  assert.equal(state.lastTurnStart.effort, "xhigh");
  const synthesisInput = JSON.parse(fs.readFileSync(path.join(path.dirname(reviewed.parsed.result.reportFile), "synthesis-input.json"), "utf8"));
  assert.ok(synthesisInput.passReviews.length >= 2);
  assert.equal(synthesisInput.passReviews.every((pass) => typeof pass.passId === "string" && Array.isArray(pass.paths) && /^[a-f0-9]{64}$/.test(pass.packageHash)), true);
});

test("CLI commits Luna work, gates it through fresh Sol, and applies reviewed commits", (t) => {
  const repo = makeTempDir("worker-integrate-repo-");
  const dataRoot = makeTempDir("worker-integrate-data-");
  const binDir = makeTempDir("worker-integrate-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "base\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  const base = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }));
  const started = invoke(["worker", "start", "--cwd", repo, "--worker", "luna-task", "--orchestration", "orch-1", "--allowed-path", "app.js", "--requirement", "app.js"], { cwd: repo, env });
  const sent = invoke(["worker", "send", "--cwd", repo, "--worker", "luna-task", "--prompt", "Implement app.js and verify it", "--idempotency-key", "task-send"], { cwd: repo, env });
  assert.equal(sent.status, 0, sent.stderr);
  const waited = invoke(["worker", "wait", "--cwd", repo, "--worker", "luna-task", "--timeout", "2000"], { cwd: repo, env });
  assert.equal(waited.parsed.result.turn.status, "completed");
  fs.writeFileSync(path.join(started.parsed.result.cwd, "app.js"), "implemented\n");

  const committed = invoke(["integration", "commit", "--cwd", repo, "--worker", "luna-task", "--message", "task: implement", "--allowed-path", "app.js"], { cwd: repo, env });
  assert.equal(committed.status, 0, committed.stderr);
  const accepted = invoke(["review", "start", "--cwd", repo, "--review", "task-review", "--orchestration", "orch-1", "--worker", "luna-task", "--task-review"], { cwd: repo, env });
  assert.equal(accepted.parsed.result.status, "running");
  const reviewed = waitForReview("task-review", repo, env);
  assert.equal(reviewed.parsed.result.gate.status, "pass");
  const reviewPackage = fs.readFileSync(reviewed.parsed.result.packageFile, "utf8");
  assert.match(reviewPackage, /Binding task brief/);
  assert.match(reviewPackage, /Validated Luna implementation report/);
  assert.match(reviewPackage, /Binding requirement and specification sources/);
  assert.match(reviewPackage, /Implement app\.js and verify it/);
  const applied = invoke(["integration", "apply", "--cwd", repo, "--worker", "luna-task", "--expected-head", base], { cwd: repo, env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(path.join(repo, "app.js"), "utf8"), "implemented\n");
});

test("session end closes coordinator app-servers while preserving worker state", () => {
  const repo = makeTempDir("worker-session-repo-");
  const dataRoot = makeTempDir("worker-session-data-");
  const binDir = makeTempDir("worker-session-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  const started = invoke(["worker", "start", "--cwd", repo, "--worker", "luna-session", "--orchestration", "orch-1"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "session-1" })
  });
  assert.equal(ended.status, 0, ended.stderr);
  const shutdown = invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env });
  assert.equal(shutdown.parsed.status, "not-running");
  const stateFiles = fs.readdirSync(path.join(dataRoot, "worker-state"), { recursive: true });
  assert.equal(stateFiles.some((entry) => String(entry).endsWith("state.json")), true);
});

test("session end remains a no-op success outside a Git repository", () => {
  const cwd = makeTempDir("worker-session-nongit-");
  const dataRoot = makeTempDir("worker-session-data-");
  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
    input: JSON.stringify({ cwd, session_id: "session-nongit" })
  });
  assert.equal(ended.status, 0, ended.stderr);
});

test("coordinator restart replaces the running daemon so edited plugin code is reloaded", async (t) => {
  const repo = makeTempDir("worker-cli-repo-");
  const dataRoot = makeTempDir("worker-cli-data-");
  const binDir = makeTempDir("worker-cli-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "review-ok");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => { invoke(["coordinator", "shutdown", "--cwd", repo], { cwd: repo, env }); });

  const first = invoke(["coordinator", "status", "--cwd", repo], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstPid = first.parsed.result.coordinatorPid;

  const restarted = invoke(["coordinator", "restart", "--cwd", repo], { cwd: repo, env });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.parsed.status, "restarted");
  assert.equal(restarted.parsed.previousPid, firstPid);

  const second = invoke(["coordinator", "status", "--cwd", repo], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(second.parsed.result.coordinatorPid, firstPid);
  assert.equal(second.parsed.result.status, "online");
});

test("worker wait reconnects after the shared coordinator is disrupted", async (t) => {
  const repo = makeTempDir("worker-wait-reconnect-repo-");
  const dataRoot = makeTempDir("worker-wait-reconnect-data-");
  const binDir = makeTempDir("worker-wait-reconnect-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => { invoke(["coordinator", "shutdown", "--cwd", repo, "--force"], { cwd: repo, env }); });

  const started = invoke(["worker", "start", "--cwd", repo, "--worker", "luna-reconnect", "--orchestration", "orch-reconnect"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const sent = invoke(["worker", "send", "--cwd", repo, "--worker", "luna-reconnect", "--prompt", "Long-running work", "--idempotency-key", "send-reconnect"], { cwd: repo, env });
  assert.equal(sent.status, 0, sent.stderr);

  const waiting = invokeAsync(["worker", "wait", "--cwd", repo, "--worker", "luna-reconnect", "--timeout", "0"], { cwd: repo, env });
  let coordinatorPid = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = invoke(["coordinator", "status", "--cwd", repo], { cwd: repo, env });
    if (observed.parsed?.result?.activeWaiters > 0) {
      coordinatorPid = observed.parsed.result.coordinatorPid;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(coordinatorPid);
  process.kill(coordinatorPid, "SIGKILL");

  const waited = await waiting;
  assert.equal(waited.status, 0, waited.stderr);
  assert.ok(["interrupted", "indeterminate"].includes(waited.parsed.result.turn.status));
});

test("coordinator restart refuses live turns unless forced", (t) => {
  const repo = makeTempDir("worker-restart-guard-repo-");
  const dataRoot = makeTempDir("worker-restart-guard-data-");
  const binDir = makeTempDir("worker-restart-guard-bin-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: dataRoot };
  t.after(() => { invoke(["coordinator", "shutdown", "--cwd", repo, "--force"], { cwd: repo, env }); });

  const started = invoke(["worker", "start", "--cwd", repo, "--worker", "luna-guard", "--orchestration", "orch-guard"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const sent = invoke(["worker", "send", "--cwd", repo, "--worker", "luna-guard", "--prompt", "Long-running work", "--idempotency-key", "send-guard"], { cwd: repo, env });
  assert.equal(sent.status, 0, sent.stderr);

  const refused = invoke(["coordinator", "restart", "--cwd", repo], { cwd: repo, env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /luna-guard.*orch-guard|orch-guard.*luna-guard/i);

  const forced = invoke(["coordinator", "restart", "--cwd", repo, "--force"], { cwd: repo, env });
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(forced.parsed.status, "restarted");
});
