/**
 * Starter body for a newly created artifact.
 *
 * WHY THIS EXISTS: `contentService.create` only snapshots an initial version
 * when `input.body !== undefined` (see content-service.ts, the `if (input.body
 * !== undefined)` branch in the create transaction). Callers that created an
 * artifact with no body produced a row whose `currentVersionId` stayed null —
 * an object that appears in the library grid but has nothing to load, so the
 * authoring canvas rendered a load error instead of an editable draft.
 *
 * Seeding this body at create time means every artifact has a v1 from the
 * moment it exists. `getArtifactCodeAction` still tolerates a headless artifact
 * (legacy rows created before this change) by returning empty code rather than
 * throwing — the two fixes are independent on purpose.
 *
 * Keep this minimal: it is the first thing an author sees in the Code tab, and
 * the agent rewrites it wholesale on its first turn. It must be valid standalone
 * HTML because the sandbox renders it as a full document.
 */
export const ARTIFACT_STARTER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>New page</title>
    <style>
      body {
        margin: 0;
        padding: 48px 24px;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #1f2937;
        background: #ffffff;
      }
      main {
        max-width: 40rem;
        margin: 0 auto;
      }
      h1 {
        font-size: 1.75rem;
        margin: 0 0 0.5rem;
      }
      p {
        line-height: 1.6;
        color: #4b5563;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>New interactive page</h1>
      <p>
        Describe what you want in chat and the agent will build it here, or edit
        this HTML directly in the Code tab.
      </p>
    </main>
  </body>
</html>
`;
