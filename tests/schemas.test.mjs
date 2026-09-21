import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SCHEMA_DIR = fileURLToPath(new URL("../plugins/codex/schemas/", import.meta.url));

// The OpenAI structured-output API rejects a schema that is not strict-mode compliant with a 400
// `invalid_json_schema`, which surfaces to the operator only as a failed turn. These rules are the
// ones the API enforces, checked here so a reformat cannot quietly reintroduce the failure.
function lintStrictObject(schema, trail, problems) {
  if (schema.type !== "object") return;
  const properties = schema.properties ?? {};
  const names = Object.keys(properties);
  if (schema.additionalProperties !== false) problems.push(`${trail}: object must set "additionalProperties": false`);
  const required = schema.required ?? [];
  const missing = names.filter((name) => !required.includes(name));
  if (missing.length) problems.push(`${trail}: every property must be listed in "required"; missing ${missing.join(", ")}`);
  const extra = required.filter((name) => !names.includes(name));
  if (extra.length) problems.push(`${trail}: "required" names properties that do not exist: ${extra.join(", ")}`);
}

function lintNode(schema, trail, problems) {
  if (!schema || typeof schema !== "object") return;
  if (schema.enum && schema.type === undefined) problems.push(`${trail}: enum must also declare a "type"`);
  if (schema.const !== undefined && schema.type === undefined) problems.push(`${trail}: const must also declare a "type"`);
  if (schema.type === undefined && !schema.enum && schema.const === undefined && trail !== "#") {
    problems.push(`${trail}: every property needs an explicit "type"`);
  }
  lintStrictObject(schema, trail, problems);
  for (const [name, child] of Object.entries(schema.properties ?? {})) lintNode(child, `${trail}/${name}`, problems);
  if (schema.items) lintNode(schema.items, `${trail}[]`, problems);
}

const schemaFiles = fs.readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".schema.json"));

test("every published schema exists to be linted", () => {
  assert.ok(schemaFiles.length >= 2, `expected schemas in ${SCHEMA_DIR}`);
  assert.ok(schemaFiles.includes("worker-turn-output.schema.json"));
  assert.ok(schemaFiles.includes("reviewer-output.schema.json"));
});

for (const name of schemaFiles) {
  test(`${name} is valid strict-mode structured output`, () => {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf8"));
    const problems = [];
    lintNode(schema, "#", problems);
    assert.deepEqual(problems, [], `${name} is not strict-mode compliant:\n${problems.join("\n")}`);
  });
}

test("optional worker fields stay required but nullable", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "worker-turn-output.schema.json"), "utf8"));
  assert.ok(schema.required.includes("question"));
  assert.deepEqual(schema.properties.question.type, ["string", "null"]);
  assert.equal(schema.properties.schemaVersion.type, "integer");
  assert.equal(schema.properties.status.type, "string");
});
