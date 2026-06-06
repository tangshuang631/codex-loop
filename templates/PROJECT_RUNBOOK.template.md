# Project Runbook Template

## Required Inputs

- Project rules file path
- Relevant architecture or development docs
- Verification commands
- Branch policy
- Commit and push policy

## Required Loop Contract

1. Read project rules before starting a work batch.
2. Read the current loop state and queue before choosing the next task.
3. Treat new user instructions as queue updates unless they must preempt for safety.
4. If stop is requested, do not halt immediately.
5. Finish the current highest-priority task if it is in a safe, bounded state.
6. Run required verification.
7. If verification is green, commit and push according to project policy.
8. Write recovery status back to local files.
9. Stop only after the above steps are complete.

## Required Local Files

- `THREAD.md`
- `QUEUE.md`
- `STATUS.md`
- `VERIFY.md`
- `STOP.md`

## Required Logging

- the primary transcript should stay in one Codex thread whenever possible
- every run should record which Codex thread is primary
- every loop batch appends at least one event
- every verification attempt appends an event
- every stop/finalize request appends an event
- every commit/push decision appends an event
