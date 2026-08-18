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
