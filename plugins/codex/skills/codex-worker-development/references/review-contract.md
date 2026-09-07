# Review contract

Every Sol turn — task review, final branch review, and oversized-package
synthesis — is a fresh `gpt-6-astra` turn at effort `low` unless `--effort`
names a higher one. Sol is read-only and reviews an immutable,
hashed package.

The gate passes only when specification verdict is `pass` and quality verdict is
`approve`. `cannot-verify` blocks automatic integration unless Claude records a
reasoned ruling. Critical and important findings require resolution or an
explicit user-visible adjudication; minor findings may coexist with approval.

Use one target per standalone review:

- branch/default base: `--base REF`
- exact commits: `--range A..B` or `--last N`
- frozen local state: `--worktree`, `--staged`, or `--unstaged`
- filtered change review: repeat `--path PATH` or `--file FILE` with a baseline
- current-state audit: repeat `--audit-path PATH` or use files without a baseline

For a task, use `--worker ID --task-review`; the coordinator derives the exact
base/head and records the package hash. Oversized packages split into bounded
passes and a fresh synthesis turn automatically, at the same effort.

Before handoff, offer an on-demand final review of the current branch against its
base. The user may instead choose the worktree, last N commits, an explicit
range, paths, files, or a subsystem audit.
