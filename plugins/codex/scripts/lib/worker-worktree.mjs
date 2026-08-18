import fs from "node:fs";
import path from "node:path";

import { assertSafeId } from "./worker-protocol.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

function git(cwd, args) {
  return runCommand("git", args, { cwd, shell: false });
}

function gitChecked(cwd, args) {
  return runCommandChecked("git", args, { cwd, shell: false });
}

function fullOid(cwd, ref) {
  return gitChecked(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

function canonicalGitPath(cwd, argument) {
  const value = gitChecked(cwd, ["rev-parse", argument]).stdout.trim();
  return fs.realpathSync(path.resolve(cwd, value));
}

function statusPaths(cwd) {
  const fields = gitChecked(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    paths.push(field.slice(3));
    if (code.includes("R") || code.includes("C")) {
      const second = fields[++index];
      if (second) paths.push(second);
    }
  }
  return [...new Set(paths)].sort();
}

export function createTaskWorktree({ repoRoot, workerId, base = "HEAD", worktreeRoot }) {
  assertSafeId(workerId, "workerId");
  const baseCommit = fullOid(repoRoot, base);
  const root = path.resolve(worktreeRoot ?? path.join(path.dirname(repoRoot), ".codex-worker-worktrees"));
  fs.mkdirSync(root, { recursive: true });
  const worktree = path.join(root, workerId);
  if (fs.existsSync(worktree)) throw new Error(`Task worktree already exists: ${worktree}.`);
  const branch = `codex-worker/${workerId}`;
  gitChecked(repoRoot, ["worktree", "add", "-b", branch, worktree, baseCommit]);
  return {
    workerId, branch, worktree, base: baseCommit,
    commonDir: canonicalGitPath(worktree, "--git-common-dir"),
    gitDir: canonicalGitPath(worktree, "--git-dir")
  };
}

export function restoreTaskWorktree({ repoRoot, branch, worktree }) {
  if (typeof branch !== "string" || !branch.startsWith("codex-worker/")) throw new Error("Invalid saved worker branch.");
  const target = path.resolve(worktree);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  gitChecked(repoRoot, ["worktree", "prune", "--expire", "now"]);
  gitChecked(repoRoot, ["worktree", "add", target, branch]);
  return {
    branch,
    worktree: target,
    base: fullOid(repoRoot, branch),
    commonDir: canonicalGitPath(target, "--git-common-dir"),
    gitDir: canonicalGitPath(target, "--git-dir")
  };
}

export function rollbackTaskWorktreeCreation({ repoRoot, worktree, branch }) {
  if (fs.existsSync(worktree) && inspectTaskWorktree(worktree).dirty) throw new Error("Refusing to roll back a partial worker start with material changes.");
  if (fs.existsSync(worktree)) gitChecked(repoRoot, ["worktree", "remove", worktree]);
  if (branch?.startsWith("codex-worker/")) gitChecked(repoRoot, ["branch", "-D", branch]);
}

export function inspectTaskWorktree(cwd) {
  const paths = statusPaths(cwd);
  const ignored = gitChecked(cwd, ["status", "--porcelain=v1", "-z", "--ignored"]).stdout
    .split("\0").filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3)).sort();
  return { paths, ignored, dirty: paths.length > 0 };
}

