/**
 * Unit tests for the shared publish-destination validators
 * (`lib/content/validators.ts`) — the consolidation of the three per-action
 * copies (publish-document / unpublish-document / approvals, Epic #1059
 * completion review).
 *
 * Both validator sets are DERIVED from the canonical `PUBLISH_DESTINATIONS`
 * list in `lib/content/publish-adapters/types.ts` (which `PublishDestination`
 * itself is derived from, so the type cannot gain a member without the list):
 *  - `PUBLISH_DESTINATION_SET` / `isPublishDestination` — the FULL service set
 *    (including `okf`), used by the §26.4 approval-replay path.
 *  - `EDITOR_PUBLISH_DESTINATION_SET` / `assertEditorDestination` — the editor
 *    surface's subset, excluding exactly `okf` (API/MCP-only by design).
 *
 * The pinned-list test below is the deliberate tripwire: adding a destination
 * to the canonical list FAILS it, forcing a conscious decision about editor
 * exposure (the editor set is exclusion-derived, so a new destination would
 * otherwise become editor-publishable silently).
 */

import {
  assertEditorDestination,
  isPublishDestination,
  EDITOR_PUBLISH_DESTINATION_SET,
  PUBLISH_DESTINATION_SET,
  type EditorPublishDestination,
} from "@/lib/content/validators";
import { PUBLISH_DESTINATIONS } from "@/lib/content/publish-adapters/types";
import { ValidationError } from "@/lib/content/errors";

describe("assertEditorDestination (publish/unpublish server actions)", () => {
  const editorDestinations: EditorPublishDestination[] = [
    "intranet",
    "public_web",
    "schoology",
    "google",
  ];

  it.each(editorDestinations)(
    "accepts editor destination %s for both surfaces",
    (destination) => {
      expect(assertEditorDestination(destination, "publish")).toBe(destination);
      expect(assertEditorDestination(destination, "unpublish")).toBe(
        destination
      );
    }
  );

  it("rejects `okf` — a valid SERVICE destination, but API/MCP-only by design", () => {
    expect(() => assertEditorDestination("okf", "publish")).toThrow(
      ValidationError
    );
    expect(() => assertEditorDestination("okf", "unpublish")).toThrow(
      ValidationError
    );
  });

  it("rejects garbage with the calling surface's original message verb", () => {
    expect(() => assertEditorDestination("mailchimp", "publish")).toThrow(
      "Invalid publish destination: mailchimp"
    );
    expect(() => assertEditorDestination("mailchimp", "unpublish")).toThrow(
      "Invalid unpublish destination: mailchimp"
    );
  });
});

describe("isPublishDestination (the §26.4 approval-replay full set)", () => {
  it.each([...PUBLISH_DESTINATIONS])(
    "accepts %s (every canonical destination, including okf)",
    (destination) => {
      expect(isPublishDestination(destination)).toBe(true);
    }
  );

  it("rejects unknown and empty values", () => {
    expect(isPublishDestination("mailchimp")).toBe(false);
    expect(isPublishDestination("")).toBe(false);
    expect(isPublishDestination("OKF")).toBe(false); // case-sensitive, like the DB enum
  });
});

describe("drift protection against the canonical PUBLISH_DESTINATIONS list", () => {
  it("full validator set tracks the canonical list exactly", () => {
    expect(Array.from(PUBLISH_DESTINATION_SET).sort()).toEqual(
      [...PUBLISH_DESTINATIONS].sort()
    );
  });

  it("editor validator set = canonical list minus exactly `okf`", () => {
    expect(Array.from(EDITOR_PUBLISH_DESTINATION_SET).sort()).toEqual(
      PUBLISH_DESTINATIONS.filter((d) => d !== "okf").sort()
    );
  });

  it("TRIPWIRE: adding a destination to the canonical list must be a conscious edit here", () => {
    // The editor set is exclusion-derived, so a destination added to
    // `PUBLISH_DESTINATIONS` becomes editor-publishable automatically. This
    // pinned list fails on ANY addition, forcing the author to decide whether
    // the new destination belongs on the editor surface (and to update the
    // `Exclude<…>` in `EditorPublishDestination` if it does not).
    expect([...PUBLISH_DESTINATIONS].sort()).toEqual(
      ["google", "intranet", "okf", "public_web", "schoology"].sort()
    );
  });
});
