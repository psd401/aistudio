import { describe, expect, it } from "bun:test";
import { mapOneRosterRoleToApplicationRole } from "./db";
import {
  roleReconcileMetrics,
  runPostSyncRoleReconciliation,
  type PostSyncRoleReconcileInput,
} from "./role-reconciliation";

describe("fixed OneRoster role mapping", () => {
  it("maps student and staff-shaped roles without ever mapping administrator", () => {
    expect(mapOneRosterRoleToApplicationRole("student")).toBe("student");
    expect(mapOneRosterRoleToApplicationRole(" Teacher ")).toBe("staff");
    expect(mapOneRosterRoleToApplicationRole("aide")).toBe("staff");
    expect(mapOneRosterRoleToApplicationRole("proctor")).toBe("staff");
    expect(mapOneRosterRoleToApplicationRole("administrator")).toBe("staff");
    expect(mapOneRosterRoleToApplicationRole("district-administrator")).toBe(
      "staff"
    );
    expect(mapOneRosterRoleToApplicationRole("parent")).toBeNull();
    expect(mapOneRosterRoleToApplicationRole("guardian")).toBeNull();
    expect(mapOneRosterRoleToApplicationRole("relative")).toBeNull();
    expect(mapOneRosterRoleToApplicationRole("unknown")).toBeNull();
    expect(mapOneRosterRoleToApplicationRole(null)).toBeNull();
  });
});

describe("post-sync role reconciliation policy", () => {
  const eligible: PostSyncRoleReconcileInput = {
    trigger: "schedule",
    enabled: true,
    fullySuccessful: true,
  };

  it("runs only after a fully successful scheduled sync with the flag enabled", async () => {
    let calls = 0;
    const result = await runPostSyncRoleReconciliation(eligible, {
      reconcile: async () => {
        calls += 1;
        return { granted: 2, revoked: 1, usersChanged: 3 };
      },
      log: { info: () => {}, error: () => {} },
    });

    expect(calls).toBe(1);
    expect(result).toEqual({ granted: 2, revoked: 1, usersChanged: 3 });

    for (const input of [
      { ...eligible, trigger: "manual" as const },
      { ...eligible, enabled: false },
      { ...eligible, fullySuccessful: false },
    ]) {
      const skipped = await runPostSyncRoleReconciliation(input, {
        reconcile: async () => {
          calls += 1;
          return { granted: 0, revoked: 0, usersChanged: 0 };
        },
        log: { info: () => {}, error: () => {} },
      });
      expect(skipped).toBeNull();
    }
    expect(calls).toBe(1);
  });

  it("contains a role failure without failing a successful roster sync", async () => {
    const errors: Array<Record<string, unknown> | undefined> = [];
    const result = await runPostSyncRoleReconciliation(eligible, {
      reconcile: async () => {
        throw new Error("role transaction rolled back");
      },
      log: {
        info: () => {},
        error: (_message, metadata) => errors.push(metadata),
      },
    });

    expect(result).toBeNull();
    expect(errors).toEqual([
      { error: "role transaction rolled back" },
    ]);
  });

  it("publishes granted, revoked, and changed-user metric values", () => {
    expect(
      roleReconcileMetrics({
        granted: 4,
        revoked: 2,
        usersChanged: 5,
      })
    ).toEqual([
      { name: "RolesGranted", value: 4 },
      { name: "RolesRevoked", value: 2 },
      { name: "RoleUsersChanged", value: 5 },
    ]);
  });
});
