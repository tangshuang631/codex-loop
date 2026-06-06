# Codex Thread History Strategy

## Best-possible user experience

The best experience is:

- one persistent Codex project thread
- visible turns in the Codex desktop app
- heartbeat automation returning to that same thread
- local mirror logs for recovery and audit

That gives you a history that looks and behaves like a normal Codex conversation rather than an opaque background daemon.

## Why this matters

A pure external loop script can track files and logs, but it cannot by itself guarantee a first-class Codex desktop chat transcript.

When you want the desktop app to show the real development history, the Codex thread itself should be the primary history surface.

## Recommended split of responsibilities

- Codex thread:
  - user-visible chat history
  - narrative of reasoning, work, and results
  - place where new instructions arrive
- `codex_loop` runtime:
  - budget state
  - graceful-stop state
  - append-only event logs
  - recovery pointers
  - local transcript mirror

## Desktop-visible continuity

The strongest Codex-native pattern is:

1. start a dedicated project thread
2. refine the behavior inside that thread
3. attach a heartbeat automation to that same thread
4. let future runs continue there

This keeps the work visible in the same chat history instead of scattering it across separate jobs.

## Future Remote or Mobile Reading

As a later enhancement, `codex_loop` may expose a read-only summary surface for phones or other lightweight clients.

That future surface should prefer:

- current loop mode
- active task summary
- latest error summary
- latest verification summary
- primary thread title
- summarized recent Codex history

It should not replace the Codex desktop thread as the primary full transcript.
