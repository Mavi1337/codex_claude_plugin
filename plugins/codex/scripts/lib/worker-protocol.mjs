import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommandChecked } from "./process.mjs";

export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function canonical(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function resolveRepositoryIdentity(cwd) {
  const repoRoot = canonical(runCommandChecked("git", ["rev-parse", "--show-toplevel"], { cwd, shell: false }).stdout.trim());
  let commonGitDir;
  try {
    commonGitDir = runCommandChecked("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      shell: false
    }).stdout.trim();
  } catch {
    const raw = runCommandChecked("git", ["rev-parse", "--git-common-dir"], { cwd, shell: false }).stdout.trim();
    commonGitDir = path.resolve(repoRoot, raw);
  }
  commonGitDir = canonical(commonGitDir);
  const repositoryId = `repo-${createHash("sha256").update(commonGitDir).digest("hex").slice(0, 20)}`;
  return { repositoryId, commonGitDir, worktreeRoot: repoRoot };
}

export function assertSafeId(value, field = "id") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${field} must match ${SAFE_ID}.`);
  }
  return value;
}

export function validateEnvelope(value, options = {}) {
  if ((options.frameBytes ?? Buffer.byteLength(JSON.stringify(value ?? null))) > MAX_FRAME_BYTES) {
    throw new Error(`Worker request exceeds the maximum frame size of ${MAX_FRAME_BYTES} bytes.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker request must be a JSON object.");
  }
  if (value.version !== WORKER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported worker protocol version: ${value.version}.`);
  }
  assertSafeId(value.requestId, "requestId");
  assertSafeId(value.idempotencyKey, "idempotencyKey");
  assertSafeId(value.repositoryId, "repositoryId");
  if (typeof value.token !== "string" || value.token.length < 8 || value.token.length > 512) {
    throw new Error("token must be a non-empty coordinator capability token.");
  }
  if (typeof value.operation !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(value.operation)) {
    throw new Error("operation must use a namespaced operation name.");
  }
  if (!value.params || typeof value.params !== "object" || Array.isArray(value.params)) {
    throw new Error("params must be an object.");
  }
  return value;
}
