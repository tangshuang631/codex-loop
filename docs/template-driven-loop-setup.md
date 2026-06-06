# Template-Driven Loop Setup

## Purpose

`codex_loop` should support a workflow where a developer gives an AI:

- the `codex_loop` usage guide
- the loop template
- the target repository context

The AI then fills the template based on the actual project and turns it into one concrete loop configuration.

This creates a practical bridge between:

- generic `codex_loop` tooling
- project-specific loop rules
- real Codex thread continuity

## Recommended workflow

1. Choose or create the target repository.
2. Give the AI:
   - `templates/LOOP_TEMPLATE.md`
   - this setup guide
   - the repository docs and rules
3. Ask the AI to fill the template from real project context only.
4. Save the completed loop definition into the repository or adapter folder.
5. Rename the loop if needed.
6. Bind it to the intended Codex thread.

## Why this is useful

This pattern keeps `codex_loop` reusable while still making each loop concrete and strict.

Instead of hardcoding one workflow for every repository, the AI can:

- inspect project structure
- discover real verification commands
- read local rules
- fill a strict loop definition

That filled definition becomes one specific loop inside `codex_loop`.

## Loop naming

Each loop should have a human-readable name.

Examples:

- `opencow-longrun-core`
- `release-hardening-loop`
- `adapter-refactor-sweep`

The tool should allow renaming loops later without rewriting the whole setup.

Current product direction:

- a loop can begin as a filled template
- that loop can then be renamed to a clearer operational name
- the renamed loop should keep the same runtime state and thread linkage

## ccswitch note

If deep token telemetry or provider-specific execution details are hard to obtain directly from Codex, an optional future integration path may use `ccswitch`.

Reason:

- many developers already use `ccswitch` alongside Codex
- it may be a more practical place to capture some provider-level metrics
- it should remain optional and must not become a hard dependency for the core tool

Current rule:

- `ccswitch` is an optional integration path
- the core `codex_loop` product must remain useful without it

Practical future use cases for optional `ccswitch` integration:

- capture richer token accounting when Codex itself does not expose enough detail
- capture model-routing context that developers already manage through `ccswitch`
- enrich `codex_loop` summaries or dashboards without hard-coupling the core loop runtime to one provider tool
