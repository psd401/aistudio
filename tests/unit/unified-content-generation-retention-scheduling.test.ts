/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const runtimeSource = fs.readFileSync(
  path.join(
    process.cwd(),
    "infra/lambdas/unified-content-processor/index.ts",
  ),
  "utf8",
);

describe("unified-content generation retention scheduling", () => {
  it("registers superseded-generation retention as the final maintenance task", () => {
    const priorTask = runtimeSource.indexOf(
      'name: "embedding-dlq-reconciliation"',
    );
    const retentionTask = runtimeSource.indexOf(
      'name: "superseded-generation-retention"',
    );
    const taskListEnd = runtimeSource.indexOf("\n      ],", retentionTask);
    const laterTask = runtimeSource.indexOf("name:", retentionTask + 1);

    expect(priorTask).toBeGreaterThanOrEqual(0);
    expect(retentionTask).toBeGreaterThan(priorTask);
    expect(taskListEnd).toBeGreaterThan(retentionTask);
    expect(laterTask === -1 || laterTask > taskListEnd).toBe(true);
  });
});
