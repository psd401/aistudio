import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Regression guard for the roster student search's LIKE-pattern escaping.
 *
 * `searchActiveRosterStudents` escapes `\`, `%`, and `_` in user-supplied search
 * text so they match literally. Postgres's default LIKE escape character is
 * already backslash, so that escaping works only when NO explicit `ESCAPE`
 * clause is present.
 *
 * The trap this pins: written inside a template literal, an `ESCAPE` clause
 * followed by a single-backslash string does not survive to Postgres. The
 * backslash is consumed escaping the closing quote, so the SQL actually sent is
 * `ESCAPE ''` — which per the Postgres docs selects NO escape character. The
 * backslashes the helper inserts then become literal characters the pattern has
 * to match, and a search for `first_last` returns no rows at all. Verified
 * against PostgreSQL 16: `'first_last@x.edu' LIKE '%first\_last%' ESCAPE ''` is
 * false, while the same pattern with no ESCAPE clause is true.
 */
describe("roster student search — LIKE pattern escaping", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../lib/rooms/queries.ts"),
    "utf8"
  );

  it("sends no ESCAPE clause, relying on Postgres's backslash default", () => {
    // The cooked form the broken clause produces must never reach the SQL.
    expect(source).not.toContain("ESCAPE ''");
    // Guard the source form too, so the bug cannot be reintroduced verbatim.
    expect(source).not.toMatch(/LIKE \$\{pattern\} ESCAPE/);
    expect(source).toContain("lower(u.email) LIKE ${pattern}");
    expect(source).toContain(") LIKE ${pattern}");
  });

  it("still escapes LIKE metacharacters in user-supplied search text", () => {
    expect(source).toContain('return value.replace(/[\\\\%_]/g, "\\\\$&");');
    expect(source).toContain(
      "const pattern = `%${escapeLikePattern(normalized)}%`;"
    );
  });
});
