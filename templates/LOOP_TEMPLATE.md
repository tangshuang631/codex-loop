# codex_loop Loop Template

> Give this template and the usage guide to Codex or another AI assistant. The AI should fill this template using the actual project context, then save the completed version into the target repository.

## Loop Identity

- Loop name:
- Workspace root:
- Adapter id:
- Primary Codex thread title:
- Primary Codex thread id:

## Project Context

- Project type:
- Main language(s):
- Main framework(s):
- Primary branch:
- Critical docs to read first:
- Critical safety or workflow rules:

## Loop Goal

- What this loop is responsible for:
- What this loop is not allowed to do:
- What counts as done:

## Verification Contract

- Focused verification commands:
- Full verification commands:
- Build commands:
- Encoding or lint commands:
- Push requirements:

## Graceful Stop Contract

- Should stop finish the current bounded task first?
- Must verification pass before stop?
- Must commit happen before stop?
- Must push happen before stop?

## Budget Defaults

- Max minutes:
- Max tokens:
- Finalize lead minutes:
- Finalize lead tokens:

## Thread Continuity

- Must use a single primary Codex thread?
- Is heartbeat continuation preferred?
- Is visible thread history mandatory?

## Summary Rules

- How should recent user intent be summarized?
- How should recent Codex actions be summarized?
- How should the thread-level summary be written?

## Notes For AI Filling This Template

- Read project rules before filling.
- Prefer strict defaults over permissive defaults.
- If verification is unclear, choose the safest complete command set you can justify.
- Do not invent project-specific commands if you cannot discover them.
