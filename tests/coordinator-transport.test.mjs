import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { sendCoordinatorRequest } from "../plugins/codex/scripts/lib/worker-coordinator-lifecycle.mjs";

// A coordinator that accepts the connection and never answers, standing in for a `worker wait`
// that is legitimately blocked on a long Luna turn.
function silentCoordinator(t) {
  const dir = makeTempDir("silent-coordinator-");
  const socketPath = path.join(dir, "broker.sock");
  const tokenFile = path.join(dir, "coordinator.token");
  fs.writeFileSync(tokenFile, "token");
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  // Both ends must be torn down explicitly: an indefinite request holds an open socket, which
  // would otherwise keep the test runner alive forever.
  t.after(() => new Promise((resolve) => {
    for (const socket of connections) socket.destroy();
    server.close(resolve);
  }));
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      endpoint: `unix:${socketPath}`,
      tokenFile,
      store: { identity: { repositoryId: "repo-test" } }
    }));
  });
}

test("a positive transport timeout still gives up", async (t) => {
  const session = await silentCoordinator(t);
  await assert.rejects(
    () => sendCoordinatorRequest(session, "worker.wait", {}, { timeoutMs: 200 }),
    /Timed out waiting for worker coordinator/
  );
});

test("a zero transport timeout waits indefinitely instead of capping a blocking wait", async (t) => {
  const session = await silentCoordinator(t);
  const pending = sendCoordinatorRequest(session, "worker.wait", {}, { timeoutMs: 0 });
  const settled = await Promise.race([
    pending.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 1500))
  ]);
  assert.equal(settled, "still-waiting");
  pending.catch(() => {});
});
