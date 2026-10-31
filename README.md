# wowinflatables.biz public MCP server — DRAFT v0.1 (NOT DEPLOYED)
Read-only. Six tools per /workspace/mcp-specs/wowinflatables-mcp-spec.md. Zero runtime deps, zero outbound calls, zero secrets.
- `mcp/public-content.json` — the ONLY data source; owner reviews line by line before any publish.
- `build/build_content.py` — regenerates it from `snapshot/` (live-site HTML fetched 2026-10-31). Never invents values.
- `src/server.js` — POST /mcp (Streamable HTTP, 2026-07-28 `server/discover` + legacy `initialize` 2025-11-25/2025-06-18). `MCP_ENABLED` must be exactly `true` (default off → 503).
- `npm test` — 11 tests. `client-check/` — dev-only official SDK client smoke test (not shipped).
Run locally: `env -i PATH=$PATH MCP_ENABLED=true node src/server.js` then `node client-check/check.mjs`.
Owner publishes. Not listed in any registry.
