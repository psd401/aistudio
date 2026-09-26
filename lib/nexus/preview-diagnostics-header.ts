/**
 * The response header that tells the browser its artifact preview-failure buffer
 * was NOT consumed by the turn it just sent (#1839).
 *
 * WHY: the buffer (`lib/atrium/artifact-preview-diagnostics.ts`) is TAKEN when the
 * chat request is built, so each failure is delivered once. But an
 * image-generation or Deep Research turn returns from `routeSpecialModel` long
 * before the workspace tools and the preview-failure prompt block are built — that
 * turn looks at nothing, while the client has already emptied the buffer to send
 * it. Without this signal the next ordinary turn, the one that could actually fix
 * the artifact, has no record of the failure unless the preview happens to hit it
 * again.
 *
 * On seeing it the client calls `restoreTakenArtifactPreviewDiagnostics()`, which
 * is generation-guarded: a preview that moved on since the take (a new version, a
 * different artifact) still drops the entries rather than describing code that is
 * no longer running.
 *
 * It lives here, not in the route, because a Next.js route module may only export
 * the handler names — an extra `export const` fails typecheck against the
 * generated route types — and the client needs the same literal.
 */
export const PREVIEW_DIAGNOSTICS_UNCONSUMED_HEADER = "X-Preview-Diagnostics-Unconsumed"

/** The only value the header is ever set to. */
export const PREVIEW_DIAGNOSTICS_UNCONSUMED_VALUE = "1"
