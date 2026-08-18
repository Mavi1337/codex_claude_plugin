# Implementation loop

## Per task

1. Start an explicit Luna worker with the shared orchestration ID. Its isolated
   worktree is created from the current accepted integration HEAD.
2. Send one focused instruction referencing the plan/spec paths, exact task,
   allowed paths, required interfaces, and verification commands. Use a unique
   idempotency key.
3. Wait on that worker ID. Handle states as follows:
   - `waiting-input`/`waiting-approval`: inspect `pendingRequest`, obtain any new
     user authority, then use `worker resolve-request` on the request ID.
   - completed structured `needs_input`: obtain the answer, then use `worker send`
     on the worker ID.
   - `failed`/`indeterminate`: inspect the durable error. Retry only from a known
     idle boundary with a new idempotency key.
   - `completed`/`completed_with_concerns`: read the canonical implementation
     report and inspect the worktree when needed.
4. Ask the coordinator to commit only the declared allowed paths. Record its
   full base, tree, and head object IDs.
5. Start a fresh task review with `--worker WORKER --task-review`. Read both
   verdicts and use the canonical report.
6. If blocked, adjudicate each material finding. Send confirmed changes to the
   same Luna worker, wait, commit again, and start a fresh re-review ID. Preserve
   finding IDs in the follow-up instruction.
7. When the gate passes, capture the current integration HEAD and run
   `integration apply --expected-head OID`. A stale-HEAD or conflict response is
   a repair task, not permission to bypass review.

## Concurrency

Run up to five inference turns across Luna and Sol. Keep tasks sequential when
they share files/interfaces or have unmet dependencies. A blocking callback
releases an inference slot but the task remains active. Update the ledger after
every commit, review, ruling, and integration.

## Stop and resume

`worker stop` interrupts inference while preserving state. `worker close`
closes its app-server while preserving thread, branch, and artifacts. Later use
`worker resume --worker ID`; do not create a replacement “latest” worker.
