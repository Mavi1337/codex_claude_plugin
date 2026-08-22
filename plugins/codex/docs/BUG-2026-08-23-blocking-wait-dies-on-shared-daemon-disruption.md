# BUG: `worker wait` is a single unresumable in-memory RPC — any daemon disruption (esp. another session's `coordinator restart`) silently kills the caller's watch

Date: 2026-08-23
Reporter: Phase 3 coordinator session (repo `react-flow-blockchain-tracer`, repositoryId `repo-df111f8073ac9eb3d17d`)
Severity: HIGH for multi-session use — the coordinator daemon is per-repository and shared; one session's lifecycle ops break another session's waits, and the failure mode is *silence* (the waiting controller never learns the turn finished).

## Observed

During orchestration `phase3-export-20260822`, three background `worker wait --worker t4-stream --timeout 0` invocations (and one status-poll loop) died with harness status "killed" between ~22:00–22:20 UTC on 2026-08-22, while the worker's turn kept running to successful completion. A second Claude session was operating Luna workers against the **same repository** at the time:

- coordinator PID changed 2241874 → 2270847 (restart at 21:09 UTC, initiated by the other session),
- `workerCount` rose 24 → 28 (other session's workers),
- both sessions share the daemon and its `maxConcurrent: 5` turn slots.

No data was lost (turn state is store-persisted), but every wakeup was: the controller only recovered because a human noticed. A controller that sleeps on `worker wait` has no way to distinguish "turn still running" from "my waiter was dropped an hour ago".

## Root cause (code pointers, this worktree)

1. **Server side — waiters are in-memory promises with no durability and no flush on shutdown.**
   `scripts/lib/worker-coordinator.mjs:783-793`: `wait(workerId, timeoutMs = 0)` registers `{resolve, timer:null}` in `this.waiters` and, with `timeoutMs = 0`, sets **no timer** — the promise resolves only when the turn ends. `coordinator.shutdown` (`worker-coordinator.mjs:402`) just returns `{status:"shutting-down"}` and exits; pending waiters are never resolved or rejected, the socket drops, and the client is left holding a dead connection.

2. **Client side — one connection, one request, no reconnect.**
   `scripts/codex-workers.mjs:116,133`: `wait` maps to a single `worker.wait` request with `timeoutMs` passed through (0 = infinite) over the session endpoint (`ensureCoordinatorSession`, `scripts/lib/worker-coordinator-lifecycle.mjs:156`). There is no retry/re-discover loop: if the daemon restarts, the client process errors out or hangs and — when run as a harness background task — surfaces as killed, not as a typed "daemon restarted, re-issue your wait".

3. **No guard on cross-session restart.**
   `scripts/lib/worker-coordinator-lifecycle.mjs:269 restartCoordinatorSession` shuts down unconditionally. It never consults `activeTurns` / registered waiters (`worker-coordinator.mjs:399` shows the daemon knows both), so session B can restart the daemon while session A has live turns and armed waits — session A's workers then also need `worker resume` before the next send, which session A has no signal to know about.

## Proposed fix (three parts, independently useful, do all three)

### F1 — make `worker wait` a resumable sliced poll (client)
In `codex-workers.mjs` (or a shared lib helper), replace the single infinite RPC with a loop:
- issue `worker.wait` with a **bounded server-side slice** (e.g. `min(remaining, 30_000)` ms; with `--timeout 0`, loop forever in 30 s slices);
- after each slice returning a non-terminal turn, re-issue;
- on connection error (ECONNREFUSED/ENOENT/EPIPE/socket close), call `ensureCoordinatorSession` again (it re-discovers or restarts the endpoint per its existing ownership rules), then re-issue the wait; back off 250 ms → 2 s;
- the turn's terminal state is store-persisted, so a wait re-issued after a daemon restart returns the correct answer immediately (`wait()`'s fast path at `worker-coordinator.mjs:784-785` already handles "already terminal").
This makes `wait` semantically identical but survives daemon restarts and connection reaping. Exit code/output contract unchanged.

### F2 — flush waiters on shutdown (server)
In the `coordinator.shutdown` path, before exiting: resolve every entry in `this.waiters` (and reject/answer in-flight requests) with the worker's current status plus a marker field, e.g. `"coordinator": "restarting"`, so a legacy client gets a clean response instead of a dropped socket. Clear timers. This alone turns the silent kill into an actionable payload even without F1.

### F3 — refuse disruptive restart while turns/waiters are live (lifecycle)
`restartCoordinatorSession` / `shutdownCoordinatorSession`: query `coordinator.status` first; if `activeTurns > 0` or waiters are registered, **refuse** with a message listing the active worker ids and their owning orchestrations, unless `--force` is passed. This is the multi-session guard: session B gets told "session A has 1 live turn (t4-stream, phase3-export-20260822); use --force to restart anyway". Keep `--force` working because plugin-code reloads legitimately need it.

## Repro

1. Session A: `worker start` a Luna worker, `worker send` a long prompt, then `worker wait --worker X --timeout 0` in the background.
2. Session B (same repo): `coordinator restart`.
3. Observe: A's wait dies (or hangs) with no payload; A's worker turn continues and completes invisibly; A additionally needs `worker resume` before its next `send` and has received no signal saying so.
Expected after fix: A's wait survives the restart (F1), or at minimum returns a typed "restarting" payload (F2); B's restart is refused while A's turn is live unless forced (F3).

## Acceptance criteria for the implementing worker

- A test (or scripted harness check) that starts a wait, restarts the daemon, and proves the wait still returns the turn's terminal status (F1) — this is the load-bearing one.
- A test that shutdown resolves registered waiters with the marker field (F2).
- A test that restart without `--force` is refused while a turn is active and the refusal names the worker (F3).
- No change to the JSON output contract of a successful `worker wait` besides the optional `"coordinator"` marker field.
- Note for regression scope: `worker status` one-shot polling worked correctly throughout the incident and must stay stateless/cheap — controllers now use it as a Monitor-based watchtower and that pattern must keep working.
