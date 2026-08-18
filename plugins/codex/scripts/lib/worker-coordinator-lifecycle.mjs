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

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../codex-worker-coordinator.mjs", import.meta.url));

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
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for worker coordinator."));
    }, options.timeoutMs ?? 10000);
    socket.on("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.error) reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
        else resolve(response);
      } catch (error) { reject(error); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function sessionIsReady(session) {
  try {
    await sendCoordinatorRequest(session, "coordinator.status", {}, { timeoutMs: 1000 });
    return true;
  } catch { return false; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
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
    if (loaded && await sessionIsReady(loaded)) return loaded;
    if (loaded?.pid && processIsAlive(loaded.pid)) {
      throw new Error(`Recorded worker coordinator PID ${loaded.pid} is alive but not responding; refusing to replace its endpoint.`);
    }

    fs.mkdirSync(store.rootDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.sessionDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      fs.chmodSync(store.rootDir, 0o700);
      fs.chmodSync(paths.sessionDir, 0o700);
    }
    const target = parseBrokerEndpoint(paths.endpoint);
    if (target.kind === "unix" && fs.existsSync(target.path)) fs.unlinkSync(target.path);
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
      startedAt: new Date().toISOString()
    };
    writePrivate(paths.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
    const session = { ...metadata, ...paths, store };
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await sessionIsReady(session)) return session;
      if (!processIsAlive(child.pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Worker coordinator failed to start. See ${paths.logFile}.`);
  } finally { releaseStartup(); }
}

export async function shutdownCoordinatorSession(cwd, options = {}) {
  const session = loadCoordinatorSession(cwd, options);
  if (!session) return { status: "not-running" };
  try {
    return (await sendCoordinatorRequest(session, "coordinator.shutdown", {}, { timeoutMs: 1000 })).result;
  } catch {
    return { status: "not-running" };
  }
}
