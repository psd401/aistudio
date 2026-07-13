/**
 * Managed-role reconciliation core (Epic #1202, Phase 1 / #1204).
 *
 * Unit tests for the pure decision function `computeManagedRoleDiff`, which both
 * the login-time reconciler (lib/db/drizzle/user-roles.ts) and the sync Lambda's
 * bulk SQL pass implement. Covers every edge case called out in #1204:
 * a user in zero mapped groups, overlapping mappings, a manual + managed grant of
 * the same role, and the no-op case that must NOT bump role_version.
 */

import {
  computeManagedRoleDiff,
  type ExistingUserRole,
} from "@/lib/db/drizzle/user-roles";

const manual = (roleId: number): ExistingUserRole => ({ roleId, source: "manual" });
const managed = (roleId: number): ExistingUserRole => ({ roleId, source: "group-sync" });

describe("computeManagedRoleDiff", () => {
  it("grants a mapped role the user does not yet hold (add path)", () => {
    const diff = computeManagedRoleDiff([5], []);
    expect(diff).toEqual({ toAdd: [5], toRemove: [], changed: true });
  });

  it("deduplicates overlapping mappings — the same role via several groups adds once", () => {
    // computedRoleIds arriving with duplicates (a user in multiple groups all
    // mapped to role 5) must produce a single insert.
    const diff = computeManagedRoleDiff([5, 5, 5], []);
    expect(diff.toAdd).toEqual([5]);
    expect(diff.changed).toBe(true);
  });

  it("no-ops when the mapped roles already exist as group-sync (no role_version churn)", () => {
    const diff = computeManagedRoleDiff([5], [managed(5)]);
    expect(diff).toEqual({ toAdd: [], toRemove: [], changed: false });
  });

  it("removes only group-sync roles that are no longer computed", () => {
    // Mapping removed → computed is empty → the group-sync grant is revoked.
    const diff = computeManagedRoleDiff([], [managed(5)]);
    expect(diff).toEqual({ toAdd: [], toRemove: [5], changed: true });
  });

  it("never touches a manual grant when the user is in zero mapped groups", () => {
    // A hand-assigned role with no matching mapping must persist untouched.
    const diff = computeManagedRoleDiff([], [manual(2)]);
    expect(diff).toEqual({ toAdd: [], toRemove: [], changed: false });
  });

  it("leaves a manual grant of the same role as-is (manual + managed same role)", () => {
    // Role 2 is both mapped AND already held manually: not re-added (already
    // present in any source) and not removed (it is not a group-sync row).
    const diff = computeManagedRoleDiff([2], [manual(2)]);
    expect(diff).toEqual({ toAdd: [], toRemove: [], changed: false });
  });

  it("keeps the manual grant while revoking an unrelated group-sync role", () => {
    // Manual role 2 persists; group-sync role 5 (no longer computed) is removed.
    const diff = computeManagedRoleDiff([], [manual(2), managed(5)]);
    expect(diff).toEqual({ toAdd: [], toRemove: [5], changed: true });
  });

  it("does not re-add a mapped role already held manually, but still revokes a stale managed role", () => {
    // computed = {2}. Role 2 held manually (leave it), role 5 group-sync (revoke).
    const diff = computeManagedRoleDiff([2], [manual(2), managed(5)]);
    expect(diff).toEqual({ toAdd: [], toRemove: [5], changed: true });
  });

  it("handles a simultaneous add and remove in one pass", () => {
    // computed = {5,6}. Have group-sync 5 (keep), group-sync 7 (revoke),
    // manual 2 (untouched) → add 6, remove 7.
    const diff = computeManagedRoleDiff([5, 6], [managed(5), managed(7), manual(2)]);
    expect(diff).toEqual({ toAdd: [6], toRemove: [7], changed: true });
  });

  it("returns add/remove lists sorted ascending for deterministic writes", () => {
    const diff = computeManagedRoleDiff([9, 3, 6], [managed(8), managed(4)]);
    expect(diff.toAdd).toEqual([3, 6, 9]);
    expect(diff.toRemove).toEqual([4, 8]);
  });

  it("treats an empty computed set with no managed rows as a no-op", () => {
    const diff = computeManagedRoleDiff([], []);
    expect(diff).toEqual({ toAdd: [], toRemove: [], changed: false });
  });
});
