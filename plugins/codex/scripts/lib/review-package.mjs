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
    return {
      manifest: changed.map((entry) => committedFileEvidence(cwd, target.head, entry)),
      sections: changed.map((entry) => ({ path: entry, title: `Diff ${target.base}..${target.head}: ${entry}`, body: git(cwd, ["diff", "--find-renames", target.base, target.head, "--", entry]) }))
    };
  }
  if (target.mode === "audit") {
    const manifest = auditFiles(cwd, target.paths).map((entry) => fileEvidence(cwd, entry, "audit"));
    if (!manifest.some((entry) => entry.included)) throw new Error("Audit target contains no reviewable files.");
    return { manifest, sections: manifest.filter((entry) => entry.included).map((entry) => ({ path: entry.path, title: `File ${entry.path}`, body: entry.source ?? "" })) };
  }
  const manifest = [];
  const sections = [];
  if (target.mode === "staged" || target.mode === "worktree") {
    const changed = names(cwd, ["diff", "--cached", "--name-only", ...pathFilter]);
    manifest.push(...changed.map((entry) => fileEvidence(cwd, entry, "staged")));
    sections.push(...changed.map((entry) => ({ path: entry, title: `Frozen staged diff: ${entry}`, body: git(cwd, ["diff", "--cached", "--find-renames", "--", entry]) })));
  }
  if (target.mode === "unstaged" || target.mode === "worktree") {
    const changed = names(cwd, ["diff", "--name-only", ...pathFilter]);
    manifest.push(...changed.map((entry) => fileEvidence(cwd, entry, "unstaged")));
    sections.push(...changed.map((entry) => ({ path: entry, title: `Frozen unstaged diff: ${entry}`, body: git(cwd, ["diff", "--find-renames", "--", entry]) })));
  }
  if (target.mode === "worktree") {
    const untracked = names(cwd, ["ls-files", "--others", "--exclude-standard", ...pathFilter]);
    const records = untracked.map((entry) => fileEvidence(cwd, entry, "untracked"));
    manifest.push(...records);
    for (const entry of records.filter((record) => record.included)) sections.push({ path: entry.path, title: `Untracked ${entry.path}`, body: entry.source ?? "" });
  }
  const unique = new Map(manifest.map((entry) => [entry.path, entry]));
  return { manifest: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)), sections };
}

function renderPackage(target, manifest, sections, extraSections = [], metadata = {}) {
  const header = JSON.stringify({
    schemaVersion: 1,
    target,
    originalPackageHash: metadata.originalPackageHash ?? null,
    passKind: metadata.passKind ?? "complete",
    ownedPaths: metadata.ownedPaths ?? manifest.map((entry) => entry.path),
    coveragePart: metadata.coveragePart ?? null,
    manifest: manifest.map(({ source, ...entry }) => entry)
  }, null, 2);
  return [
    "# Immutable Sol Review Package",
    "",
    "## Manifest and pass ownership",
    "",
    "```json",
    header,
    "```",
    "",
    ...extraSections.flatMap((section) => [`## ${section.title}`, "", section.body, ""]),
    ...sections.flatMap((section) => [`## ${section.title}`, "", section.body, ""])
  ].join("\n");
}

function estimatedTokens(content) { return Math.ceil(Buffer.byteLength(content) / 4); }

