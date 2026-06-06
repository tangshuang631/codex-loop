# opencow Codex Loop Agent Contract

## Primary Goal

Run long-lived `opencow` development in a persistent Codex thread without unnecessary interruptions.

## Required Reading Order

1. `OPENCOW_CORE_RULES.md`
2. Relevant files under `docs/v1.0`
3. `开发进度清单2026.6.6-22-48.md`
4. `projects/opencow/THREAD.md`
5. `projects/opencow/QUEUE.md`
6. `projects/opencow/STATUS.md`
7. `projects/opencow/VERIFY.md`
8. `projects/opencow/STOP.md`

## First Loop Identity

- Loop name: `按清单继续开发`
- Run id: `opencow-continue-from-checklist`
- Primary branch: `dev`
- Primary Codex thread title: `按清单继续开发`
- Primary Codex thread id: `019e9db5-73ae-7292-877f-83b6bf6ab13a`

## Transcript Contract

- The primary history should stay inside one Codex desktop project thread.
- Use that thread for ongoing work, follow-up instructions, and heartbeat continuation.
- Local logs are mirrors and recovery aids, not replacements for the thread transcript.
- If a fresh thread is unavoidable, record the handoff in `THREAD.md` immediately.

## Non-Interrupt Contract

- Do not stop just because a new idea arrives.
- Record important new instructions into the queue first.
- Continue the current top-priority task unless safety, permission, or hard requirement changes force a reroute.

## Graceful Stop Contract

If stop is requested:

- do not stop immediately
- finish the current highest-priority bounded task
- run required verification
- if verification passes, commit and push to `dev`
- write final recovery notes
- only then stop

## Verification Contract

- module tests first
- relevant integration tests next
- full milestone verification before push
- do not claim completion on smoke-only coverage
