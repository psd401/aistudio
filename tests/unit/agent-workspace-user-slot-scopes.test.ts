/**
 * User-slot OAuth consent scope set (#1305).
 *
 * `SCOPES_BY_KIND.user_account` in actions/agent-workspace.actions.ts is the
 * list Google is asked for when a user clicks the consent link. It is the
 * OUTER boundary of everything the agent can ever do on the user's behalf —
 * the skill gate in infra/agent-image/skills/psd-workspace/common.js only ever
 * narrows it. Nothing else in the codebase pins this list, so a silent edit
 * would either break the Drive read/organize feature (scope dropped) or widen
 * the blast radius without review (scope added).
 *
 * These are static assertions on the source: the module is a "use server" file
 * whose import pulls in the whole auth/db stack, and the constant is not
 * exported.
 */

import fs from "node:fs";
import path from "node:path";

const actionsSource = fs.readFileSync(
  path.join(process.cwd(), "actions/agent-workspace.actions.ts"),
  "utf8"
);

/** The scope string literals inside the SCOPES_BY_KIND.user_account array. */
function userAccountScopes(): string[] {
  const start = actionsSource.indexOf("const SCOPES_BY_KIND");
  expect(start).toBeGreaterThan(-1);
  const open = actionsSource.indexOf("user_account: [", start);
  expect(open).toBeGreaterThan(-1);
  const close = actionsSource.indexOf("],", open);
  expect(close).toBeGreaterThan(open);
  // Drop whole comment LINES first — the rationale comments in this block
  // quote prose ("the way it is working right now is fine") that would
  // otherwise read as a scope literal. Anchored to the start of the line on
  // purpose: a naive /\/\/.*/ strip would also eat the `//` in every
  // `https://…` scope URL.
  const body = actionsSource
    .slice(open, close)
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => s !== "user_account");
}

const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_METADATA = "https://www.googleapis.com/auth/drive.metadata";

describe("user-slot consent scopes", () => {
  it("is exactly the approved set — no more, no less", () => {
    expect(userAccountScopes().sort()).toEqual(
      [
        "email",
        "openid",
        "profile",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/directory.readonly",
        "https://www.googleapis.com/auth/drive.file",
        DRIVE_METADATA,
        DRIVE_READONLY,
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/tasks",
      ].sort()
    );
  });

  it("grants the two Drive scopes #1305 added", () => {
    const scopes = userAccountScopes();
    expect(scopes).toContain(DRIVE_READONLY);
    expect(scopes).toContain(DRIVE_METADATA);
  });

  it("never requests full Drive — delete must stay impossible at the Google layer", () => {
    // The whole point of readonly+metadata+file is that permanent delete needs
    // `drive` (or `drive.file` on the target). Granting `drive` would make
    // deletion depend on our regex gate, which #1305 explicitly rejected.
    const scopes = userAccountScopes();
    expect(scopes).not.toContain("https://www.googleapis.com/auth/drive");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/drive.appdata");
  });

  it("never requests contacts scopes (#1239: wrong scope for the directory)", () => {
    const scopes = userAccountScopes();
    for (const scope of scopes) {
      expect(scope).not.toMatch(/\/contacts/);
    }
  });
});

describe("psd-workspace SKILL.md documents the new capability", () => {
  const skill = fs.readFileSync(
    path.join(
      process.cwd(),
      "infra/agent-image/skills/psd-workspace/SKILL.md"
    ),
    "utf8"
  );

  it("lists the new scopes in the --scope user description", () => {
    // The model reads SKILL.md, not the source. If the scopes ship without the
    // docs it will keep refusing Drive reads out of habit.
    expect(skill).toContain("drive.readonly");
    expect(skill).toContain("drive.metadata");
  });

  it("documents the folder-only create exception and the bans it sits beside", () => {
    expect(skill).toContain("application/vnd.google-apps.folder");
    expect(skill).toMatch(/trash/i);
    expect(skill).toMatch(/metadata-only/i);
  });

  it("documents the exit-15 re-consent path", () => {
    expect(skill).toContain("scope-upgrade-required");
    expect(skill).toContain("exit 15");
  });
});
