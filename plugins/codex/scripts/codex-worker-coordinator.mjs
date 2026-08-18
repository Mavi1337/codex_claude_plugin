#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import process from "node:process";

import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { MAX_FRAME_BYTES, validateEnvelope } from "./lib/worker-protocol.mjs";
import { WorkerCoordinator } from "./lib/worker-coordinator.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const cwd = option("--cwd");
const endpoint = option("--endpoint");
const tokenFile = option("--token-file");
const dataRoot = option("--data-root") ?? undefined;
if (!cwd || !endpoint || !tokenFile) {
  console.error("Usage: codex-worker-coordinator.mjs --cwd <path> --endpoint <value> --token-file <path>");
  process.exit(2);
}

const token = fs.readFileSync(tokenFile, "utf8").trim();
const coordinator = new WorkerCoordinator({ cwd, dataRoot });
const identity = coordinator.store.identity;
const target = parseBrokerEndpoint(endpoint);
if (target.type === "unix" && fs.existsSync(target.path)) fs.unlinkSync(target.path);

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      socket.end(`${JSON.stringify({ error: { code: "FRAME_TOO_LARGE", message: "Maximum frame size exceeded." } })}\n`);
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      void (async () => {
        let envelope;
        try {
          envelope = validateEnvelope(JSON.parse(line), { frameBytes: Buffer.byteLength(line) });
          if (envelope.token !== token || envelope.repositoryId !== identity.repositoryId) {
            throw Object.assign(new Error("Coordinator authorization failed."), { code: "UNAUTHORIZED" });
          }
          const result = await coordinator.dispatch(envelope.operation, envelope.params, envelope.idempotencyKey);
          socket.write(`${JSON.stringify({ version: 1, requestId: envelope.requestId, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ version: 1, requestId: envelope?.requestId ?? null, error: { code: error.code ?? "INTERNAL", message: error.message } })}\n`);
        }
      })();
    }
  });
});

server.listen(target.path, () => {
  if (target.type === "unix") fs.chmodSync(target.path, 0o600);
});

async function shutdown() {
  server.close();
  await Promise.allSettled(coordinator.list().map((worker) => coordinator.close(worker.id)));
  if (target.type === "unix" && fs.existsSync(target.path)) fs.unlinkSync(target.path);
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
