# opencow Graceful Stop Policy

## Meaning of stop

Stop means:

- do not start a new major task
- finish the current high-priority bounded task
- run required verification
- if verification succeeds, commit and push to `dev`
- write recovery status
- finalize the loop

## Stop triggers

- explicit user stop request
- time budget nearing limit
- token budget nearing limit
- repeated blocker that prevents meaningful progress

## Stop trigger handling

When the trigger appears:

1. mark the loop as `finalize_after_current`
2. keep working on the current bounded task
3. avoid expanding scope
4. prefer shipping the cleanest verified batch
5. leave the Codex thread with a clear final status update before stopping
