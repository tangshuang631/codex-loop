# codex_loop Console Design

> This document defines the first public-facing product shape for `codex_loop`.

## Goal

Build `codex_loop` as a standalone open-source local web console for long-running Codex development loops.

The repository must remain generic after clone:

- no user-specific workspace assumptions
- no bundled private project rules
- no example project that is required for startup

## Product Position

`codex_loop` is a reusable standalone tool that provides:

- long-running loop control
- graceful stop and graceful finalize
- time and token budget handling
- single-thread Codex history conventions
- local recovery state
- append-only local trace logs
- project-specific rule and verification adapters

It should feel like one continuous Codex workflow rather than a sidecar dashboard glued onto a separate agent.

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

Advanced settings may expose an optional local prompt generator:

- off by default
- powered by local `ollama`
- used only to improve the next follow-up message sent into the same Codex thread
- must fall back automatically to the stable built-in template when generation fails
- should be able to read local `ollama` model tags and let the user select a default model

## Frontend Architecture

Recommended first implementation:

- `Vite`
- `React`
- a minimal local HTTP service for state read/write

The frontend should talk to the generic `codex_loop` control layer and project adapter files.

## Information Architecture

### Top Bar

The top bar should show:

- current workspace or project name, if known
- current Codex thread title
- current loop mode
- current primary thread id
- latest error status

If project name cannot be resolved reliably, degrade gracefully and show:

- thread title
- thread id

Loop mode must support Chinese labels by default:

- `运行中`
- `收尾中`
- `已停止`

### Main Control Panel

The main control panel should support:

- start run
- request graceful stop
- set max minutes
- set max token budget
- set finalize lead minutes
- set finalize lead tokens

### Thread Binding Panel

The thread binding panel should show:

- primary Codex thread id
- primary Codex thread title
- thread note
- whether single-thread continuity is enforced

### Loop Creation Panel

Loop creation should feel like an assistant conversation rather than a raw form:

- ask for project path
- detect git
- detect likely docs
- infer project name and branch hints
- create the loop under the correct sidebar project group

## Visual Direction

The console should feel:

- calm
- editorial
- highly legible
- desktop-tool-like rather than marketing-page-like

Design rules:

- Chinese-first typography
- white minimal base
- wide, breathable layout
- compact but clear cards
- restrained motion
- no noisy path walls in the main workspace

## Reusability Boundary

The generic console must not hardcode:

- any user project name
- any one repository layout
- any one verification command set
- any bundled private development checklist

Those come from user-created loops and adapters.

## Design Summary

The public release of `codex_loop` should feel like a focused operator console for Codex loops:

- one app shell
- one current loop
- one clear thread
- one clear recovery path
- many user-defined projects, but no repository-bundled personal project baggage
