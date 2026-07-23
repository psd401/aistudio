import { runScheduledMaintenance } from "../scheduled-maintenance";

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
});
