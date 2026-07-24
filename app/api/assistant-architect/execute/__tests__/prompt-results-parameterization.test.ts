/**
 * REV-DB-023 / REV-SEC-105 / REV-COR-210: the `prompt_results` inserts in the
 * interactive execute route previously embedded user-influenced JSON (`input_data`,
 * which contains `processedContent` after user-input variable substitution) and the
 * `execution_status` enum into SQL via `sql.raw()` with hand-rolled
 * single-quote-only escaping — a fragile, GUC-dependent, injection-adjacent pattern.
 * The fix binds every value as a parameter (`${json}::jsonb`,
 * `${status}::execution_status`), matching the sibling `tool_executions` inserts.
 *
 * (The scheduled execute route that shared this pattern was removed in #1322.)
 *
 * These tests need no live database:
 *  1. Behavioral proof — the fixed binding pattern parameterizes adversarial input
 *     (the payload becomes a bound `$N` parameter; the raw SQL never contains it).
 *  2. Regression guard — the route file may not reintroduce a real `sql.raw(...)`
 *     call for these inserts (the Done-when "grep returns zero matches").
 */

import { readFileSync } from "fs"
import { join } from "path"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"

const dialect = new PgDialect()

const ROUTE_FILES = {
  interactive: join(__dirname, "..", "route.ts"),
}

describe("prompt_results insert parameterization (REV-DB-023 / REV-SEC-105 / REV-COR-210)", () => {
  it("binds adversarial input_data as a parameter (never inlined into raw SQL)", () => {
    // A prompt whose substituted content carries every escaping hazard.
    const processedContent = "O'Brien \\ '); DROP TABLE prompt_results;-- </script>"
    const inputDataJson = JSON.stringify({ processedContent, __proto__marker: "x" })

    // Mirror the fixed insert's value binding exactly.
    const query = dialect.sqlToQuery(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status)
      VALUES (${1}, ${2}, ${inputDataJson}::jsonb, ${"ok"}, ${"completed"}::execution_status)
    `)

    // The JSON and the enum are bound parameters, not string-interpolated literals.
    expect(query.params).toContain(inputDataJson)
    expect(query.params).toContain("completed")

    // The raw SQL uses placeholders + casts and contains none of the adversarial text.
    expect(query.sql).toMatch(/\$\d+::jsonb/)
    expect(query.sql).toMatch(/\$\d+::execution_status/)
    expect(query.sql).not.toContain("DROP TABLE")
    expect(query.sql).not.toContain("O'Brien")
    expect(query.sql).not.toContain("</script>")
  })

  it("binds the failed-path status as a parameter cast to the enum", () => {
    const failedInputJson = JSON.stringify({ prompt: "content with ' quote and \\ backslash" })
    const query = dialect.sqlToQuery(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status)
      VALUES (${1}, ${2}, ${failedInputJson}::jsonb, ${""}, ${"failed"}::execution_status)
    `)

    expect(query.params).toContain(failedInputJson)
    expect(query.params).toContain("failed")
    expect(query.sql).not.toContain("DROP")
    expect(query.sql).not.toContain("backslash")
  })

  it.each(Object.entries(ROUTE_FILES))(
    "leaves no real sql.raw(...) call for prompt_results inserts in %s route",
    (_name, file) => {
      const src = readFileSync(file, "utf8")
      // A *call* embeds a string/template literal: `sql.raw(` immediately followed
      // by a quote or backtick. Comment mentions use empty `sql.raw()` and are ignored.
      const realCall = /sql\.raw\(\s*[`'"]/
      expect(src).not.toMatch(realCall)
    }
  )

  it.each(Object.entries(ROUTE_FILES))(
    "uses bound ::jsonb / ::execution_status casts in %s route",
    (_name, file) => {
      const src = readFileSync(file, "utf8")
      expect(src).toContain("::jsonb")
      expect(src).toContain("::execution_status")
    }
  )
})
