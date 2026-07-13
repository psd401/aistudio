/**
 * Unit tests for the group-sync reconciliation core (Epic #1202, Phase 0 / #1203).
 *
 * Runner: bun test (the Lambda is an isolated ESM/CJS bundle, not part of the app
 * jest suite). Run: `cd infra/lambdas/group-sync && bun test`.
 *
 * Covers the acceptance-criteria invariants that must never regress:
 *   - hand-picked AND prefix-matched selection (both modes)
 *   - transitive flattening of nested groups
 *   - a simulated per-group API failure leaves that group's membership intact
 *   - emails stored lowercase; mixed-case input matches / de-dupes
 */

import { test, expect, describe } from "bun:test";
import {
  dedupeNormalizedEmails,
  resolveSelectedGroups,
  flattenTransitiveMembers,
  runGroupSync,
  type GroupSyncPorts,
  type RawMember,
  type SelectionRule,
  type DirectoryGroup,
} from "./sync";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("dedupeNormalizedEmails", () => {
  test("lowercases, trims, de-dupes, and drops empties", () => {
    const out = dedupeNormalizedEmails([
      "Alice@PSD401.net",
      "  bob@psd401.net  ",
      "ALICE@psd401.net",
      "",
      null,
      undefined,
      "carol@psd401.net",
    ]);
    expect(out).toEqual(["alice@psd401.net", "bob@psd401.net", "carol@psd401.net"]);
  });
});

describe("resolveSelectedGroups", () => {
  const directory: DirectoryGroup[] = [
    { email: "Staff-All@psd401.net", name: "All Staff" },
    { email: "staff-hs@psd401.net", name: "HS Staff" },
    { email: "board@psd401.net", name: "Board" },
    { email: "random@psd401.net", name: "Random" },
  ];

  test("selects hand-picked groups (source manual), case-insensitively", () => {
    const rules: SelectionRule[] = [{ ruleType: "pick", value: "BOARD@psd401.net", isActive: true }];
    const selected = resolveSelectedGroups(rules, directory);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual({ email: "board@psd401.net", name: "Board", source: "manual" });
  });

  test("selects prefix-matched groups (source prefix)", () => {
    const rules: SelectionRule[] = [{ ruleType: "prefix", value: "staff-", isActive: true }];
    const selected = resolveSelectedGroups(rules, directory).sort((a, b) => a.email.localeCompare(b.email));
    expect(selected.map((s) => s.email)).toEqual(["staff-all@psd401.net", "staff-hs@psd401.net"]);
    expect(selected.every((s) => s.source === "prefix")).toBe(true);
  });

  test("both modes apply simultaneously; a pick wins over a prefix on a tie", () => {
    const rules: SelectionRule[] = [
      { ruleType: "prefix", value: "staff-", isActive: true },
      { ruleType: "pick", value: "staff-hs@psd401.net", isActive: true }, // also matches the prefix
      { ruleType: "pick", value: "board@psd401.net", isActive: true },
    ];
    const selected = resolveSelectedGroups(rules, directory);
    const byEmail = new Map(selected.map((s) => [s.email, s]));
    expect(byEmail.get("staff-hs@psd401.net")?.source).toBe("manual"); // pick wins the tie
    expect(byEmail.get("staff-all@psd401.net")?.source).toBe("prefix");
    expect(byEmail.get("board@psd401.net")?.source).toBe("manual");
    expect(byEmail.has("random@psd401.net")).toBe(false);
  });

  test("a pick is selected even when absent from the directory listing", () => {
    const rules: SelectionRule[] = [{ ruleType: "pick", value: "ghost@psd401.net", isActive: true }];
    const selected = resolveSelectedGroups(rules, directory);
    expect(selected).toEqual([{ email: "ghost@psd401.net", name: null, source: "manual" }]);
  });

  test("ignores inactive rules and empty prefixes", () => {
    const rules: SelectionRule[] = [
      { ruleType: "pick", value: "board@psd401.net", isActive: false },
      { ruleType: "prefix", value: "   ", isActive: true },
    ];
    expect(resolveSelectedGroups(rules, directory)).toEqual([]);
  });
});

describe("flattenTransitiveMembers", () => {
  test("expands nested groups into person emails and de-dupes", async () => {
    // parent -> [alice, nested]; nested -> [bob, ALICE (dupe)]
    const graph: Record<string, RawMember[]> = {
      "parent@psd401.net": [
        { email: "alice@psd401.net" },
        { email: null, nestedGroupEmail: "nested@psd401.net" },
      ],
      "nested@psd401.net": [
        { email: "bob@psd401.net" },
        { email: "Alice@psd401.net" },
      ],
    };
    const members = await flattenTransitiveMembers(
      "parent@psd401.net",
      async (g) => graph[g.toLowerCase()] ?? []
    );
    expect(members.sort()).toEqual(["alice@psd401.net", "bob@psd401.net"]);
  });

  test("guards against membership cycles", async () => {
    const graph: Record<string, RawMember[]> = {
      "a@psd401.net": [{ email: null, nestedGroupEmail: "b@psd401.net" }, { email: "u1@psd401.net" }],
      "b@psd401.net": [{ email: null, nestedGroupEmail: "a@psd401.net" }, { email: "u2@psd401.net" }],
    };
    const members = await flattenTransitiveMembers(
      "a@psd401.net",
      async (g) => graph[g.toLowerCase()] ?? []
    );
    expect(members.sort()).toEqual(["u1@psd401.net", "u2@psd401.net"]);
  });
});

