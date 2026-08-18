import path from "node:path";

import { detectDefaultBranch } from "./git.mjs";
import { runCommandChecked } from "./process.mjs";

function git(cwd, args) {
  return runCommandChecked("git", args, { cwd, shell: false }).stdout.trim();
}

function oid(cwd, ref) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) throw new Error(`Invalid Git ref: ${ref}.`);
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function paths(values = []) {
  return values.map((value) => {
    const normalized = String(value).replaceAll("\\", "/");
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new Error(`Invalid review path: ${value}.`);
    }
    return normalized.replace(/^\.\//, "");
  });
}

export function resolveWorkerReviewTarget(cwd, options = {}) {
  const filesAreAudit = options.files?.length && !options.base && !options.range && !options.last && !options.worktree && !options.staged && !options.unstaged;
  const selectors = [options.base, options.worktree, options.staged, options.unstaged, options.last, options.range, options.auditPaths?.length || filesAreAudit].filter(Boolean);
  if (selectors.length > 1) throw new Error("Select exactly one review target: base, worktree, staged, unstaged, last, range, or audit.");
  const selectedPaths = paths(options.paths ?? options.files ?? options.auditPaths ?? []);
  if (options.worktree) return { mode: "worktree", paths: selectedPaths };
  if (options.staged) return { mode: "staged", paths: selectedPaths };
  if (options.unstaged) return { mode: "unstaged", paths: selectedPaths };
  if (options.auditPaths?.length || (options.files?.length && !options.base && !options.range)) {
    return { mode: "audit", paths: selectedPaths };
  }
  if (options.last) {
    const count = Number(options.last);
    if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("--last must be a positive integer.");
    return { mode: "committed", base: oid(cwd, `HEAD~${count}`), head: oid(cwd, "HEAD"), paths: selectedPaths, semantics: "two-dot-first-parent" };
  }
  if (options.range) {
    const match = String(options.range).match(/^(.+)\.\.([^.]*)$/);
    if (!match || !match[2] || match[1].includes("..")) throw new Error("Review range must use A..B two-dot syntax.");
    return { mode: "committed", base: oid(cwd, match[1]), head: oid(cwd, match[2]), paths: selectedPaths, semantics: "two-dot" };
  }
  const baseRef = options.base ?? detectDefaultBranch(cwd);
  return { mode: "committed", base: oid(cwd, baseRef), head: oid(cwd, "HEAD"), paths: selectedPaths, semantics: "two-dot" };
}
