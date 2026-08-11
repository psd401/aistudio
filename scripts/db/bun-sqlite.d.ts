/**
 * Minimal ambient declaration for the Bun-only `bun:sqlite` module.
 *
 * Only backfill-agent-message-usage.ts needs it (to read a checkpointed OpenClaw
 * transcript database), and it runs exclusively under `bun`.
 *
 * Declared narrowly here instead of adding `bun-types` to tsconfig `types`:
 * that package's triple-slash reference overrides the global `fetch`/DOM types
 * for the WHOLE tsc program and breaks unrelated DOM-typed tests. See
 * docs/learnings/build-errors/2026-06-29-bun-types-triple-slash-tsc-dom-pollution.md
 * — this file is the contained alternative that learning points to.
 *
 * Deliberately covers only the surface actually used: a read-only connection,
 * parameterless SELECTs, and close(). Widen it only alongside a real caller.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean });
    query<Row = unknown>(sql: string): { all(): Row[] };
    close(): void;
  }
}
