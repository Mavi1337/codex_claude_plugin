import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

test("app-server client holds and resolves a typed server request exactly once", async () => {
  const cwd = makeTempDir("server-request-");
  const binDir = makeTempDir("server-request-bin-");
  installFakeCodex(binDir, "blocking-input");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  const client = await CodexAppServerClient.connect(cwd, { env, disableBroker: true });
  const thread = await client.request("thread/start", { cwd, model: "gpt-5.6-luna", approvalPolicy: "on-request", sandbox: "workspace-write", serviceName: "test", ephemeral: false });
  let resolveRequest;
  const requestSeen = new Promise((resolve) => { resolveRequest = resolve; });
  const completed = new Promise((resolve) => {
    client.setNotificationHandler((message) => {
      if (message.method === "turn/completed") resolve(message);
    });
  });
  client.setServerRequestHandler(resolveRequest);
  await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "ask", text_elements: [] }], model: "gpt-5.6-luna", effort: "xhigh", outputSchema: null });

  const request = await requestSeen;
  assert.equal(request.method, "item/tool/requestUserInput");
  client.respondToServerRequest(request.id, { answers: { choice: { answers: ["yes"] } } });
  await completed;
  assert.throws(() => client.respondToServerRequest(request.id, {}), /already resolved/i);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.deepEqual(state.lastServerResponse.result.answers.choice.answers, ["yes"]);
  await client.close();
});
