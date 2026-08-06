export const MAX_NEXUS_MEMORY_CONTENT_CHARS = 8_000
export const MAX_BULK_MEMORY_DELETE_COUNT = 100
export const NEXUS_MEMORY_SETTINGS_PAGE_SIZE = 50
export const MAX_MEMORY_IMPORT_CHARS = 200_000
export const MAX_MEMORY_IMPORT_CANDIDATES = 100
export const MAX_MEMORY_IMPORT_SAVE_BATCH_CANDIDATES = 5

/**
 * Shown on an import candidate the server rejected for a reason that is not
 * safe to describe (provider, database, network). Shared so the server's
 * wording and the dialog's fallback cannot drift apart.
 */
export const GENERIC_MEMORY_IMPORT_FAILURE_REASON =
  "This memory could not be saved. Try again in a moment."
