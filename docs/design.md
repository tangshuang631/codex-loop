# codex_loop Design

## Architecture

`codex_loop` has two layers:

- Generic control layer
- Project adaptation layer

When Codex thread continuation is available, there is also a primary transcript surface:

- Codex desktop thread history

The generic layer owns:

- state machine
- budget handling
- append-only logs
- runtime directory layout
- reusable templates
- thread metadata and transcript mirror conventions

The project layer owns:

- project rules and required docs
- verification commands
- branch and push policy
- task queue semantics

The Codex thread owns:

- the user-visible conversation history
- the running narration of what Codex said and did
- the place where heartbeat continuations should return

## Runtime layout

Each run lives under:

```text
codex_loop/runtime/<run-id>/
  thread.json
  state.json
  transcript.md
  logs/
    events.jsonl
```

`thread.json` stores the durable mapping to the Codex thread when one exists.

`transcript.md` is a local mirror and summary, not the source of truth when the Codex desktop thread is available.

## Modes

- `running`
- `finalize_after_current`
- `stopped`

## Budget behavior

The loop starts graceful finalize before the hard time or token ceiling.

That means:

- time can be used as a soft boundary
- token count can be used as a soft boundary
- the loop should not overshoot very far because it starts winding down early

## Traceability

Every run should leave:

- a mapped Codex thread id and title when available
- visible Codex thread turns for the main transcript
- run initialization event
- heartbeat events
- verification result events
- stop or finalize events
- commit and push decision events

Manual deletion is allowed because logs are local operational artifacts rather than authoritative product history.

## Preferred History Model

For the best Codex-native experience:

1. Use one dedicated project thread for the loop.
2. Keep continuing that same thread instead of opening new ones.
3. Use thread heartbeat automations when you want scheduled continuation.
4. Let the Codex desktop thread remain the primary readable transcript.
5. Keep local logs as a mirror and recovery aid.

This is the closest model to "it looks like I personally kept chatting with Codex while it kept working."
