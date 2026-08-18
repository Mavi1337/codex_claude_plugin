import { createHash } from "node:crypto";

const SPEC = new Set(["pass", "fail", "cannot-verify"]);
const QUALITY = new Set(["approve", "changes-required"]);
const SEVERITY = new Set(["critical", "important", "minor"]);

function stableId(reviewId, passId, finding) {
  const normalized = JSON.stringify([reviewId, passId, finding.severity, finding.title, finding.evidence, finding.locations ?? []]);
  return `SOL-${createHash("sha256").update(normalized).digest("hex").slice(0, 12).toUpperCase()}`;
}

export function validateSolReview(value, context = {}) {
  if (!value || value.schemaVersion !== 1) throw new Error("Sol review must use schemaVersion 1.");
  if (!SPEC.has(value.specVerdict)) throw new Error("Invalid Sol specification verdict.");
  if (!QUALITY.has(value.qualityVerdict)) throw new Error("Invalid Sol quality verdict.");
  if (typeof value.summary !== "string" || !Array.isArray(value.findings)) throw new Error("Sol review summary and findings are required.");
  const findings = value.findings.map((finding) => {
    if (!SEVERITY.has(finding.severity) || !finding.title || !finding.evidence || !finding.impact || !finding.recommendation) {
      throw new Error("Invalid Sol finding fields.");
    }
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) throw new Error("Finding confidence must be between zero and one.");
    const locations = finding.locations ?? [];
    if (!Array.isArray(locations)) throw new Error("Finding locations must be an array.");
    return { ...finding, id: finding.id ?? stableId(context.reviewId ?? "review", context.passId ?? "pass", finding), locations };
  });
  return { ...value, findings };
}

export function evaluateReviewGate(review, options = {}) {
  if (review.specVerdict === "pass" && review.qualityVerdict === "approve") return { status: "pass", reason: "Both required verdicts pass." };
  if (review.specVerdict === "cannot-verify" && options.controllerRuling?.waive === true) return { status: "pass-with-ruling", reason: options.controllerRuling.reason };
  return { status: "block", reason: review.specVerdict !== "pass" ? `Specification verdict is ${review.specVerdict}.` : "Code quality requires changes." };
}

export function validateWorkerResult(value) {
  const statuses = new Set(["completed", "completed_with_concerns", "needs_input", "blocked"]);
  if (!value || value.schemaVersion !== 1 || !statuses.has(value.status)) throw new Error("Invalid worker result status or schema version.");
  if (typeof value.summary !== "string" || !Array.isArray(value.tests) || !Array.isArray(value.changedFiles) || !Array.isArray(value.concerns)) {
    throw new Error("Invalid worker result fields.");
  }
  for (const test of value.tests) {
    if (!test || typeof test.command !== "string" || typeof test.result !== "string") throw new Error("Invalid worker test result.");
  }
  return value;
}
