import {
  CRITICAL_SCHEMA_MIGRATIONS,
  evaluateCriticalSchema,
} from "@/lib/deployment/schema-readiness"

describe("deployment schema readiness", () => {
  it("accepts the complete repository schema", () => {
    expect(
      evaluateCriticalSchema({
        appliedMigrations: [...CRITICAL_SCHEMA_MIGRATIONS],
        cancellationConstraintDefinition:
          "CHECK (processing_status = ANY (ARRAY['pending', 'cancelled']))",
        agenticModelColumnsReady: true,
        nexusBindingColumnsReady: true,
        nexusBindingSourceConstraintReady: true,
        nexusSkillForeignKeyReady: true,
      })
    ).toEqual({
      ready: true,
      missingMigrations: [],
      cancellationConstraintReady: true,
      agenticModelColumnsReady: true,
      nexusBindingColumnsReady: true,
      nexusBindingSourceConstraintReady: true,
      nexusSkillForeignKeyReady: true,
    })
  })

  it("fails closed when a critical migration or cancelled status is absent", () => {
    const evaluation = evaluateCriticalSchema({
      appliedMigrations: CRITICAL_SCHEMA_MIGRATIONS.filter(
        (migration) => migration !== "168-repository-item-cancelled-status.sql"
      ),
      cancellationConstraintDefinition:
        "CHECK (processing_status = ANY (ARRAY['pending', 'failed']))",
      agenticModelColumnsReady: false,
      nexusBindingColumnsReady: false,
      nexusBindingSourceConstraintReady: false,
      nexusSkillForeignKeyReady: false,
    })

    expect(evaluation.ready).toBe(false)
    expect(evaluation.missingMigrations).toEqual([
      "168-repository-item-cancelled-status.sql",
    ])
    expect(evaluation.cancellationConstraintReady).toBe(false)
  })
})
