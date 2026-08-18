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

function collect(cwd, target) {
  const pathFilter = pathArgs(target);
  if (target.mode === "committed") {
    const changed = names(cwd, ["diff", "--name-only", target.base, target.head, ...pathFilter]);
    const diff = git(cwd, ["diff", "--find-renames", target.base, target.head, ...pathFilter]);
    return { manifest: changed.map((entry) => fileEvidence(cwd, entry, "committed")), sections: [{ title: `Diff ${target.base}..${target.head}`, body: diff }] };
  }
  if (target.mode === "audit") {
    const manifest = target.paths.map((entry) => fileEvidence(cwd, entry, "audit"));
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

function buildPartitions(manifest, maxInputTokens) {
  const included = manifest.filter((entry) => entry.included);
  const partitions = [];
  let current = { id: "pass-1", paths: [], estimatedTokens: 0 };
  for (const entry of included) {
    const estimate = Math.max(1, Math.ceil((entry.bytes + entry.path.length + 64) / 4));
    if (current.paths.length && current.estimatedTokens + estimate > maxInputTokens) {
      partitions.push(current);
      current = { id: `pass-${partitions.length + 1}`, paths: [], estimatedTokens: 0 };
    }
    current.paths.push(entry.path);
    current.estimatedTokens += estimate;
  }
  if (current.paths.length) partitions.push(current);
  return partitions;
}

export function freezeReviewPackage(cwd, target, options = {}) {
  const collected = collect(cwd, target);
  const header = JSON.stringify({ schemaVersion: 1, target, manifest: collected.manifest.map(({ source, ...entry }) => entry) }, null, 2);
  const content = [`# Immutable Sol Review Package`, "", "## Manifest", "", "```json", header, "```", "", ...collected.sections.flatMap((section) => [`## ${section.title}`, "", section.body, ""])].join("\n");
  const hash = sha(content);
  const estimatedTokens = Math.ceil(Buffer.byteLength(content) / 4);
  const maxInputTokens = options.maxInputTokens ?? 190000;
  return {
    schemaVersion: 1,
    target,
    manifest: collected.manifest.map(({ source, ...entry }) => entry),
    content,
    hash,
    estimatedTokens,
    approximation: "utf8-bytes-divided-by-four",
    partitions: estimatedTokens > maxInputTokens ? buildPartitions(collected.manifest, maxInputTokens) : [{ id: "pass-1", paths: collected.manifest.filter((entry) => entry.included).map((entry) => entry.path), estimatedTokens }]
  };
}
