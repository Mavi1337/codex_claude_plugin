import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { createWorkerStore } from "./worker-state.mjs";
import { MAX_FRAME_BYTES } from "./worker-protocol.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../codex-worker-coordinator.mjs", import.meta.url));
const WAIT_SLICE_MS = 30_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 2_000;
const TERMINAL_WAIT_STATUSES = new Set(["completed", "failed", "interrupted", "indeterminate", "waiting-input", "waiting-approval"]);
const RECOVERABLE_WAIT_ERRORS = new Set(["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ETIMEDOUT"]);

function writePrivate(file, value) {
  fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function sessionPaths(store) {
  const shortId = store.identity.repositoryId.replace(/^repo-/, "").slice(0, 12);
  const sessionDir = path.join(os.tmpdir(), `cxcw-${shortId}`);
  return {
    sessionDir,
    metadataFile: path.join(store.rootDir, "coordinator.json"),
    tokenFile: path.join(store.rootDir, "coordinator.token"),
    logFile: path.join(store.rootDir, "coordinator.log"),
    endpoint: createBrokerEndpoint(sessionDir)
  };
}

export function loadCoordinatorSession(cwd, options = {}) {
  const store = createWorkerStore(cwd, { dataRoot: options.dataRoot });
  const paths = sessionPaths(store);
  if (!fs.existsSync(paths.metadataFile)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(paths.metadataFile, "utf8"));
    return value.repositoryId === store.identity.repositoryId ? { ...value, ...paths, store } : null;
  } catch { return null; }
}

export async function sendCoordinatorRequest(session, operation, params = {}, options = {}) {
  const requestId = options.requestId ?? `req-${randomUUID()}`;
  const envelope = {
    version: 1,
    requestId,
    idempotencyKey: options.idempotencyKey ?? requestId,
    repositoryId: session.store.identity.repositoryId,
    token: fs.readFileSync(session.tokenFile, "utf8").trim(),
    operation,
    params
  };
  const target = parseBrokerEndpoint(session.endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.path });
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let timer = null;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    // A timeout of 0 means "block indefinitely" — `worker wait --timeout 0` blocks until the turn
    // reaches a terminal state, so the transport must not impose a deadline of its own.
    const budget = options.timeoutMs ?? 10000;
    timer = budget > 0
      ? setTimeout(() => {
        const error = Object.assign(new Error("Timed out waiting for worker coordinator."), { code: "ETIMEDOUT" });
        settle(reject, error);
        socket.destroy();
      }, budget)
      : null;
    socket.on("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        const error = new Error("Worker coordinator response exceeded the maximum frame size.");
        error.code = "FRAME_TOO_LARGE";
        settle(reject, error);
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.version !== 1 || response.requestId !== requestId) throw new Error("Worker coordinator returned a mismatched protocol response.");
        if (response.error) settle(reject, Object.assign(new Error(response.error.message), { code: response.error.code }));
        else settle(resolve, response);
      } catch (error) { settle(reject, error); }
    });
    socket.on("error", (error) => settle(reject, error));
    socket.on("close", () => {
      if (settled) return;
      settle(reject, Object.assign(new Error("Worker coordinator connection closed before a response."), { code: "ECONNRESET" }));
    });
  });
}

function isRecoverableWaitError(error) {
  return RECOVERABLE_WAIT_ERRORS.has(error?.code);
}

function waitResultIsTerminal(response) {
  return TERMINAL_WAIT_STATUSES.has(response?.result?.turn?.status);
}

function waitSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForWorker(cwd, params, options = {}) {
  const requestedTimeoutMs = Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : 0;
  const sessionOptions = { dataRoot: options.dataRoot, env: options.env };
  let session = await ensureCoordinatorSession(cwd, sessionOptions);
  const deadline = requestedTimeoutMs > 0 ? Date.now() + requestedTimeoutMs : null;
  let lastResponse = null;
  let retryDelay = RECONNECT_MIN_MS;

  while (true) {
    const remaining = deadline === null ? WAIT_SLICE_MS : deadline - Date.now();
    if (remaining <= 0) {
      if (lastResponse) return lastResponse;
      throw Object.assign(new Error("Timed out waiting for worker coordinator."), { code: "ETIMEDOUT" });
    }
    const sliceMs = Math.max(1, Math.min(WAIT_SLICE_MS, remaining));
    const requestId = `wait-${randomUUID()}`;
    try {
      const response = await sendCoordinatorRequest(session, "worker.wait", { ...params, timeoutMs: sliceMs }, {
        requestId,
        idempotencyKey: requestId,
        timeoutMs: sliceMs + 1000
      });
      lastResponse = response;
      if (waitResultIsTerminal(response)) return response;
      if (deadline !== null && Date.now() >= deadline) return response;
      if (response.result?.coordinator === "restarting") {
        await waitSleep(retryDelay);
        try {
          session = await ensureCoordinatorSession(cwd, sessionOptions);
          retryDelay = RECONNECT_MIN_MS;
        } catch {
          retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
        }
      } else {
        retryDelay = RECONNECT_MIN_MS;
      }
    } catch (error) {
      if (!isRecoverableWaitError(error)) throw error;
      if (deadline !== null && Date.now() >= deadline) {
        if (lastResponse) return lastResponse;
        throw error;
      }
      await waitSleep(retryDelay);
      try {
        session = await ensureCoordinatorSession(cwd, sessionOptions);
        retryDelay = RECONNECT_MIN_MS;
      } catch {
        retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
      }
    }
  }
}

