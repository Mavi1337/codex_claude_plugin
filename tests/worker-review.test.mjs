import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveWorkerReviewTarget } from "../plugins/codex/scripts/lib/review-target.mjs";
import { freezeReviewPackage } from "../plugins/codex/scripts/lib/review-package.mjs";
import { evaluateReviewGate, validateSolReview } from "../plugins/codex/scripts/lib/worker-review.mjs";

function repoWithHistory() {
  const repo = makeTempDir("review-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "one\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "one"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "two\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "two"], { cwd: repo });
  return repo;
}

test("review target resolves last-N and rejects ambiguous combinations", () => {
  const repo = repoWithHistory();
  const target = resolveWorkerReviewTarget(repo, { last: 1, paths: ["app.js"] });
  assert.equal(target.mode, "committed");
  assert.match(target.base, /^[a-f0-9]{40,64}$/);
  assert.match(target.head, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(target.paths, ["app.js"]);
  assert.throws(() => resolveWorkerReviewTarget(repo, { last: 1, staged: true }), /exactly one review target/i);
});

test("frozen review package remains immutable after the worktree changes", () => {
  const repo = repoWithHistory();
  fs.writeFileSync(path.join(repo, "app.js"), "working copy\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "new evidence\n");
  const target = resolveWorkerReviewTarget(repo, { worktree: true });
  const frozen = freezeReviewPackage(repo, target, { maxInputTokens: 10000 });
  fs.writeFileSync(path.join(repo, "app.js"), "changed later\n");

  assert.match(frozen.content, /working copy/);
  assert.doesNotMatch(frozen.content, /changed later/);
  assert.match(frozen.hash, /^[a-f0-9]{64}$/);
  assert.equal(frozen.manifest.some((entry) => entry.path === "new.txt" && entry.kind === "untracked"), true);
});

test("oversized packages partition one large file into immutable bounded content", () => {
  const repo = repoWithHistory();
  fs.writeFileSync(path.join(repo, "a.txt"), "a".repeat(20000));
  const target = resolveWorkerReviewTarget(repo, { worktree: true });
  const frozen = freezeReviewPackage(repo, target, { maxInputTokens: 1000 });
  assert.ok(frozen.partitions.length >= 2);
  assert.equal(frozen.partitions.every((partition) => partition.estimatedTokens <= 1000), true);
  assert.equal(frozen.partitions.every((partition) => partition.content.includes(frozen.hash)), true);
  assert.equal(frozen.partitions.every((partition) => partition.content.includes("Manifest and pass ownership")), true);
  assert.equal(frozen.partitions.every((partition) => partition.paths.includes("a.txt")), true);
  assert.equal(frozen.coverageMap.some((entry) => entry.crossCutting), true);
});

test("audit roots recurse and committed file filters use the reviewed Git object", () => {
  const repo = repoWithHistory();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.js"), "committed\n");
  run("git", ["add", "src/a.js"], { cwd: repo });
  run("git", ["commit", "-m", "add source"], { cwd: repo });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  const base = run("git", ["rev-parse", "HEAD~1"], { cwd: repo }).stdout.trim();
  fs.writeFileSync(path.join(repo, "src", "a.js"), "working copy\n");

  const audit = freezeReviewPackage(repo, resolveWorkerReviewTarget(repo, { auditPaths: ["src"] }));
  assert.match(audit.content, /working copy/);
  const committed = freezeReviewPackage(repo, resolveWorkerReviewTarget(repo, { range: `${base}..${head}`, files: ["src/a.js"] }));
  assert.match(committed.content, /committed/);
  assert.doesNotMatch(committed.content, /working copy/);
});

test("Sol review schema supports location-free findings and deterministic gates", () => {
  const review = validateSolReview({
    schemaVersion: 1,
    specVerdict: "cannot-verify",
    qualityVerdict: "approve",
    summary: "Requirement source unavailable.",
    findings: [{ severity: "important", title: "Missing requirement evidence", evidence: "No spec supplied", impact: "Compliance is unknown", recommendation: "Attach the spec", confidence: 0.9, locations: [] }]
  }, { reviewId: "review-1", passId: "pass-1" });
  assert.match(review.findings[0].id, /^SOL-[A-F0-9]{12}$/);
  assert.equal(evaluateReviewGate(review).status, "block");
  assert.equal(evaluateReviewGate({ ...review, specVerdict: "pass", qualityVerdict: "approve", findings: [] }).status, "pass");
  assert.equal(evaluateReviewGate({ ...review, specVerdict: "pass", qualityVerdict: "changes-required" }).status, "block");
});

test("Sol validation rejects unknown fields and replaces model-provided finding IDs", () => {
  const base = {
    schemaVersion: 1,
    specVerdict: "pass",
    qualityVerdict: "approve",
    summary: "ok",
    findings: [{ id: "MODEL-ID", severity: "minor", title: "Title", evidence: "Evidence", impact: "Impact", recommendation: "Fix", confidence: 0.8, locations: [] }]
  };
  const validated = validateSolReview(base, { reviewId: "review-1", passId: "pass-1" });
  assert.match(validated.findings[0].id, /^SOL-/);
  assert.notEqual(validated.findings[0].id, "MODEL-ID");
  assert.throws(() => validateSolReview({ ...base, surprise: true }), /unknown top-level/i);
  assert.throws(() => validateSolReview({ ...base, findings: [{ ...base.findings[0], locationTypo: true }] }), /unknown fields/i);
});
