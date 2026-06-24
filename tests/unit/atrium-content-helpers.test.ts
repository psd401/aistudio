/**
 * Unit tests for Atrium content pure helpers + render sanitizer (Issue #1058).
 *
 * Covers the side-effect-free logic the service layer relies on: slug
 * generation, principal extraction, scope/edit/publish authorization checks
 * (§26.3 / §26.4), and the markdown render sanitizer (§31.1 — asserts
 * <script> and event handlers are stripped). No database required.
 */

// `marked` ships ESM-only and is excluded from Jest's transform; mock it so the
// renderer's parse step runs in the jsdom environment. The mock mimics the
// behaviors these tests assert: heading + emphasis conversion, and pass-through
// of raw embedded HTML (which the sanitizer must then strip). sanitizeHtml — the
// security-critical function — is tested against real HTML input, not the mock.
jest.mock("marked", () => ({
  marked: {
    parse: (md: string) => {
      if (md === "") return "";
      return md
        .replace(/^# (.+)$/gm, "<h1>$1</h1>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    },
  },
}));

import {
  actorKindOf,
  agentIdOf,
  assertCanCreate,
  authorUserIdOf,
  canEdit,
  canPublishPublic,
  principalOf,
  scopesOf,
  slugCandidate,
  slugifyTitle,
} from "@/lib/content/helpers";
import { ForbiddenError } from "@/lib/content/errors";
import { renderMarkdownToHtml, sanitizeHtml } from "@/lib/content/render/markdown-render";
import type { Requester } from "@/lib/content/types";

const userReq: Requester = {
  kind: "user",
  userId: 42,
  roles: ["staff"],
  building: "High School",
  department: "Math",
  gradeLevels: ["9", "10"],
  isAdmin: false,
};
const adminReq: Requester = { ...userReq, userId: 1, isAdmin: true };
const delegatedReq: Requester = {
  kind: "agent-delegated",
  actingForUserId: 42,
  roles: ["staff"],
  building: "High School",
  scopes: ["content:create", "content:update"],
  agentLabel: "my-agent",
};
const autonomousReq: Requester = {
  kind: "agent-autonomous",
  agentId: "11111111-1111-1111-1111-111111111111",
  roleId: 2,
  roles: ["staff"],
  scopes: ["content:create", "content:publish_internal"],
  agentLabel: "ship-reporter",
};

describe("slugifyTitle", () => {
  it("lowercases, hyphenates, and trims punctuation", () => {
    expect(slugifyTitle("Board Procedure 4040!")).toBe("board-procedure-4040");
  });
  it("collapses runs of separators", () => {
    expect(slugifyTitle("a   --  b")).toBe("a-b");
  });
  it("strips leading/trailing hyphens", () => {
    expect(slugifyTitle("  -Hello-  ")).toBe("hello");
  });
  it("strips accents", () => {
    expect(slugifyTitle("Café Crème")).toBe("cafe-creme");
  });
  it("falls back to 'untitled' for empty-after-strip input", () => {
    expect(slugifyTitle("!!!")).toBe("untitled");
    expect(slugifyTitle("")).toBe("untitled");
  });
  it("caps length at 200 characters", () => {
    expect(slugifyTitle("a".repeat(300)).length).toBeLessThanOrEqual(200);
  });
});

describe("slugCandidate", () => {
  it("returns the base for attempt 0", () => {
    expect(slugCandidate("hello", 0)).toBe("hello");
  });
  it("appends -n for later attempts", () => {
    expect(slugCandidate("hello", 3)).toBe("hello-3");
  });
  it("keeps the suffixed candidate within 200 chars", () => {
    const base = "a".repeat(200);
    const candidate = slugCandidate(base, 12);
    expect(candidate.length).toBeLessThanOrEqual(200);
    expect(candidate.endsWith("-12")).toBe(true);
  });
});

describe("actor / author / scope resolution", () => {
  it("maps requester kind to actor kind", () => {
    expect(actorKindOf(userReq)).toBe("human");
    expect(actorKindOf(delegatedReq)).toBe("agent");
    expect(actorKindOf(autonomousReq)).toBe("agent");
  });
  it("resolves the agent id only for autonomous agents", () => {
    expect(agentIdOf(userReq)).toBeNull();
    expect(agentIdOf(delegatedReq)).toBeNull();
    expect(agentIdOf(autonomousReq)).toBe(autonomousReq.kind === "agent-autonomous" ? autonomousReq.agentId : null);
  });
  it("resolves the author user id (delegated -> human, autonomous -> null)", () => {
    expect(authorUserIdOf(userReq)).toBe(42);
    expect(authorUserIdOf(delegatedReq)).toBe(42);
    expect(authorUserIdOf(autonomousReq)).toBeNull();
  });
  it("users hold no scopes (capability-gated at the surface)", () => {
    expect(scopesOf(userReq)).toEqual([]);
    expect(scopesOf(autonomousReq)).toContain("content:create");
  });
});

describe("principalOf", () => {
  it("carries full attributes for a user", () => {
    expect(principalOf(userReq)).toEqual({
      userId: 42,
      roles: ["staff"],
      building: "High School",
      department: "Math",
      gradeLevels: ["9", "10"],
      isAdmin: false,
    });
  });
  it("never infers admin for a delegated agent", () => {
    expect(principalOf(delegatedReq).isAdmin).toBe(false);
    expect(principalOf(delegatedReq).userId).toBe(42);
  });
  it("gives an autonomous agent no user id and no org attributes", () => {
    const p = principalOf(autonomousReq);
    expect(p.userId).toBeUndefined();
    expect(p.building).toBeNull();
    expect(p.roles).toEqual(["staff"]);
  });
});

describe("assertCanCreate (§26.3)", () => {
  it("allows any user (capability-gated at the surface)", () => {
    expect(() => assertCanCreate(userReq)).not.toThrow();
  });
  it("allows agents holding content:create", () => {
    expect(() => assertCanCreate(delegatedReq)).not.toThrow();
    expect(() => assertCanCreate(autonomousReq)).not.toThrow();
  });
  it("rejects an agent without content:create", () => {
    const noScope: Requester = { ...autonomousReq, scopes: [] };
    expect(() => assertCanCreate(noScope)).toThrow(ForbiddenError);
  });
});

describe("canEdit", () => {
  it("lets the owner user edit", () => {
    expect(canEdit(userReq, 42)).toBe(true);
  });
  it("blocks a non-owner non-admin user", () => {
    expect(canEdit(userReq, 99)).toBe(false);
  });
  it("lets an admin edit anything", () => {
    expect(canEdit(adminReq, 99)).toBe(true);
  });
  it("requires content:update for a delegated agent editing its owner's content", () => {
    expect(canEdit(delegatedReq, 42)).toBe(true);
    const noUpdate: Requester = { ...delegatedReq, scopes: ["content:create"] };
    expect(canEdit(noUpdate, 42)).toBe(false);
  });
  it("blocks an autonomous agent from editing content it does not own", () => {
    expect(canEdit(autonomousReq, 42)).toBe(false);
  });

  describe("autonomous agent ownership via ATRIUM_SYSTEM_USER_ID", () => {
    const prev = process.env.ATRIUM_SYSTEM_USER_ID;
    afterEach(() => {
      if (prev === undefined) delete process.env.ATRIUM_SYSTEM_USER_ID;
      else process.env.ATRIUM_SYSTEM_USER_ID = prev;
    });

    it("lets an autonomous agent edit content owned by the system user when it holds content:update", () => {
      process.env.ATRIUM_SYSTEM_USER_ID = "9";
      const withUpdate: Requester = {
        ...autonomousReq,
        scopes: ["content:create", "content:update"],
      };
      expect(canEdit(withUpdate, 9)).toBe(true); // owns via system user
      expect(canEdit(withUpdate, 42)).toBe(false); // not the system user's content
      expect(canEdit(autonomousReq, 9)).toBe(false); // lacks content:update
    });

    it("denies (does not throw) when ATRIUM_SYSTEM_USER_ID is unset", () => {
      delete process.env.ATRIUM_SYSTEM_USER_ID;
      const withUpdate: Requester = {
        ...autonomousReq,
        scopes: ["content:update"],
      };
      expect(canEdit(withUpdate, 9)).toBe(false);
    });
  });
});

describe("canPublishPublic (§26.4)", () => {
  it("allows an admin user", () => {
    expect(canPublishPublic(adminReq, false)).toBe(true);
  });
  it("allows a user with the publish_public capability", () => {
    expect(canPublishPublic(userReq, true)).toBe(true);
    expect(canPublishPublic(userReq, false)).toBe(false);
  });
  it("allows a delegated agent only if the human granted the scope", () => {
    const granted: Requester = {
      ...delegatedReq,
      scopes: ["content:publish_public"],
    };
    expect(canPublishPublic(granted, false)).toBe(true);
    expect(canPublishPublic(delegatedReq, false)).toBe(false);
  });
  it("never allows an autonomous agent", () => {
    const withScope: Requester = {
      ...autonomousReq,
      scopes: ["content:publish_public"],
    };
    expect(canPublishPublic(withScope, true)).toBe(false);
  });
});

describe("sanitizeHtml (§31.1)", () => {
  it("strips <script> elements and their content", () => {
    expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
  });
  it("strips <style>, <iframe>, <object>, <embed>", () => {
    const out = sanitizeHtml(
      "<style>x{}</style><iframe src=//e></iframe><object></object><embed>"
    );
    expect(out).not.toMatch(/<(style|iframe|object|embed)/i);
  });
  it("strips inline event-handler attributes", () => {
    const out = sanitizeHtml('<a href="#" onclick="steal()">x</a>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain("href");
  });
  it("neutralizes javascript: URLs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:alert/i);
  });
  it("neutralizes data: URLs in src", () => {
    const out = sanitizeHtml('<img src="data:text/html,evil">');
    expect(out).not.toMatch(/src\s*=\s*["']?data:text\/html/i);
  });
  it("strips an event handler packed against the previous attribute (no space)", () => {
    // Regression: `<img src='x'onerror=...>` has no whitespace before onerror.
    const out = sanitizeHtml("<img src='x'onerror='steal()'>");
    expect(out).not.toMatch(/onerror/i);
  });
  it("neutralizes a data: URI whose value contains '>' characters", () => {
    // Regression: a '>' inside the quoted value used to terminate the match early.
    const out = sanitizeHtml('<img src="data:text/html,<h1>x</h1>">');
    expect(out).not.toMatch(/src\s*=\s*"data:text\/html/i);
  });
  it("neutralizes javascript: in a single-quoted href", () => {
    const out = sanitizeHtml("<a href='javascript:alert(1)'>x</a>");
    expect(out).not.toMatch(/javascript:alert/i);
  });
  it("leaves benign markup intact", () => {
    expect(sanitizeHtml("<h1>Title</h1><p><strong>bold</strong></p>")).toBe(
      "<h1>Title</h1><p><strong>bold</strong></p>"
    );
  });
});

describe("renderMarkdownToHtml", () => {
  it("renders markdown to sanitized HTML", () => {
    const html = renderMarkdownToHtml("# Hello\n\n**bold**");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });
  it("strips embedded script even when authored in markdown", () => {
    const html = renderMarkdownToHtml("text\n\n<script>evil()</script>");
    expect(html).not.toMatch(/<script/i);
  });
  it("handles empty input", () => {
    expect(renderMarkdownToHtml("")).toBe("");
  });
});
