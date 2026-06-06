# opencow Codex Loop Agent Contract

## Primary Goal

Run long-lived `opencow` development in a persistent Codex thread without unnecessary interruptions.

## Required Reading Order

1. [`OPENCOW_CORE_RULES.md`](E:/2026/opencow/OPENCOW_CORE_RULES.md)
2. Relevant files under [`docs/v1.0`](E:/2026/opencow/docs/v1.0)
3. [`codex_loop/projects/opencow/THREAD.md`](E:/2026/opencow/codex_loop/projects/opencow/THREAD.md)
4. [`codex_loop/projects/opencow/QUEUE.md`](E:/2026/opencow/codex_loop/projects/opencow/QUEUE.md)
5. [`codex_loop/projects/opencow/STATUS.md`](E:/2026/opencow/codex_loop/projects/opencow/STATUS.md)
6. [`codex_loop/projects/opencow/VERIFY.md`](E:/2026/opencow/codex_loop/projects/opencow/VERIFY.md)
7. [`codex_loop/projects/opencow/STOP.md`](E:/2026/opencow/codex_loop/projects/opencow/STOP.md)

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
