# Specter bridge test suite

Run from `mcp-bridge/`:

```bash
npm test
```

The suite is contract-level and runs without Chrome. It protects:

- explicit `tab_eval` consent
- fail-closed target tabs and serialized execution
- frame-0 defaults and explicit iframe routing
- click safety checks
- bounded DOM traversal and inspection caches
- bounded downloads and tool exposure
- batch action limits, allowlisting, stop/continue behavior, and per-action results
- WSS heartbeat, ACKs, reconnect/requeue behavior, polling suppression, and queue byte limits

For live browser coverage, run the MCP smoke checks against a loaded extension after reloading the unpacked extension. Keep those tests separate from the deterministic CI suite because they require Chrome and a trusted/local WSS certificate.
