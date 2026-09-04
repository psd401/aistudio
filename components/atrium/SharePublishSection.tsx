"use client";

/**
 * "Status" — the Live/Draft switch inside the Share dialog (#1726).
 *
 * ## What this replaced, and why
 *
 * This section used to be "Where it's published": a row for the intranet and a
 * row for the public web, each with its own Publish/Unpublish buttons. That made
 * publication a second AUDIENCE control competing with the Level picker directly
 * above it, and the two had to be reconciled by a "Widen who can see this?"
 * prompt. Every part of that was wrong:
 *
 *  - The prompt's claim was false. `/c/[slug]` runs `visibilityService.canView`
 *    BEFORE it looks at the publication, so a Group-visibility object published
 *    to the intranet opens for every grantee and 404s for everyone else. The
 *    people it warned "cannot open it" were exactly the people the author had
 *    deliberately excluded.
 *  - Confirming it DESTROYED the author's work: the widen ran through
 *    `setLevelInTx`, which replaces the grant set, so a Group object with three
 *    named people came back with none.
 *  - The guard was UI-only. The service treated the widen as an optional offer
 *    and the REST endpoint accepted a publish with no visibility at all, so
 *    narrowing back to Group one save later produced the very state the prompt
 *    refused to create.
 *
 * ## The model now
 *
 * Publication is ONE state — Live or Draft. Publishing pins the head version,
 * gives the object its page, and adds it to the published library and retrieval;
 * none of that is an audience decision. The Level alone answers "who", so there
 * is no second switch to reconcile and no prompt to show.
 *
 * In its place the switch STATES its consequence ("Live for the 2 people you've
 * granted"), computed from the Level and grant count. That is the same sentence
 * the prompt was trying to ask as a question, except it is true.
 *
 * Connectors (Schoology / Google) are a genuinely different concept — "push a
 * copy into another system" — so they sit in their own "Also send to…" list,
 * rendered disabled while the adapters still throw `not yet available`.
 */

import { Loader2, Globe, Send } from "lucide-react";
import type { VisibilityLevel } from "@/lib/content";
import { cn } from "@/lib/utils";

/**
 * What goes live, in the author's words, given the audience they chose.
 *
 * Deliberately phrased as a CONSEQUENCE, not a question: the dialog's job here is
 * to tell the author what publishing does, and every one of these states is
 * legitimate — including a Live object only three named people can open.
 */
export function liveConsequence(
  level: VisibilityLevel,
  grantCount: number
): string {
  switch (level) {
    case "public":
      return "Live for anyone with the link, no sign-in.";
    case "internal":
      return "Live for everyone signed in.";
    case "group":
      // "people" alone would be a lie: a grant can be a role, building,
      // department, grade or Google group as well as a named person, and the
      // count is of grants. The point of this line is that it is TRUE for every
      // state — the prompt it replaced was not.
      return grantCount === 1
        ? "Live for the 1 person or group you've granted."
        : `Live for the ${grantCount} people and groups you've granted.`;
    case "private":
      return "Live, but only you and administrators can open it.";
    default:
      return "Live.";
  }
}

/** What a Draft means, in the same voice. */
const DRAFT_CONSEQUENCE =
  "Draft — it has no page of its own yet. Only people who can already see it can open it.";

interface ConnectorOption {
  value: string;
  label: string;
  blurb: string;
}

/**
 * Connectors are destinations in the real sense (a copy lands in another system),
 * which is why they keep `content_publications.destination`. Shown disabled so
 * enabling one later is a change to the adapter, not to this dialog.
 */
const CONNECTORS: readonly ConnectorOption[] = [
  { value: "schoology", label: "Schoology", blurb: "Coming soon." },
  { value: "google", label: "Google Classroom", blurb: "Coming soon." },
];

export interface SharePublishSectionProps {
  /** Whether the object currently has a live publication. */
  isLive: boolean;
  /** The object's SAVED visibility, or null while it is still unknown. */
  visibility: VisibilityLevel | null;
  /** How many grants the SAVED `group` visibility carries. */
  grantCount: number;
  /** A publish/unpublish is in flight upstream. */
  busy: boolean;
  canEdit: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
}

export function SharePublishSection({
  isLive,
  visibility,
  grantCount,
  busy,
  canEdit,
  onPublish,
  onUnpublish,
}: SharePublishSectionProps): React.JSX.Element {
  // The consequence line needs the SAVED level. Until it resolves there is
  // nothing honest to say, so the actions stay disabled rather than describing an
  // audience that might be wrong.
  const known = visibility !== null;
  const consequence = !known
    ? "Checking who can see this…"
    : isLive
      ? liveConsequence(visibility, grantCount)
      : DRAFT_CONSEQUENCE;

  return (
    <div className="mer-share-dests">
      <div
        className="mer-share-dest"
        data-live={isLive ? "true" : "false"}
        data-testid="share-live-state"
      >
        <span className="mer-share-dest-icon" aria-hidden="true">
          <Globe className="h-4 w-4" />
        </span>
        <div className="mer-share-dest-text">
          <p className="mer-share-dest-label">
            {isLive ? "Live" : "Draft"}
            {isLive && (
              <span className="mer-badge mer-badge-live" data-testid="share-live-badge">
                Live
              </span>
            )}
          </p>
          <p className="mer-share-dest-blurb" data-testid="share-consequence">
            {consequence}
          </p>
        </div>
        {canEdit && (
          <div className="mer-share-dest-actions">
            <button
              type="button"
              className={cn("mer-btn", !isLive && "mer-btn-primary")}
              disabled={busy || !known}
              onClick={onPublish}
              data-testid="share-publish"
            >
              {!known ? "Checking…" : isLive ? "Republish" : "Publish"}
            </button>
            {isLive && (
              <button
                type="button"
                className="mer-btn mer-btn-danger"
                disabled={busy}
                onClick={onUnpublish}
                data-testid="share-unpublish"
              >
                Unpublish
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mer-share-connectors" data-testid="share-connectors">
        <p className="mer-share-section-label">
          <Send className="h-3.5 w-3.5" aria-hidden="true" /> Also send to…
        </p>
        {CONNECTORS.map((connector) => (
          <div
            key={connector.value}
            className="mer-share-dest"
            data-testid={`share-connector-${connector.value}`}
            aria-disabled="true"
          >
            <div className="mer-share-dest-text">
              <p className="mer-share-dest-label">{connector.label}</p>
              <p className="mer-share-dest-blurb">{connector.blurb}</p>
            </div>
            <div className="mer-share-dest-actions">
              <button type="button" className="mer-btn" disabled>
                Send
              </button>
            </div>
          </div>
        ))}
      </div>

      {busy && (
        <p className="mer-share-dest-busy" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{" "}
          Working…
        </p>
      )}
    </div>
  );
}

export default SharePublishSection;
