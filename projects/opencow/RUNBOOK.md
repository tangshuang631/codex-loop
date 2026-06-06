# Project Runbook

## Goal

Run opencow through a strict, recoverable Codex loop.

## Verification commands

- `npm run test`
- `npm run test:unit`
- `npm run build`
- `npm run verify:all`

## Loop contract

1. Keep one primary Codex thread whenever possible.
2. Finish the current bounded task before graceful stop.
3. Run verification before claiming completion.
4. Update local mirror files after each meaningful batch.

