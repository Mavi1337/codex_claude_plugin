import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";

function git(cwd, args) { return runCommandChecked("git", args, { cwd, shell: false }).stdout; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function pathArgs(target) { return target.paths?.length ? ["--", ...target.paths] : []; }
function names(cwd, args) {
  const separator = args.indexOf("--");
  const withNull = separator === -1
    ? [...args, "-z"]
    : [...args.slice(0, separator), "-z", ...args.slice(separator)];
  return git(cwd, withNull).split("\0").filter(Boolean);
}

function fileEvidence(cwd, relativePath, kind) {
  const absolute = path.join(cwd, relativePath);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return { path: relativePath, kind: "symlink", included: true, hash: sha(fs.readlinkSync(absolute)), bytes: 0 };
    if (!stat.isFile()) return { path: relativePath, kind, included: false, reason: "not-file", bytes: 0 };
    const data = fs.readFileSync(absolute);
    if (!isProbablyText(data)) return { path: relativePath, kind: "binary", included: false, reason: "binary", hash: sha(data), bytes: data.length };
    return { path: relativePath, kind, included: true, hash: sha(data), bytes: data.length, source: data.toString("utf8") };
  } catch {
    return { path: relativePath, kind: "deleted", included: true, hash: sha("deleted"), bytes: 0, source: "(deleted)" };
  }
}

function committedFileEvidence(cwd, head, relativePath) {
  try {
    const source = git(cwd, ["show", `${head}:${relativePath}`]);
    const data = Buffer.from(source);
    if (!isProbablyText(data)) return { path: relativePath, kind: "binary", included: false, reason: "binary", hash: sha(data), bytes: data.length };
    return { path: relativePath, kind: "committed", included: true, hash: sha(data), bytes: data.length, source };
  } catch {
    return { path: relativePath, kind: "deleted", included: true, hash: sha("deleted"), bytes: 0, source: "(deleted)" };
  }
}

function auditFiles(cwd, roots) {
  const tracked = names(cwd, ["ls-files", "--", ...roots]);
  const untracked = names(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...roots]);
  const explicitFiles = roots.filter((entry) => {
    try { return fs.lstatSync(path.join(cwd, entry)).isFile() || fs.lstatSync(path.join(cwd, entry)).isSymbolicLink(); }
    catch { return false; }
  });
  const result = [...new Set([...tracked, ...untracked, ...explicitFiles])].sort();
  if (result.length > 10000) throw new Error("Audit target exceeds the 10,000-file safety limit; select a narrower subsystem.");
  return result;
}

function collect(cwd, target) {
  const pathFilter = pathArgs(target);
  if (target.mode === "committed") {
    const changed = names(cwd, ["diff", "--name-only", target.base, target.head, ...pathFilter]);
    const diff = git(cwd, ["diff", "--find-renames", target.base, target.head, ...pathFilter]);
    return { manifest: changed.map((entry) => committedFileEvidence(cwd, target.head, entry)), sections: [{ title: `Diff ${target.base}..${target.head}`, body: diff }] };
  }
  if (target.mode === "audit") {
    const manifest = auditFiles(cwd, target.paths).map((entry) => fileEvidence(cwd, entry, "audit"));
    if (!manifest.some((entry) => entry.included)) throw new Error("Audit target contains no reviewable files.");
    return { manifest, sections: manifest.filter((entry) => entry.included).map((entry) => ({ title: `File ${entry.path}`, body: entry.source ?? "" })) };
  }
  const manifest = [];
  const sections = [];
  if (target.mode === "staged" || target.mode === "worktree") {
    const changed = names(cwd, ["diff", "--cached", "--name-only", ...pathFilter]);
    manifest.push(...changed.map((entry) => fileEvidence(cwd, entry, "staged")));
    sections.push({ title: "Frozen staged diff", body: git(cwd, ["diff", "--cached", "--find-renames", ...pathFilter]) });
  }
  if (target.mode === "unstaged" || target.mode === "worktree") {
    const changed = names(cwd, ["diff", "--name-only", ...pathFilter]);
    manifest.push(...changed.map((entry) => fileEvidence(cwd, entry, "unstaged")));
    sections.push({ title: "Frozen unstaged diff", body: git(cwd, ["diff", "--find-renames", ...pathFilter]) });
  }
  if (target.mode === "worktree") {
    const untracked = names(cwd, ["ls-files", "--others", "--exclude-standard", ...pathFilter]);
    const records = untracked.map((entry) => fileEvidence(cwd, entry, "untracked"));
    manifest.push(...records);
    for (const entry of records.filter((record) => record.included)) sections.push({ title: `Untracked ${entry.path}`, body: entry.source ?? "" });
  }
  const unique = new Map(manifest.map((entry) => [entry.path, entry]));
  return { manifest: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)), sections };
}

function buildContentPartitions(content, packageHash, maxInputTokens) {
  if (!Number.isInteger(maxInputTokens) || maxInputTokens < 64) throw new Error("Review max-input-tokens must be an integer of at least 64.");
  const headerBudget = 256;
  const byteLimit = maxInputTokens * 4;
  const bodyLimit = byteLimit - headerBudget;
  const partitions = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of content) {
    const bytes = Buffer.byteLength(character);
    if (chunk && chunkBytes + bytes > bodyLimit) {
      partitions.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += bytes;
  }
  if (chunk) partitions.push(chunk);
  return partitions.map((body, index) => {
    const header = `# Immutable Sol Review Package — bounded part ${index + 1}/${partitions.length}\n\nOriginal package SHA-256: ${packageHash}\nEvery part must be covered by synthesis.\n\n`;
    const partContent = `${header}${body}`;
    const estimatedTokens = Math.ceil(Buffer.byteLength(partContent) / 4);
    if (estimatedTokens > maxInputTokens) throw new Error("Unable to enforce the configured Sol input bound.");
    return { id: `pass-${index + 1}`, content: partContent, hash: sha(partContent), estimatedTokens };
  });
}

export function freezeReviewPackage(cwd, target, options = {}) {
  const collected = collect(cwd, target);
  const header = JSON.stringify({ schemaVersion: 1, target, manifest: collected.manifest.map(({ source, ...entry }) => entry) }, null, 2);
  const sections = [...(options.extraSections ?? []), ...collected.sections];
  const content = [`# Immutable Sol Review Package`, "", "## Manifest", "", "```json", header, "```", "", ...sections.flatMap((section) => [`## ${section.title}`, "", section.body, ""])].join("\n");
  const hash = sha(content);
  const estimatedTokens = Math.ceil(Buffer.byteLength(content) / 4);
  const maxInputTokens = options.maxInputTokens ?? 190000;
  const partitions = estimatedTokens > maxInputTokens
    ? buildContentPartitions(content, hash, maxInputTokens)
    : [{ id: "pass-1", content, hash, estimatedTokens }];
  return {
    schemaVersion: 1,
    target,
    manifest: collected.manifest.map(({ source, ...entry }) => entry),
    content,
    hash,
    estimatedTokens,
    approximation: "utf8-bytes-divided-by-four",
    partitions,
    requiresPartitioning: estimatedTokens > maxInputTokens
  };
}