async function sessionIsReady(session) {
  try {
    await sendCoordinatorRequest(session, "coordinator.status", {}, { timeoutMs: 1000 });
    return true;
  } catch { return false; }
}

async function probeCoordinator(session) {
  try { return await sendCoordinatorRequest(session, "coordinator.status", {}, { timeoutMs: 1000 }); }
  catch { return null; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function readProcessIdentity(pid) {
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
  return { pid, executable, startIdentity };
}

function ownerMatchesProcess(owner) {
  const current = readProcessIdentity(owner?.pid);
  if (!current) return false;
  if (!owner.executable || !owner.startIdentity || !current.executable || !current.startIdentity) return true;
  return owner.executable === current.executable && owner.startIdentity === current.startIdentity;
}

async function acquireStartupLock(store) {
  const lockDir = path.join(store.rootDir, "coordinator-start.lock");
  const deadline = Date.now() + 5000;
  fs.mkdirSync(store.rootDir, { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      writePrivate(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      return () => fs.rmSync(lockDir, { recursive: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch {}
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if ((!owner || !processIsAlive(owner.pid)) && age > 30000) {
        fs.rmSync(lockDir, { recursive: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for coordinator startup ownership.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function ensureCoordinatorSession(cwd, options = {}) {
  const store = createWorkerStore(cwd, { dataRoot: options.dataRoot });
  const paths = sessionPaths(store);
  const releaseStartup = await acquireStartupLock(store);
  try {
    const loaded = loadCoordinatorSession(cwd, options);
    const owner = store.readOwnership();
    if (loaded && ownerMatchesProcess(owner) && owner.pid === loaded.pid && await sessionIsReady(loaded)) return loaded;
    if (fs.existsSync(paths.tokenFile)) {
      const discovered = { version: 1, repositoryId: store.identity.repositoryId, endpoint: paths.endpoint, ...paths, store };
      const probe = await probeCoordinator(discovered);
      const liveIdentity = readProcessIdentity(probe?.result?.coordinatorPid);
      if (probe?.result?.repositoryId === store.identity.repositoryId && liveIdentity) {
        const metadata = {
          version: 1,
          repositoryId: store.identity.repositoryId,
          endpoint: paths.endpoint,
          pid: liveIdentity.pid,
          executable: liveIdentity.executable,
          processStartIdentity: liveIdentity.startIdentity,
          startedAt: owner?.acquiredAt ?? new Date().toISOString()
        };
        writePrivate(path.join(store.rootDir, "coordinator-owner.lock", "owner.json"), `${JSON.stringify({ ...liveIdentity, acquiredAt: metadata.startedAt })}\n`);
        writePrivate(paths.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
        return { ...metadata, ...paths, store };
      }
    }
    if (ownerMatchesProcess(owner)) {
      const recovered = {
        version: 1,
        repositoryId: store.identity.repositoryId,
        endpoint: paths.endpoint,
        pid: owner.pid,
        executable: owner.executable,
        processStartIdentity: owner.startIdentity,
        startedAt: owner.acquiredAt,
        ...paths,
        store
      };
      if (fs.existsSync(paths.tokenFile) && await sessionIsReady(recovered)) {
        writePrivate(paths.metadataFile, `${JSON.stringify({
          version: recovered.version,
          repositoryId: recovered.repositoryId,
          endpoint: recovered.endpoint,
          pid: recovered.pid,
          executable: recovered.executable,
          processStartIdentity: recovered.processStartIdentity,
          startedAt: recovered.startedAt
        }, null, 2)}\n`);
        return recovered;
      }
      throw new Error(`Worker coordinator owner PID ${owner.pid} is live but its endpoint is not responding; refusing to replace it.`);
    }
    if (loaded?.pid && processIsAlive(loaded.pid)) {
      throw new Error(`Recorded worker coordinator PID ${loaded.pid} is alive but not responding; refusing to replace its endpoint.`);
    }
    if (owner) {
      if (processIsAlive(owner.pid)) {
        throw new Error(`Worker coordinator ownership record for PID ${owner.pid} is live but could not be authenticated; refusing to replace it.`);
      }
      fs.rmSync(path.join(store.rootDir, "coordinator-owner.lock"), { recursive: true });
    }

    fs.mkdirSync(store.rootDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.sessionDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      fs.chmodSync(store.rootDir, 0o700);
      fs.chmodSync(paths.sessionDir, 0o700);
    }
    writePrivate(paths.tokenFile, randomBytes(32).toString("hex"));
    const logFd = fs.openSync(paths.logFile, "a", 0o600);
    const args = [COORDINATOR_SCRIPT, "--cwd", cwd, "--endpoint", paths.endpoint, "--token-file", paths.tokenFile];
    if (options.dataRoot) args.push("--data-root", options.dataRoot);
    const child = spawn(process.execPath, args, {
      cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true
    });
    child.unref();
    fs.closeSync(logFd);
    const metadata = {
      version: 1,
      repositoryId: store.identity.repositoryId,
      endpoint: paths.endpoint,
      pid: child.pid,
      executable: process.execPath,
      processStartIdentity: readProcessIdentity(child.pid)?.startIdentity ?? null,
      startedAt: new Date().toISOString()
    };
    const session = { ...metadata, ...paths, store };
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await sessionIsReady(session)) {
        const claimedOwner = store.readOwnership();
        if (!ownerMatchesProcess(claimedOwner) || claimedOwner.pid !== child.pid) throw new Error("Coordinator answered without holding repository ownership.");
        metadata.executable = claimedOwner.executable;
        metadata.processStartIdentity = claimedOwner.startIdentity;
        writePrivate(paths.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
        Object.assign(session, metadata);
        return session;
      }
      if (!processIsAlive(child.pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Worker coordinator failed to start. See ${paths.logFile}.`);
  } finally { releaseStartup(); }
}

// The coordinator daemon reads prompts, schemas, and its own module graph once at startup, so
// edits to the plugin only take effect after it is replaced. Restart shuts the running daemon
// down, waits for the process to actually exit, and starts a fresh one.
export async function restartCoordinatorSession(cwd, options = {}) {
  const previous = loadCoordinatorSession(cwd, options);
  if (previous && !options.force) assertCoordinatorIdle(await probeCoordinator(previous), "restart");
  const stopped = await shutdownCoordinatorSession(cwd, options);
  if (previous?.pid) {
    const deadline = Date.now() + 5000;
    while (processIsAlive(previous.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (processIsAlive(previous.pid)) throw new Error(`Worker coordinator PID ${previous.pid} did not exit; refusing to start a second coordinator.`);
  }
  const session = await ensureCoordinatorSession(cwd, options);
  return { status: "restarted", previousStatus: stopped.status, previousPid: previous?.pid ?? null, pid: session.pid };
}

export async function shutdownCoordinatorSession(cwd, options = {}) {
  const session = loadCoordinatorSession(cwd, options);
  if (!session) return { status: "not-running" };
  if (!options.force) assertCoordinatorIdle(await probeCoordinator(session), "shutdown");
  try {
    return (await sendCoordinatorRequest(session, "coordinator.shutdown", {}, { timeoutMs: 1000 })).result;
  } catch (error) {
    if (error.code === "COORDINATOR_BUSY") throw error;
    return { status: "not-running" };
  }
}

function assertCoordinatorIdle(response, operation) {
  const result = response?.result;
  const activeTurns = Number(result?.activeTurns ?? 0);
  const activeWaiters = Number(result?.activeWaiters ?? 0);
  if (!result || (activeTurns <= 0 && activeWaiters <= 0)) return;
  const details = (result.activeWorkers ?? []).map((worker) => `${worker.workerId} (${worker.orchestrationId})`).join(", ");
  const suffix = details ? `: ${details}.` : ".";
  throw Object.assign(new Error(`Cannot ${operation} the worker coordinator while work is active${suffix} Use --force to continue.`), { code: "COORDINATOR_BUSY" });
}
