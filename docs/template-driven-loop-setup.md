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

## New Assistant-Led Creation Flow

`codex_loop` now supports a Chinese-first assistant flow inside the left sidebar.

Instead of forcing users to fill a large form first, the console can now:

1. ask for the project path
2. auto-detect whether a local git repository exists
3. infer the likely working branch
4. scan for rule docs and development docs
5. infer basic verification commands from the repository type
6. ask for the project display name and loop name
7. create the loop and place it under the matching project group in the sidebar

This keeps the creation experience closer to "talking to an operator assistant" rather than editing raw configuration.

## Safety Rules For Assistant-Created Loops

Assistant-created loops should carry stronger safety defaults than a manual quick-create:

- remind before milestone-scale changes or large batches that a git push may be needed
- if no local git repository is detected, surface that clearly before long automation use
- preserve the detected or confirmed branch as loop metadata
- store discovered rule docs and dev docs as loop context paths
- pause and notify the user when permissions or local tool access become a blocking condition

These rules exist because git discipline, recoverability, and document traceability are central to the product's differentiation from native automation.

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

- `core-longrun-loop`
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

Current implementation reality:

- on the current workstation, no reusable `ccswitch` provider-routing config or public local API was discovered
- therefore `codex_loop` should not hard-depend on direct `ccswitch` provider control yet
- first implementation should treat `ccswitch` compatibility as a future integration layer, not a current hard feature

Practical near-term rule:

- support local model continuation generation now
- document a future `ccswitch` bridge for provider-aware prompt generation or telemetry
- prefer “same provider strategy as current Codex” as a product setting concept before attempting deep `ccswitch` coupling

Practical future use cases for optional `ccswitch` integration:

- capture richer token accounting when Codex itself does not expose enough detail
- capture model-routing context that developers already manage through `ccswitch`
- enrich `codex_loop` summaries or dashboards without hard-coupling the core loop runtime to one provider tool
- optionally reuse the same provider family that the active Codex workflow is already using, if a stable `ccswitch` integration surface becomes available
