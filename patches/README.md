# Patched Dependencies

This directory contains bun patches for npm dependencies where upstream hasn't yet shipped a fix we need. Patches are applied automatically on `bun install` via the `patchedDependencies` field in `package.json`.

## @ai-sdk/mcp@1.0.21 — MCP Protocol Version 2025-11-25

**Date applied:** 2026-02-20
**Issue:** PSD Data MCP connector fails on AWS dev with `"Server's protocol version is not supported: 2025-11-25"`
**Root cause:** `@ai-sdk/mcp` 1.0.21 (latest as of 2026-02-20) hardcodes `SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]`. The PSD Data Lambda MCP server advertises protocol version `2025-11-25` (the November 2025 MCP spec release), which the SDK rejects during the initialization handshake.

### What the patch changes

- Sets `LATEST_PROTOCOL_VERSION` from `"2025-06-18"` to `"2025-11-25"` — this is the version announced to MCP servers during the handshake
- Keeps `"2025-06-18"` in `SUPPORTED_PROTOCOL_VERSIONS` — without this, bumping `LATEST_PROTOCOL_VERSION` would drop `2025-06-18` from the accepted list, breaking older servers
- Files modified: `dist/index.js` and `dist/index.mjs`

> **Note on versioning:** The patch is pinned to `@ai-sdk/mcp@1.0.21`. If the lockfile resolves a different version (e.g., after `bun update`), the patch will silently stop applying. Always keep `@ai-sdk/mcp` locked to `1.0.21` while this patch is active, or run `bun install --frozen-lockfile` in CI to catch version drift.

### Why this is safe

- The MCP `2025-11-25` spec is explicitly backward compatible with `2025-06-18` ([announcement](https://workos.com/blog/mcp-2025-11-25-spec-update), [spec](https://modelcontextprotocol.io/specification/2025-11-25))
- The patch only extends an allowlist — no logic changes
- The SDK's existing HTTP transport, tool fetching, and auth flows work identically with `2025-11-25` servers

### When to remove this patch

Remove this patch when **either** of these happens:

1. **`@ai-sdk/mcp` releases a version that natively supports `2025-11-25`** — check by running:
   ```bash
   grep "2025-11-25" node_modules/@ai-sdk/mcp/dist/index.mjs
   ```
   If it shows up without the patch, delete the patch file and remove the `patchedDependencies` entry from `package.json`.

2. **We upgrade `@ai-sdk/mcp` to a version where the patch no longer applies cleanly** — bun will warn during `bun install`. At that point, check if the new version already supports `2025-11-25`. If yes, delete the patch. If no, regenerate the patch against the new version.

### How to regenerate if needed

```bash
bun patch @ai-sdk/mcp
# Edit node_modules/@ai-sdk/mcp/dist/index.mjs and index.js:
#   - Change LATEST_PROTOCOL_VERSION to "2025-11-25"
#   - Add "2025-06-18" to SUPPORTED_PROTOCOL_VERSIONS array
bun patch --commit 'node_modules/@ai-sdk/mcp'
```

### Verification

After applying, confirm the PSD Data connector works:
1. `bun run dev:local` (or deploy to dev)
2. Enable PSD Data connector in Nexus Chat
3. Send a message — tools should resolve without protocol version errors
4. Check logs: `docker logs <container> 2>&1 | grep -i "protocol\|connector tools resolved"`
