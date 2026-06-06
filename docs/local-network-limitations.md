# Local Network Limitations

`codex_loop` uses a local web console plus a local HTTP service.

Some execution environments restrict local port binding. When that happens, the tool should fail clearly instead of hanging.

## Defensive behavior

- server startup probes a local port range before giving up
- startup errors should be explicit
- frontend requests use a timeout
- polling failures should surface as status errors instead of freezing the UI

## Recommended usage

On a normal local developer machine:

```bash
npm run dev
```

## Manual port override

If you need fixed ports:

```bash
CODEX_LOOP_HOST=127.0.0.1 CODEX_LOOP_PORT=4518 CODEX_LOOP_WEB_PORT=4174 npm run dev
```

## If local binding still fails

Check:

- firewall policy
- endpoint security policy
- remote sandbox restrictions
- occupied local ports

The expected product behavior is graceful degradation, not silent failure and not UI lockup.
