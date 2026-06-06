# codex_loop Console Design

> This document defines the first public-facing product shape for `codex_loop`.

## Goal

Build `codex_loop` as a standalone open-source local web console for long-running Codex development loops.

The tool must remain useful outside `opencow`. `opencow` is only an adapter example, validation target, and documentation case.

## Product Position

`codex_loop` is not an `opencow` feature with a nicer wrapper.

`codex_loop` is a reusable standalone tool that provides:

- long-running loop control
- graceful stop and graceful finalize
- time and token budget handling
- single-thread Codex history conventions
- local recovery state
- append-only local trace logs
- project-specific rule and verification adapters

It must feel like one continuous Codex workflow rather than a sidecar dashboard glued onto a separate agent.

`opencow` only contributes:

- one example adapter
- one example verification baseline
- one example runbook
- one example acceptance target

Removing `opencow` from the repository model must not make the core `codex_loop` design invalid.

## Core Experience

The best user experience is:

- one persistent Codex project thread
- one local web console for loop control
- one local runtime directory for recovery and logs
- graceful stop instead of abrupt interruption

The Codex thread is the primary visible transcript.

The local runtime is the control and recovery layer.

The project adapter is the strict default-policy layer.

The user override layer is the safe micro-tuning layer.

## Frontend Scope

The first frontend is a desktop-local web console.

It should be:

- simple
- fast
- Chinese-first
- UTF-8 by default
- pleasant enough to ship publicly
- small in scope

English support is not required for v1. Chinese-first behavior is the default. A future settings entry may expose language switching, but English can remain unfinished in the first release.

## Frontend Architecture

Recommended first implementation:

- `Vite`
- `React`
- a minimal local HTTP service for state read/write

The console should not directly depend on `opencow` internals.

The frontend should talk to the generic `codex_loop` control layer and project adapter files.

The frontend should make the following model legible:

- Codex main thread history
- project adapter defaults
- user overrides

## Information Architecture

### Top Bar

The top bar should show:

- current workspace or project name, if known
- current Codex thread title
- current loop mode
- current primary thread id
- latest error status

If the Codex desktop app can expose project name and thread title together, prefer a presentation close to:

- `opencow / 评估长时开发方案`

If project name cannot be resolved reliably, degrade gracefully and show:

- thread title
- thread id

Loop mode must support Chinese labels by default:

- `运行中`
- `收尾中`
- `已停止`

An internal English mapping may exist, but Chinese-first display is required.

### Main Control Panel

The main control panel should support:

- start run
- request graceful stop
- set max minutes
- set max token budget
- set finalize lead minutes
- set finalize lead tokens
- show current run id
- show workspace path
- show branch

### Status Panel

The status panel should show:

- current active task
- current phase
- whether finalize mode is active
- last heartbeat time
- last verification result
- last commit result
- last push result

### Thread Binding Panel

The thread binding panel should show:

- primary Codex thread id
- primary Codex thread title
- thread note
- whether single-thread continuity is enforced
- thread handoff warning if the loop moves to a new thread

This panel is about binding and visibility, not full automation management.

### Loop Profile Panel

The console should also show:

- which adapter is active
- how strict the current loop profile is
- which parts come from project defaults
- which parts the user has overridden

The user must be able to micro-tune loop behavior without destroying the project's strict default strategy.

### Footer Utility Area

The footer utility area should show:

- latest error message
- state file path
- log file path
- transcript mirror path
- runtime directory path

The console only needs to show short path summaries and quick actions.

Detailed logs do not need to be rendered in the UI.

## Error Handling

The frontend must show:

- concise error summary
- likely failing area
- log path

The frontend does not need to inline full log bodies in v1.

This keeps the UI fast and uncluttered while still making debugging practical.

## Visual Direction

The console should feel:

- calm
- editorial
- highly legible
- desktop-tool-like rather than marketing-page-like

It should not look like a generic admin panel.

Design rules:

- Chinese-first typography
- wide, breathable layout
- compact but clear cards
- fast status scanning
- restrained motion
- strong contrast for controls
- no cluttered metrics wall

The page should prioritize utility first and visual polish second, but it still needs a refined feel suitable for open-source release.

## UX Priorities

1. See whether the loop is safe to leave alone.
2. See which thread is the primary visible history.
3. Request graceful stop without ambiguity.
4. Confirm where logs and state files live.
5. Confirm current budget and finalize policy quickly.

## Reusability Boundary

The generic console must not hardcode:

- `opencow`
- `dev`
- any one repository layout
- any one verification command set

Those come from project adapters.

Each project should be able to supply the most suitable strict loop profile through an adapter file.

Then the user may override selected details such as:

- whether stop always finishes the current task first
- whether push is required before stop
- whether a visible primary thread is mandatory
- budget numbers

The generic console may ship with:

- a generic adapter schema
- one built-in sample adapter
- one `opencow` example adapter

## Proposed File Structure

```text
codex_loop/
  app/
    server/
    web/
  docs/
  projects/
    opencow/
  scripts/
  templates/
  tests/
```

Suggested responsibility split:

- `app/server`: local API for runtime state and adapter config
- `app/web`: React console
- `projects/opencow`: adapter example only

## Acceptance Criteria

The first console release is acceptable when:

- `codex_loop` still makes sense as a standalone project
- the UI can start a run
- the UI can request graceful stop
- the UI can configure time and token budgets
- the UI can show current mode in Chinese
- the UI can show thread binding information
- the UI can show concise error information and log paths
- `opencow` remains only an example adapter and case

## Non-Goals For v1

- full automation creation UI
- detailed log viewer
- multi-language completeness
- desktop packaging
- advanced analytics dashboards
- embedded terminal emulator
- mobile-first companion experience

## Implementation Direction

Implementation should proceed in this order:

1. generic local server contract
2. runtime state and thread metadata endpoints
3. basic React console shell
4. budget and stop controls
5. thread binding display
6. concise error and path display
7. `opencow` adapter demonstration

## Future Mobile Companion

This is a lower-priority direction and must not disrupt the core desktop-local loop tool.

The future goal is to let users check loop status and Codex conversation continuity from a phone.

The likely shape is not a full mobile control surface first. The likely first version is:

- mobile-readable snapshot page
- loop summary
- current mode
- current active task
- latest error summary
- primary Codex thread title
- recent conversation summary rather than full raw history

Recommended priority order:

1. desktop-local core loop remains stable
2. Codex thread continuity remains trustworthy
3. local recovery and logs remain correct
4. mobile read-only or summary access can be added later

Important boundary:

- mobile support is useful for adoption
- mobile support is not allowed to weaken local-first safety
- mobile support is not allowed to become a reason to bypass the main Codex desktop thread model

If mobile viewing is added later, prefer:

- read-only by default
- summary-first by default
- explicit opt-in for any remote exposure
- minimal operational surface rather than full control

## Design Summary

The first public release of `codex_loop` should feel like a focused operator console for Codex loops:

- one screen
- one primary thread
- one clear loop state
- one clear stop path
- one clear recovery path

That is the right balance between open-source usefulness, implementation speed, and future desktop packaging.
