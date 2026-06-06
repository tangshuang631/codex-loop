# opencow Verification Contract

## Focused tool verification

Run:

```bash
npm --prefix codex_loop test
```

Expected:

- the loop tool tests pass
- budget-triggered graceful finalize behavior is covered
- runtime initialization writes traceable state and logs

## opencow project verification baseline

Follow `docs/v1.0/08-testing-acceptance.md`.

Tie verification back to the active checklist item in `开发进度清单2026.6.6-22-48.md` before claiming the batch is ready to push.

Minimum baseline before pushing `dev`:

```bash
npm run test:unit
npm run build
npm run check:encoding
npm run check:health
cd apps/desktop/src-tauri
cargo test
```

If the current change is more focused, prove the focused module tests first, then run the full baseline before push.
