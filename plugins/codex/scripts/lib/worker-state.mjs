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
    reviews: {},
    queue: [],
    inFlightQueue: {},
    recoveryQueue: [],
    idempotency: {},
    capabilities: {},
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

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function processIdentity(pid) {
  if (!processIsAlive(pid)) return null;
  let executable = null;
  let startIdentity = null;
  if (process.platform === "linux") {
    try { executable = fs.realpathSync(`/proc/${pid}/exe`); } catch {}
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      startIdentity = fields[19] ?? null;
    } catch {}
  }
  if (pid === process.pid) executable ??= fs.realpathSync(process.execPath);
  return { pid, executable, startIdentity };
}

function ownerMatchesLiveProcess(owner) {
  const current = processIdentity(owner?.pid);
  if (!current) return false;
  if (!owner.executable || !owner.startIdentity || !current.executable || !current.startIdentity) return true;
  return owner.executable === current.executable && owner.startIdentity === current.startIdentity;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function createWorkerStore(cwd, options = {}) {
  const identity = resolveRepositoryIdentity(cwd);
  const dataRoot = options.dataRoot ?? process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), "codex-companion");
  const rootDir = path.join(dataRoot, "worker-state", identity.repositoryId);
  const stateFile = path.join(rootDir, "state.json");
  const backupFile = `${stateFile}.bak`;
  const defaultValue = () => initialState(identity.repositoryId);

  function acquireLock(name, options = {}) {
    const lockDir = path.join(rootDir, `${name}.lock`);
    const deadline = Date.now() + (options.waitMs ?? 0);
    ensureOwnerDirectory(rootDir);
    while (true) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        durableWrite(path.join(lockDir, "owner.json"), `${JSON.stringify({ ...processIdentity(process.pid), acquiredAt: new Date().toISOString() })}\n`);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
            if (owner.pid !== process.pid) throw new Error(`Refusing to release ${name}; ownership changed.`);
            fs.rmSync(lockDir, { recursive: true });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch {}
        const stat = fs.statSync(lockDir);
        if ((!owner || !ownerMatchesLiveProcess(owner)) && Date.now() - stat.mtimeMs > 30000) {
          fs.rmSync(lockDir, { recursive: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Worker repository is already owned by another live ${name} process.`);
        sleepSync(10);
      }
    }
  }

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
    const release = acquireLock("state-write", { waitMs: 2000 });
    try {
      const value = load();
      const expectedRevision = value.revision;
      mutator(value);
      const idempotencyKeys = Object.keys(value.idempotency ?? {});
      for (const key of idempotencyKeys.slice(0, Math.max(0, idempotencyKeys.length - 1000))) delete value.idempotency[key];
      if ((value.recoveryQueue?.length ?? 0) > 1000) value.recoveryQueue = value.recoveryQueue.slice(-1000);
      const current = fs.existsSync(stateFile) ? load().revision : 0;
      if (current !== expectedRevision) throw new Error("Worker state revision conflict.");
      value.revision += 1;
      value.updatedAt = new Date().toISOString();
      return save(value);
    } finally { release(); }
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

  return {
    identity, rootDir, stateFile, backupFile, load, transaction, recoverBackup,
    artifactPath, writeArtifact,
    acquireOwnership: (name = "coordinator-owner") => acquireLock(name),
    readOwnership: (name = "coordinator-owner") => {
      try { return JSON.parse(fs.readFileSync(path.join(rootDir, `${name}.lock`, "owner.json"), "utf8")); }
      catch { return null; }
    }
  };
}
