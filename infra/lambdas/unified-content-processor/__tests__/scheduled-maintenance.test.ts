import { runScheduledMaintenance } from "../scheduled-maintenance";
import fs from "node:fs";
import path from "node:path";

describe("scheduled unified-content maintenance", () => {
  test("continues every recovery stage and reports all failures", async () => {
    const completed: string[] = [];
    const errors: string[] = [];

    await expect(
      runScheduledMaintenance(
        [
          {
            name: "legacy-source-recovery",
            run: async () => {
              completed.push("legacy-source-recovery");
              throw new Error("S3 unavailable");
            },
          },
          {
            name: "processing-outbox",
            run: async () => {
              completed.push("processing-outbox");
            },
          },
          {
            name: "embedding-recovery",
            run: async () => {
              completed.push("embedding-recovery");
              throw new Error("SQS unavailable");
            },
          },
          {
            name: "processing-dlq-reconciliation",
            run: async () => {
              completed.push("processing-dlq-reconciliation");
            },
          },
          {
            name: "embedding-dlq-reconciliation",
            run: async () => {
              completed.push("embedding-dlq-reconciliation");
            },
          },
        ],
        (name) => errors.push(name)
      )
    ).rejects.toThrow("2 unified-content maintenance stage(s) failed");

    expect(completed).toEqual([
      "legacy-source-recovery",
      "processing-outbox",
      "embedding-recovery",
      "processing-dlq-reconciliation",
      "embedding-dlq-reconciliation",
    ]);
    expect(errors).toEqual([
      "legacy-source-recovery",
      "embedding-recovery",
    ]);
  });

  test("registers generation retention last and isolates its failure", async () => {
    const runtimeSource = fs.readFileSync(
      path.join(__dirname, "../index.ts"),
      "utf8",
    );
    const priorTask = runtimeSource.indexOf(
      'name: "embedding-dlq-reconciliation"',
    );
    const retentionTask = runtimeSource.indexOf(
      'name: "superseded-generation-retention"',
    );
    expect(priorTask).toBeGreaterThanOrEqual(0);
    expect(retentionTask).toBeGreaterThan(priorTask);

    const completed: string[] = [];
    const errors: string[] = [];
    await expect(
      runScheduledMaintenance(
        [
          {
            name: "embedding-dlq-reconciliation",
            run: async () => {
              completed.push("embedding-dlq-reconciliation");
            },
          },
          {
            name: "superseded-generation-retention",
            run: async () => {
              completed.push("superseded-generation-retention");
              throw new Error("database unavailable");
            },
          },
        ],
        (name) => errors.push(name),
      ),
    ).rejects.toThrow("1 unified-content maintenance stage(s) failed");

    expect(completed).toEqual([
      "embedding-dlq-reconciliation",
      "superseded-generation-retention",
    ]);
    expect(errors).toEqual(["superseded-generation-retention"]);
  });

  test("registers the orphaned-item sweep", () => {
    const runtimeSource = fs.readFileSync(
      path.join(__dirname, "../index.ts"),
      "utf8",
    );

    expect(runtimeSource).toContain('name: "orphaned-item-sweep"');
    expect(runtimeSource).toContain("await failOrphanedRepositoryItems()");
  });
});
