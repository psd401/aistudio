/**
 * The three operations opened on 2026-08-28, and — more importantly — where
 * each one stops.
 *
 * All three were refused with `operation_not_allowed` during the week of
 * 2026-08-21 with no way around it:
 *   - `gmail users settings filters`  (12909, 13866, 14559) — three users
 *     asking for skip-inbox rules, or for existing rules to be removed.
 *   - `chat spaces findDirectMessage` (14394) — a scheduled digest with no way
 *     to resolve the DM it was meant to deliver into.
 *   - `tasks tasks move`              (14031) — four heading tasks inserted on
 *     the user slot that then could not be arranged.
 *
 * Widening an allowlist is the easiest place in this file to give away more
 * than intended, so every test here has a matching boundary test.
 */

import {
  requiredWorkspaceScopeGap,
  validateWorkspaceCommand,
} from "@/lib/agent-workspace/command-executor";

const OWNER = "owner@psd401.net";
const GMAIL_SETTINGS_BASIC =
  "https://www.googleapis.com/auth/gmail.settings.basic";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

function check(argv: string[], scope: "agent" | "user"): void {
  validateWorkspaceCommand({ argv, scope }, OWNER);
}

describe("gmail users settings filters", () => {
  it.each([["list"], ["get"], ["create"], ["delete"]])(
    "allows filters.%s on the user's own mailbox",
    (action) => {
      expect(() =>
        check(["gmail", "users", "settings", "filters", action], "user")
      ).not.toThrow();
    }
  );

  it("covers the whole resource because the operation truncates at four tokens", () => {
    // Not a hidden assumption — the reason one entry grants create AND delete.
    // `operationTokens` caps at four positionals, so the fifth (the real
    // action) never reaches the operation string. Recorded here so a future
    // reader does not try to narrow the entry by action and quietly fail.
    expect(() =>
      check(
        ["gmail", "users", "settings", "filters", "totally-made-up"],
        "user"
      )
    ).not.toThrow();
  });

  it("does NOT reach the sibling settings resources", () => {
    // These are the dangerous half of Gmail settings: standing configuration
    // that redirects a mailbox or lets another account act as this user. Each
    // occupies the FOURTH token itself, so none collides with `filters` — but
    // that is a property worth pinning rather than assuming.
    for (const resource of [
      "forwardingaddresses",
      "sendas",
      "delegates",
      "updatevacation",
      "updateimap",
    ]) {
      expect(() =>
        check(["gmail", "users", "settings", resource, "create"], "user")
      ).toThrow(/not allowed/i);
    }
  });

  it("asks for a re-consent instead of letting Google 403 an old token", () => {
    // `gmail.modify` does not imply `gmail.settings.basic`. Without this gap
    // the widening would only change WHICH layer refused the call.
    expect(
      requiredWorkspaceScopeGap(
        ["gmail", "users", "settings", "filters", "list"],
        GMAIL_MODIFY
      )
    ).toEqual({
      scopes: [GMAIL_SETTINGS_BASIC],
      capability: "manage the filters in your Gmail inbox",
    });
  });

  it("reports no gap once the user has re-consented", () => {
    expect(
      requiredWorkspaceScopeGap(
        ["gmail", "users", "settings", "filters", "list"],
        `${GMAIL_MODIFY} ${GMAIL_SETTINGS_BASIC}`
      )
    ).toBeNull();
  });

  it("still refuses to send mail", () => {
    // The filters grant must not be read as a general loosening of Gmail.
    for (const argv of [
      ["gmail", "users", "messages", "send"],
      ["gmail", "+send", "--to", "a@psd401.net"],
    ]) {
      expect(() => check(argv, "user")).toThrow();
    }
  });
});

describe("chat spaces findDirectMessage", () => {
  it("is allowed on the agent slot", () => {
    expect(() =>
      check(
        ["chat", "spaces", "findDirectMessage", "--params", '{"name":"users/1"}'],
        "agent"
      )
    ).not.toThrow();
  });

  it("is classified as a READ, so it never claims to be an outbound send", () => {
    // Treated as a read rather than added to ALLOWED_WRITES on purpose:
    // ALLOWED_CHAT_WRITES is derived from ALLOWED_WRITES by the `chat ` prefix
    // because every Chat WRITE has to reach the outbound audit log. A lookup
    // that sends nothing would land there as a row with a null space and null
    // body. Being a read is also why it needs no agent-slot confinement.
    expect(() =>
      check(
        ["chat", "spaces", "findDirectMessage", "--params", '{"name":"users/1"}'],
        "user"
      )
    ).not.toThrow();
  });

  it("cannot smuggle a mutation in front of the lookup", () => {
    // The read branch screens earlier MUTATING verbs and every `+` helper, so
    // a trailing read action cannot be used to carry one past the write
    // allowlist. Without that, "read" would be a hole rather than a
    // classification.
    expect(() =>
      check(["chat", "spaces", "create", "findDirectMessage"], "agent")
    ).toThrow(/mutation/i);
    expect(() =>
      check(["chat", "+send", "findDirectMessage"], "agent")
    ).toThrow(/helper verb/i);
  });

  it("does not open the rest of Chat", () => {
    for (const argv of [
      ["chat", "spaces", "delete"],
      ["chat", "spaces", "members", "delete"],
    ]) {
      expect(() => check(argv, "agent")).toThrow();
    }
  });
});

describe("tasks tasks move", () => {
  it("is allowed on the user slot, like the insert it reorders", () => {
    // Deliberately NOT agent-only, unlike `tasks tasks patch`/`update`: a move
    // changes position and parent, never content, and the user slot already
    // permits creating the task being moved. The reported case (14031) was a
    // user-slot insert followed by a user-slot move.
    //
    // The inconsistency with patch/update was raised and this placement was
    // confirmed deliberately (2026-08-28), so moving `tasks tasks move` into
    // AGENT_ONLY_WRITES is a reversal of a settled decision, not a cleanup.
    expect(() =>
      check(
        [
          "tasks", "tasks", "move",
          "--params", '{"tasklist":"@default","task":"t1","parent":"h1"}',
        ],
        "user"
      )
    ).not.toThrow();
  });

  it("is allowed on the agent slot too", () => {
    expect(() =>
      check(["tasks", "tasks", "move", "--params", '{"task":"t1"}'], "agent")
    ).not.toThrow();
  });

  it("does not make tasks destructible", () => {
    // Phase 1's "never destructive" rule is unaffected by reordering.
    for (const argv of [
      ["tasks", "tasks", "delete"],
      ["tasks", "tasklists", "delete"],
    ]) {
      expect(() => check(argv, "user")).toThrow();
    }
  });
});
