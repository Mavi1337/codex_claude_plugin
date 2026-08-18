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

test("oversized packages partition by manifest entries without silent truncation", () => {
  const repo = repoWithHistory();
  fs.writeFileSync(path.join(repo, "a.txt"), "a".repeat(200));
  fs.writeFileSync(path.join(repo, "b.txt"), "b".repeat(200));
  const target = resolveWorkerReviewTarget(repo, { worktree: true });
  const frozen = freezeReviewPackage(repo, target, { maxInputTokens: 40 });
  assert.ok(frozen.partitions.length >= 2);
  assert.deepEqual(
    [...new Set(frozen.partitions.flatMap((partition) => partition.paths))].sort(),
    frozen.manifest.filter((entry) => entry.included).map((entry) => entry.path).sort()
  );
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
