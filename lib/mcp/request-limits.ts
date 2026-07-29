// This is a transport ceiling shared by every MCP tool, not the Assistant
// Architect envelope limit. Existing content tools legitimately carry
// multi-file OKF bundles above 10 MiB; assistant handlers independently enforce
// ASSISTANT_IMPORT_MAX_BYTES after JSON-RPC dispatch.
export const MCP_REQUEST_MAX_BYTES = 64 * 1024 * 1024
