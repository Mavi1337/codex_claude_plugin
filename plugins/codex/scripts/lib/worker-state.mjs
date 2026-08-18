import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSafeId, resolveRepositoryIdentity } from "./worker-protocol.mjs";

const STATE_VERSION = 1;

function initialState(repositoryId) {
  return {
    version: STATE_VERSION,
    revision: 0,
    repositoryId,
    workers: {},
    queue: [],
    idempotency: {},
    integrationLease: null,
    updatedAt: new Date(0).toISOString()
  };
}

function ensureOwnerDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function parseState(source, repositoryId) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Corrupt worker state: ${error.message}`);
  }
  if (value?.version !== STATE_VERSION || value.repositoryId !== repositoryId || !Number.isInteger(value.revision)) {
    throw new Error("Corrupt worker state: schema or repository identity mismatch.");
  }
  if (!value.workers || typeof value.workers !== "object" || !Array.isArray(value.queue)) {
    throw new Error("Corrupt worker state: required collections are missing.");
  }
  return value;
}

function durableWrite(file, source) {
  const dir = path.dirname(file);
  ensureOwnerDirectory(dir);
  const temp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temp, "w", 0o600);
  try {
    fs.writeFileSync(fd, source, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  try {
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Some platforms/filesystems do not support directory fsync.
  }
}

export function createWorkerStore(cwd, options = {}) {
  const identity = resolveRepositoryIdentity(cwd);
  const dataRoot = options.dataRoot ?? process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), "codex-companion");
  const rootDir = path.join(dataRoot, "worker-state", identity.repositoryId);
  const stateFile = path.join(rootDir, "state.json");
  const backupFile = `${stateFile}.bak`;
  const defaultValue = () => initialState(identity.repositoryId);

  function load() {
    if (!fs.existsSync(stateFile)) return defaultValue();
    return parseState(fs.readFileSync(stateFile, "utf8"), identity.repositoryId);
  }

  function save(value) {
    if (fs.existsSync(stateFile)) {
      fs.copyFileSync(stateFile, backupFile);
      if (process.platform !== "win32") fs.chmodSync(backupFile, 0o600);
    }
    durableWrite(stateFile, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  function transaction(mutator) {
    const value = load();
    const expectedRevision = value.revision;
    mutator(value);
    const current = fs.existsSync(stateFile) ? load().revision : 0;
    if (current !== expectedRevision) throw new Error("Worker state revision conflict.");
    value.revision += 1;
    value.updatedAt = new Date().toISOString();
    return save(value);
  }

  function recoverBackup() {
    if (!fs.existsSync(backupFile)) throw new Error("No worker state backup is available.");
    const recovered = parseState(fs.readFileSync(backupFile, "utf8"), identity.repositoryId);
    if (fs.existsSync(stateFile)) fs.renameSync(stateFile, `${stateFile}.corrupt`);
    durableWrite(stateFile, `${JSON.stringify(recovered, null, 2)}\n`);
    return recovered;
  }

  function artifactPath(orchestrationId, relativePath) {
    assertSafeId(orchestrationId, "orchestrationId");
    if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Invalid artifact path.");
    }
    const base = path.join(rootDir, "orchestrations", orchestrationId);
    const result = path.resolve(base, relativePath);
    if (result !== base && !result.startsWith(`${base}${path.sep}`)) throw new Error("Invalid artifact path escape.");
    return result;
  }

  function writeArtifact(orchestrationId, relativePath, source) {
    const file = artifactPath(orchestrationId, relativePath);
    durableWrite(file, String(source));
    return file;
  }

  return { identity, rootDir, stateFile, backupFile, load, transaction, recoverBackup, artifactPath, writeArtifact };
}
