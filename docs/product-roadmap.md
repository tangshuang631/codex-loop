# codex_loop Product Roadmap

## Current priority

The current top priority is the core local loop business:

- stable runtime state
- Codex thread continuity
- strict project adapters
- user-tunable loop details
- graceful stop and finalize
- concise local console
- strong error handling without UI lockup

Current implementation progress:

- local runtime state is in place
- thread mirror and summary export are in place
- strict adapter model is in place
- manual heartbeat and thread sync inputs are in place
- project scaffolding is being added to speed up reuse
- quick thread binding helpers are being added to speed up real-project setup
- template-driven loop setup is being formalized
- loop renaming support is being added

## Near-term roadmap

1. strengthen Codex thread linkage and transcript mirror
2. improve adapter-driven strict defaults for different repositories
3. keep the local console fast, simple, and reliable
4. improve startup resilience and recovery messaging
5. formalize template-driven project loop setup
6. evaluate optional ccswitch-assisted telemetry enrichments

## Later roadmap

Later enhancements can broaden adoption, but they should not distract from the core loop:

- mobile-readable status page
- summarized Codex history viewing from phone
- optional remote read-only access
- richer adapter management

Current foundation for that direction:

- local summary export payload
- thread mirror metadata
- transcript mirror for fuller local recovery

## Template-driven setup direction

An important product direction is:

- provide a detailed loop template
- provide a clear usage guide
- let the developer hand both to an AI
- let the AI fill the template from the actual repository context
- turn that filled template into one concrete loop

This should make `codex_loop` more reusable and easier to adopt across different repositories.

## Mobile direction

Mobile support is valuable because it helps users check progress away from the desk.

But mobile is not a v1 core business requirement.

The correct ordering is:

1. make the core loop trustworthy
2. make Codex linkage feel seamless
3. add lightweight phone access for status and summaries

The first mobile capability should likely be:

- read-only
- summary-first
- safe by default

Not:

- full remote control
- destructive actions
- replacing the desktop Codex workflow