/** Build a ports double whose calls are recorded, over an in-memory group store. */
function makePorts(overrides: Partial<GroupSyncPorts> = {}) {
  const calls = {
    replaceMembers: [] as { groupId: string; members: string[] }[],
    markSynced: [] as string[],
    markError: [] as { groupId: string; message: string }[],
    deactivatedWith: [] as string[][],
  };
  const idByEmail = new Map<string, string>();
  const base: GroupSyncPorts = {
    listActiveRules: async () => [],
    listDirectoryGroups: async () => [],
    fetchTransitiveMembers: async () => [],
    upsertGroup: async ({ groupEmail }) => {
      const id = idByEmail.get(groupEmail) ?? `id-${groupEmail}`;
      idByEmail.set(groupEmail, id);
      return id;
    },
    replaceMembers: async (groupId, members) => {
      calls.replaceMembers.push({ groupId, members });
    },
    markSynced: async (groupId) => {
      calls.markSynced.push(groupId);
    },
    markError: async (groupId, message) => {
      calls.markError.push({ groupId, message });
    },
    deactivateGroupsNotIn: async (emails) => {
      calls.deactivatedWith.push(emails);
      return 0;
    },
    log: silentLog,
    ...overrides,
  };
  return { ports: base, calls };
}

describe("runGroupSync fail-safety", () => {
  test("a group whose fetch throws keeps its membership (replaceMembers NOT called), others still sync", async () => {
    const directory: DirectoryGroup[] = [
      { email: "good@psd401.net", name: "Good" },
      { email: "bad@psd401.net", name: "Bad" },
    ];
    const { ports, calls } = makePorts({
      listActiveRules: async () => [
        { ruleType: "pick", value: "good@psd401.net", isActive: true },
        { ruleType: "pick", value: "bad@psd401.net", isActive: true },
      ],
      listDirectoryGroups: async () => directory,
      fetchTransitiveMembers: async (email) => {
        if (email === "bad@psd401.net") throw new Error("Google 503 for bad group");
        return ["member1@psd401.net", "Member1@psd401.net"]; // dupe collapses
      },
    });

    const result = await runGroupSync(ports);

    // Good group reconciled with normalized, de-duped membership.
    expect(calls.replaceMembers).toEqual([
      { groupId: "id-good@psd401.net", members: ["member1@psd401.net"] },
    ]);
    // Bad group never had its membership touched.
    expect(calls.replaceMembers.find((c) => c.groupId === "id-bad@psd401.net")).toBeUndefined();
    expect(calls.markError).toEqual([
      { groupId: "id-bad@psd401.net", message: "Google 503 for bad group" },
    ]);
    expect(calls.markSynced).toEqual(["id-good@psd401.net"]);
    expect(result).toEqual({ selected: 2, synced: 1, failed: 1, deactivated: 0, totalMembers: 1 });
  });

  test("deactivation is called with the selected emails after a successful listing", async () => {
    const { ports, calls } = makePorts({
      listActiveRules: async () => [{ ruleType: "pick", value: "keep@psd401.net", isActive: true }],
      listDirectoryGroups: async () => [{ email: "keep@psd401.net", name: "Keep" }],
      fetchTransitiveMembers: async () => [],
    });
    await runGroupSync(ports);
    expect(calls.deactivatedWith).toEqual([["keep@psd401.net"]]);
  });

  test("an empty directory listing skips deactivation (never mass-revoke) but still syncs picks", async () => {
    let deactivateCalled = false;
    const { ports, calls } = makePorts({
      listActiveRules: async () => [
        { ruleType: "prefix", value: "staff-", isActive: true },
        { ruleType: "pick", value: "keep@psd401.net", isActive: true },
      ],
      // Directory returns empty (simulated silent API glitch).
      listDirectoryGroups: async () => [],
      fetchTransitiveMembers: async () => ["u@psd401.net"],
      deactivateGroupsNotIn: async () => {
        deactivateCalled = true;
        return 5;
      },
    });
    const result = await runGroupSync(ports);
    expect(deactivateCalled).toBe(false); // empty listing → no deactivation
    // The pick is still selected and synced (picks are directory-independent).
    expect(calls.markSynced).toEqual(["id-keep@psd401.net"]);
    expect(result.selected).toBe(1);
    expect(result.deactivated).toBe(0);
  });

  test("a whole-directory listing failure aborts before any deactivation or write", async () => {
    let deactivateCalled = false;
    const { ports } = makePorts({
      listActiveRules: async () => [{ ruleType: "prefix", value: "staff-", isActive: true }],
      listDirectoryGroups: async () => {
        throw new Error("Directory API down");
      },
      deactivateGroupsNotIn: async () => {
        deactivateCalled = true;
        return 99;
      },
    });
    await expect(runGroupSync(ports)).rejects.toThrow("Directory API down");
    expect(deactivateCalled).toBe(false); // never mass-revoke on a total outage
  });
});
