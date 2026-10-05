import { describe, expect, it } from "bun:test";
import { runPostSyncStaffProvisioning } from "./user-provisioning";

const quietLog = { info: () => {}, error: () => {} };

describe("post-sync staff provisioning policy", () => {
  it("runs after any fully successful sync and skips a partial one", async () => {
    let calls = 0;
    const provision = async () => {
      calls += 1;
      return { provisioned: 3 };
    };

    expect(
      await runPostSyncStaffProvisioning(true, { provision, log: quietLog })
    ).toEqual({ provisioned: 3 });
    expect(
      await runPostSyncStaffProvisioning(false, { provision, log: quietLog })
    ).toBeNull();
    expect(calls).toBe(1);
  });

  it("contains a provisioning failure without failing a successful roster sync", async () => {
    const errors: Array<Record<string, unknown> | undefined> = [];
    const result = await runPostSyncStaffProvisioning(true, {
      provision: async () => {
        throw new Error("staff role missing");
      },
      log: {
        info: () => {},
        error: (_message, metadata) => errors.push(metadata),
      },
    });

    expect(result).toBeNull();
    expect(errors).toEqual([{ error: "staff role missing" }]);
  });
});
