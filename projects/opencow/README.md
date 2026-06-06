# opencow codex_loop adaptation

This directory adapts the reusable `codex_loop` tool to `opencow`.

The acceptance target is not just "documents exist". The target is:

- the loop remains recoverable
- the main history remains visible in one Codex desktop thread
- stop means graceful finish, not abrupt exit
- verification follows `opencow` rules
- push goes to `dev`
- loop logs are append-only and manually deletable

## Required Rule Sources

Read in this order:

1. [`OPENCOW_CORE_RULES.md`](E:/2026/opencow/OPENCOW_CORE_RULES.md)
2. Relevant docs under [`docs/v1.0`](E:/2026/opencow/docs/v1.0)
3. Existing local module docs if the task touches them

## Acceptance Focus

- `codex_loop` must stay generic
- `opencow` adaptation must be strict
- new work should live under this directory unless a later step explicitly integrates it elsewhere