function splitText(source, maxBytes) {
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character);
    if (chunk && bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function buildManifestPartitions(target, collected, extraSections, packageHash, maxInputTokens) {
  const maxBytes = maxInputTokens * 4;
  const groups = collected.manifest.map((entry) => ({
    entry,
    sections: collected.sections.filter((section) => section.path === entry.path)
  }));
  const partitions = [];
  let current = [];

  function renderGroups(selected, metadata = {}) {
    return renderPackage(
      target,
      selected.map((group) => group.entry),
      selected.flatMap((group) => group.sections),
      extraSections,
      { originalPackageHash: packageHash, ownedPaths: selected.map((group) => group.entry.path), ...metadata }
    );
  }

  function pushGroups(selected) {
    if (!selected.length) return;
    const content = renderGroups(selected, { passKind: "path-owned" });
    if (Buffer.byteLength(content) <= maxBytes) {
      partitions.push({ paths: selected.map((group) => group.entry.path), content });
      return;
    }
    if (selected.length !== 1) throw new Error("Internal review partitioning error: oversized multi-path pass.");
    const group = selected[0];
    const combined = group.sections.map((section) => `## ${section.title}\n\n${section.body}\n`).join("\n") || "(No textual body; inspect the manifest reason.)";
    const empty = renderPackage(target, [group.entry], [], extraSections, {
      originalPackageHash: packageHash, passKind: "path-segment", ownedPaths: [group.entry.path], coveragePart: "9999/9999"
    });
    const bodyBudget = maxBytes - Buffer.byteLength(empty) - 256;
    if (bodyBudget < 256) throw new Error(`Fixed task-review evidence leaves no bounded room for ${group.entry.path}; raise the package limit or narrow requirements.`);
    const chunks = splitText(combined, bodyBudget);
    chunks.forEach((body, index) => {
      const content = renderPackage(target, [group.entry], [{ path: group.entry.path, title: `Bounded segment ${index + 1}/${chunks.length}: ${group.entry.path}`, body }], extraSections, {
        originalPackageHash: packageHash, passKind: "path-segment", ownedPaths: [group.entry.path], coveragePart: `${index + 1}/${chunks.length}`
      });
      if (Buffer.byteLength(content) > maxBytes) throw new Error(`Unable to enforce the configured Sol input bound for ${group.entry.path}.`);
      partitions.push({ paths: [group.entry.path], content });
    });
  }

  for (const group of groups) {
    const candidate = [...current, group];
    if (current.length && Buffer.byteLength(renderGroups(candidate, { passKind: "path-owned" })) > maxBytes) {
      pushGroups(current);
      current = [group];
    } else current = candidate;
  }
  pushGroups(current);
  if (!partitions.length) {
    const content = renderPackage(target, collected.manifest, collected.sections, extraSections, {
      originalPackageHash: packageHash, passKind: "path-owned", ownedPaths: []
    });
    if (Buffer.byteLength(content) > maxBytes) throw new Error("Fixed review evidence exceeds the configured input bound.");
    partitions.push({ paths: [], content });
  }
  if (partitions.length > 1) {
    const coverage = partitions.map((partition, index) => ({ pass: index + 1, ownedPaths: partition.paths }));
    const content = renderPackage(target, collected.manifest, [{
      title: "Cross-cutting interfaces, tests, and coverage map",
      body: `Review relationships across all owned paths and verify every coverage-map entry reaches synthesis.\n\n${JSON.stringify(coverage, null, 2)}`
    }], [], { originalPackageHash: packageHash, passKind: "cross-cutting", ownedPaths: collected.manifest.map((entry) => entry.path) });
    if (Buffer.byteLength(content) > maxBytes) throw new Error("Cross-cutting coverage manifest exceeds the configured input bound; narrow the target.");
    partitions.push({ paths: collected.manifest.map((entry) => entry.path), content, crossCutting: true });
  }
  return partitions.map((partition, index) => ({
    id: partition.crossCutting ? "cross-cutting" : `pass-${index + 1}`,
    ...partition,
    hash: sha(partition.content),
    estimatedTokens: estimatedTokens(partition.content)
  }));
}

export function freezeReviewPackage(cwd, target, options = {}) {
  const collected = collect(cwd, target);
  const verified = collect(cwd, target);
  const snapshotFingerprint = (value) => sha(JSON.stringify({
    manifest: value.manifest.map(({ source, ...entry }) => ({ ...entry, sourceHash: source === undefined ? null : sha(source) })),
    sections: value.sections.map((section) => ({ path: section.path, title: section.title, hash: sha(section.body) }))
  }));
  if (snapshotFingerprint(collected) !== snapshotFingerprint(verified)) {
    throw new Error("Review target changed while its immutable snapshot was being captured; retry from a stable boundary.");
  }
  const extraSections = options.extraSections ?? [];
  const content = renderPackage(target, collected.manifest, collected.sections, extraSections);
  const hash = sha(content);
  const packageTokens = estimatedTokens(content);
  const maxInputTokens = options.maxInputTokens ?? 190000;
  const rawPartitions = packageTokens > maxInputTokens
    ? buildManifestPartitions(target, collected, extraSections, hash, maxInputTokens)
    : [{ id: "pass-1", paths: collected.manifest.map((entry) => entry.path), content, hash, estimatedTokens: packageTokens }];
  return {
    schemaVersion: 1,
    target,
    manifest: collected.manifest.map(({ source, ...entry }) => entry),
    content,
    hash,
    estimatedTokens: packageTokens,
    approximation: "utf8-bytes-divided-by-four",
    partitions: rawPartitions,
    coverageMap: rawPartitions.map((partition) => ({ id: partition.id, paths: partition.paths, crossCutting: partition.crossCutting === true })),
    requiresPartitioning: packageTokens > maxInputTokens
  };
}
