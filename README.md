# codex-loop

`codex-loop` is a reusable, local-first control layer for long-running Codex development loops.

It is designed to work with a real Codex thread, not replace one. The goal is to keep long-running development recoverable, inspectable, and easier to operate across different projects.

## What It Helps With

- Persistent loop state
- Graceful stop and graceful finalize signals
- Time-budget and token-budget wind-down
- Append-only trace logs
- Codex thread mirror metadata
- Recovery files for resuming work
- Project-specific verification and push rules
- Reusable project scaffolding for new repositories

## What It Does Not Try To Do

- It does not secretly drive the Codex product API.
- It does not replace the visible Codex conversation with a hidden shadow history.
- It does not bypass project verification, git discipline, or approval rules.
- It does not promise fully unattended development without project-specific setup and validation.

## Repository Layout

```text
app/
  server/        Local API for runtime state and loop control
  web/           Lightweight local web console
docs/            Product notes, design docs, roadmap
projects/        Example adapters and project-specific runbooks
scripts/         CLI helpers for init, heartbeat, finalize, scaffold, bind-thread
templates/       Reusable templates for loops, threads, and runbooks
tests/           Node test suite for the core tool
runtime/         Local runtime output (ignored in git)
dist/            Built web output (ignored in git)
```

## Quick Start

1. Install dependencies with `npm install`.
2. Copy `config.local.example.json` to `config.local.json`, then set `workspaceRoot` to the target repository you want to drive.
3. Run `npm run loop:check`.
4. Run `npm test`.
5. Run `npm run build:web`.
6. Start the launcher with `start-codex-loop.bat` or `npm run loop:start`.
7. Bind the loop to one dedicated Codex thread with `npm run loop:bind-thread`.

## Main Commands

- `npm run loop:check`
- `npm run loop:init`
- `npm run loop:heartbeat`
- `npm run loop:finalize`
- `npm run loop:summary`
- `npm run loop:scaffold`
- `npm run loop:bind-thread`
- `npm run loop:start`
- `npm run dev`
- `npm run build:web`
- `npm test`

## Core Design Principles

- Reusable first: the core loop should adapt to other repositories with minimal changes.
- Recoverable first: every run should leave enough local state to resume after interruption.
- Codex-thread first: the main development history should stay in a real Codex thread whenever possible.
- Honest control: stop means finish the current important task, verify, and then stop cleanly.
- Traceable by default: loop actions should leave append-only logs that are easy to inspect or delete later.

## Project Adapters

`codex-loop` supports project adapters so different repositories can enforce different verification rules, stop policies, and runbooks.

This repository includes:

- `projects/generic`: generic baseline adapter
- `projects/opencow`: example adapter and acceptance-case template

The `opencow` adapter is an example, not a hard dependency of the tool itself.

## Current Status

The core tooling, local console, runtime state, thread mirror, summary export, and scaffold flow are implemented and covered by tests.

The last verified local checks in this workspace were:

- `npm test`
- `npm run build:web`

Environment-specific local port restrictions may still block the local web console on some machines, so `npm run loop:check` should be treated as the first real machine-level validation step.

## Local Configuration

- Keep portable defaults in `config.json`.
- Put machine-specific values such as `workspaceRoot` in `config.local.json` or `CODEX_LOOP_WORKSPACE_ROOT`.
- `config.local.json` is ignored by git so the repository stays clone-safe.

## License

MIT