export function commitTaskWorktree(cwd, options = {}) {
  if (options.expected) {
    const actual = {
      commonDir: canonicalGitPath(cwd, "--git-common-dir"),
      gitDir: canonicalGitPath(cwd, "--git-dir"),
      branch: gitChecked(cwd, ["branch", "--show-current"]).stdout.trim()
    };
    if (actual.commonDir !== options.expected.commonDir || actual.gitDir !== options.expected.gitDir || actual.branch !== options.expected.branch) {
      throw new Error("Task worktree repository, Git directory, or branch no longer matches its trusted assignment.");
    }
    const baseCommit = fullOid(cwd, options.expected.base);
    if (git(cwd, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]).status !== 0) {
      throw new Error("Task worktree HEAD is no longer descended from its assigned base.");
    }
  }
  const paths = statusPaths(cwd);
  if (paths.length === 0) throw new Error("Task worktree has no changes to commit.");
  const allowed = options.allowedPaths ? new Set(options.allowedPaths.map(String)) : null;
  if (allowed) {
    const unexpected = paths.filter((entry) => !allowed.has(entry));
    if (unexpected.length) throw new Error(`Task changed paths outside the allowed paths: ${unexpected.join(", ")}.`);
  }
  const submodules = gitChecked(cwd, ["ls-files", "--stage"]).stdout
    .split("\n").filter((line) => line.startsWith("160000 "));
  if (submodules.length) throw new Error("Task commits with submodules are not supported.");
  gitChecked(cwd, ["add", "--all", "--", ...paths]);
  const stagedPaths = gitChecked(cwd, ["diff", "--cached", "--name-only", "-z"]).stdout.split("\0").filter(Boolean).sort();
  const message = String(options.message ?? "Codex worker task").trim();
  gitChecked(cwd, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "user.name=Codex Worker Runtime",
    "-c", "user.email=codex-worker@localhost",
    "commit", "--no-verify", "--no-gpg-sign", "-m", message
  ]);
  const commit = fullOid(cwd, "HEAD");
  const tree = gitChecked(cwd, ["rev-parse", `${commit}^{tree}`]).stdout.trim();
  return { commit, tree, paths: stagedPaths };
}

export function applyReviewedCommits({ integrationCwd, expectedHead, base, head, expectedTree }) {
  const actualHead = fullOid(integrationCwd, "HEAD");
  const expected = fullOid(integrationCwd, expectedHead);
  if (actualHead !== expected) throw new Error(`Integration expected HEAD ${expected}, found ${actualHead}.`);
  const baseCommit = fullOid(integrationCwd, base);
  const headCommit = fullOid(integrationCwd, head);
  const headTree = gitChecked(integrationCwd, ["rev-parse", `${headCommit}^{tree}`]).stdout.trim();
  if (expectedTree && headTree !== expectedTree) throw new Error("Reviewed task tree no longer matches its immutable review binding.");
  const ancestor = git(integrationCwd, ["merge-base", "--is-ancestor", baseCommit, headCommit]);
  if (ancestor.status !== 0) throw new Error("Reviewed task head is not a descendant of its recorded base.");
  const commits = gitChecked(integrationCwd, ["rev-list", "--reverse", `${baseCommit}..${headCommit}`]).stdout.trim().split("\n").filter(Boolean);
  if (!commits.length) throw new Error("Reviewed range contains no commits.");
  for (const commit of commits) {
    const parents = gitChecked(integrationCwd, ["rev-list", "--parents", "-n", "1", commit]).stdout.trim().split(/\s+/).slice(1);
    if (parents.length > 1) throw new Error(`Merge commit ${commit} is not supported.`);
  }
  try {
    gitChecked(integrationCwd, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "cherry-pick", ...commits]);
  } catch (error) {
    git(integrationCwd, ["cherry-pick", "--abort"]);
    const restoredHead = fullOid(integrationCwd, "HEAD");
    if (restoredHead !== expected) {
      throw new Error(`Reviewed commit integration failed and rollback did not restore ${expected}; found ${restoredHead}. Manual repair is required.`);
    }
    throw new Error(`Reviewed commit integration failed and was aborted: ${error.message}`);
  }
  return { commits, head: fullOid(integrationCwd, "HEAD") };
}

export function closeTaskWorktree({ repoRoot, worktree }) {
  const material = gitChecked(worktree, ["status", "--porcelain=v1", "-z", "--ignored"]).stdout.split("\0").filter(Boolean);
  if (material.length) throw new Error(`Refusing to remove a worktree with ignored or untracked material: ${material.map((entry) => entry.slice(3)).join(", ")}.`);
  gitChecked(repoRoot, ["worktree", "remove", worktree]);
  return { removed: worktree };
}
