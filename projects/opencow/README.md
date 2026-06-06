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

1. `OPENCOW_CORE_RULES.md`
2. Relevant docs under `docs/v1.0`
3. Starting context file: `开发进度清单2026.6.6-22-48.md`
4. Existing local module docs if the task touches them

## First Loop Baseline

- Loop name: `按清单继续开发`
- Run id: `opencow-continue-from-checklist`
- Branch: `dev`
- Primary Codex thread title: `按清单继续开发`
- Primary Codex thread id: `019e9db5-73ae-7292-877f-83b6bf6ab13a`
- Required start context: `OPENCOW_CORE_RULES.md`, `docs/v1.0`, `开发进度清单2026.6.6-22-48.md`

## Acceptance Focus

- `codex_loop` must stay generic
- `opencow` adaptation must be strict
- new work should live under this directory unless a later step explicitly integrates it elsewhere
