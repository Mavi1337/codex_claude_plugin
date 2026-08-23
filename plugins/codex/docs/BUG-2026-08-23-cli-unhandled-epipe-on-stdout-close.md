# BUG: codex-workers.mjs crashes with unhandled EPIPE when stdout closes early

**Date:** 2026-08-23
**Reporter:** Phase 3 coordinator session (react-flow-blockchain-tracer)
**Severity:** Low (cosmetic/ergonomic), but it masks operation outcomes.

## Symptom

Piping the adapter's JSON output through anything that closes stdout before the
full payload is written — the natural `| head -c 200` while orchestrating —
kills the process with an unhandled `'error'` event:

```
$ node .../codex-workers.mjs worker close --worker t6b-gwlever --cwd "$REPO" --json | head -c 200
{"version":1,"requestId":"...","result":{"id":"t6b-gwlever",... [truncated]
node:events:486
      throw er; // Unhandled 'error' event
      ^
Error: write EPIPE
    at WriteWrap.onWriteComplete [as oncomplete] (node:internal/stream_base_commons:87:19)
...
errno: -32, code: 'EPIPE', syscall: 'write'
```

The underlying operation (here `worker close`) **had already succeeded** — a
follow-up `worker list` showed the worker closed — but the caller sees a crash
stack and a non-zero exit, which reads as failure. In a coordinator loop that
branches on exit codes, this is a false negative.

## Repro

Any command whose JSON result exceeds the pipe reader's appetite:

```
node codex-workers.mjs worker status --worker <any> --cwd <repo> --json | head -c 100
```

(Larger payloads make it more likely; `worker status` payloads are ~6KB.)

## Expected

Standard CLI behavior: ignore/absorb EPIPE on stdout and exit 0 (the reader
chose to stop consuming; that is not an error). E.g. early in the entrypoint:

```js
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
```

(Ditto stderr if it can be piped.)

## Notes

- Observed on node v24.14.0, plugin worktree state as of 2026-08-23.
- Related but distinct from BUG-2026-08-23-blocking-wait-dies-on-shared-daemon-
  disruption.md (still open as far as this reporter knows).
