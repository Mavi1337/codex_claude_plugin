#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";

import { assertSafeId, resolveRepositoryIdentity } from "./lib/worker-protocol.mjs";
import {
  ensureCoordinatorSession,
  sendCoordinatorRequest,
  shutdownCoordinatorSession
} from "./lib/worker-coordinator-lifecycle.mjs";

function parse(argv) {
  const positionals = [];
  const options = {};
  const booleans = new Set(["json", "worktree", "staged", "unstaged", "task-review"]);
  const repeatable = new Set(["path", "file", "audit-path", "allowed-path"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    if (booleans.has(key)) { options[key] = true; continue; }
    if (index + 1 >= argv.length) throw new Error(`Missing value for --${key}.`);
    const next = argv[++index];
    if (repeatable.has(key)) {
      options[key] ??= [];
      options[key].push(next);
    } else {
      options[key] = next;
    }
  }
  return { positionals, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing required --${name}.`);
  return options[name];
}

async function main() {
  const { positionals, options } = parse(process.argv.slice(2));
  const [group, action] = positionals;
  const cwd = options.cwd ?? process.cwd();
  if (!group || !action) throw new Error("Usage: codex-workers.mjs <worker|coordinator> <operation> [options].");
  resolveRepositoryIdentity(cwd);

  if (group === "coordinator" && action === "shutdown") {
    return shutdownCoordinatorSession(cwd, { dataRoot: process.env.CLAUDE_PLUGIN_DATA });
  }

  let operation;
  let params = {};
  if (group === "coordinator" && action === "status") {
    operation = "coordinator.status";
  } else if (group === "integration") {
    if (!["commit", "apply"].includes(action)) throw new Error(`Unknown integration operation: ${action}.`);
    operation = `integration.${action}`;
    params.workerId = assertSafeId(required(options, "worker"), "worker");
    if (action === "commit") {
      params.message = required(options, "message");
      params.allowedPaths = options["allowed-path"];
    } else {
      params.expectedHead = required(options, "expected-head");
    }
  } else if (group === "review") {
    if (!["start", "status", "result"].includes(action)) throw new Error(`Unknown review operation: ${action}.`);
    operation = `review.${action}`;
    params.reviewId = assertSafeId(required(options, "review"), "review");
    if (action === "start") {
      params.orchestrationId = assertSafeId(required(options, "orchestration"), "orchestration");
      params.cwd = cwd;
      params.effort = options.effort;
      params.maxInputTokens = options["max-input-tokens"] ? Number(options["max-input-tokens"]) : undefined;
      params.target = {
        base: options.base,
        range: options.range,
        last: options.last ? Number(options.last) : undefined,
        worktree: options.worktree === true,
        staged: options.staged === true,
        unstaged: options.unstaged === true,
        auditPaths: options["audit-path"],
        paths: options.path,
        files: options.file
      };
      params.taskReview = options["task-review"] === true;
      if (options.worker) params.workerId = assertSafeId(options.worker, "worker");
    }
  } else if (group === "worker") {
    if (!["start", "send", "wait", "status", "list", "stop", "close", "resume", "resolve-request"].includes(action)) {
      throw new Error(`Unknown worker operation: ${action}.`);
    }
    operation = `worker.${action}`;
    if (action !== "list" && action !== "resolve-request") {
      params.workerId = assertSafeId(required(options, "worker"), "worker");
    }
    if (action === "start") {
      params = {
        ...params,
        orchestrationId: assertSafeId(required(options, "orchestration"), "orchestration"),
        cwd,
        role: options.role ?? "luna",
        effort: options.effort
      };
    }
    if (action === "send") params.prompt = required(options, "prompt");
    if (action === "wait") params.timeoutMs = options.timeout ? Number(options.timeout) : 0;
    if (action === "resolve-request") {
      params.requestId = assertSafeId(required(options, "request"), "request");
      params.result = JSON.parse(required(options, "result-json"));
    }
  } else {
    throw new Error(`Unknown command group: ${group}.`);
  }

  const session = await ensureCoordinatorSession(cwd, {
    dataRoot: process.env.CLAUDE_PLUGIN_DATA,
    env: process.env
  });
  const requestId = `cli-${randomUUID()}`;
  return sendCoordinatorRequest(session, operation, params, {
    requestId,
    idempotencyKey: options["idempotency-key"] ?? requestId,
    timeoutMs: action === "wait" ? (params.timeoutMs || 30000) + 1000 : 10000
  });
}

try {
  const response = await main();
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = /Missing|required|Unknown|must match|Usage/.test(error.message)
    ? 2
    : error.code === "COMPATIBILITY" ? 3
      : error.code === "UNAUTHORIZED" ? 4 : 1;
}
