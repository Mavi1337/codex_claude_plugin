import { createHash } from "node:crypto";

const SPEC = new Set(["pass", "fail", "cannot-verify"]);
const QUALITY = new Set(["approve", "changes-required"]);
const SEVERITY = new Set(["critical", "important", "minor"]);

function stableId(reviewId, passId, finding) {
  const normalizedLocations = (finding.locations ?? []).map((location) => [location.path, location.line ?? null]).sort();
  const normalized = JSON.stringify([reviewId, passId, finding.title.trim().toLowerCase(), finding.evidence.trim(), normalizedLocations]);
  return `REVIEW-${createHash("sha256").update(normalized).digest("hex").slice(0, 12).toUpperCase()}`;
}

export function validateReviewerOutput(value, context = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) throw new Error("Reviewer review must use schemaVersion 1.");
  const topKeys = new Set(["schemaVersion", "specVerdict", "qualityVerdict", "summary", "findings"]);
  if (Object.keys(value).some((key) => !topKeys.has(key))) throw new Error("Reviewer review contains unknown top-level fields.");
  if (!SPEC.has(value.specVerdict)) throw new Error("Invalid Reviewer specification verdict.");
  if (!QUALITY.has(value.qualityVerdict)) throw new Error("Invalid Reviewer quality verdict.");
  if (typeof value.summary !== "string" || !Array.isArray(value.findings)) throw new Error("Reviewer review summary and findings are required.");
  const findings = value.findings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error("Invalid Reviewer finding object.");
    const findingKeys = new Set(["id", "severity", "title", "evidence", "impact", "recommendation", "confidence", "locations", "supersedes", "duplicateOf"]);
    if (Object.keys(finding).some((key) => !findingKeys.has(key))) throw new Error("Reviewer finding contains unknown fields.");
    if (!SEVERITY.has(finding.severity) || !finding.title || !finding.evidence || !finding.impact || !finding.recommendation) {
      throw new Error("Invalid Reviewer finding fields.");
    }
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) throw new Error("Finding confidence must be between zero and one.");
    const locations = finding.locations ?? [];
    if (!Array.isArray(locations)) throw new Error("Finding locations must be an array.");
    for (const location of locations) {
      if (!location || typeof location !== "object" || Array.isArray(location) || typeof location.path !== "string" || !location.path || Object.keys(location).some((key) => !["path", "line"].includes(key))) {
        throw new Error("Invalid Reviewer finding location.");
      }
      if (location.line !== undefined && location.line !== null && (!Number.isInteger(location.line) || location.line < 1)) throw new Error("Invalid Reviewer finding line.");
    }
    if (finding.supersedes !== undefined && (!Array.isArray(finding.supersedes) || finding.supersedes.some((id) => typeof id !== "string"))) throw new Error("Invalid Reviewer supersedes relationship.");
    if (finding.duplicateOf !== undefined && finding.duplicateOf !== null && typeof finding.duplicateOf !== "string") throw new Error("Invalid Reviewer duplicate relationship.");
    return { ...finding, id: stableId(context.reviewId ?? "review", context.passId ?? "pass", finding), locations };
  });
  return { ...value, findings };
}

export function evaluateReviewGate(review, options = {}) {
  if (review.specVerdict === "pass" && review.qualityVerdict === "approve") return { status: "pass", reason: "Both required verdicts pass." };
  if (
    review.specVerdict === "cannot-verify"
    && review.qualityVerdict === "approve"
    && options.controllerRuling?.waive === true
    && typeof options.controllerRuling.reason === "string"
    && options.controllerRuling.reason.trim()
  ) return { status: "pass-with-ruling", reason: options.controllerRuling.reason };
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
