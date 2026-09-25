"use client";

/**
 * The Share dialog's live-data notice (#1790).
 *
 * A `query`-mode artifact does not show its readers a page — it shows each of
 * them a DIFFERENT page, built from whatever their own district permissions let
 * them read. The Share dialog said nothing about that: it offered every
 * visibility level, an embed code, and a public address, all in the same voice
 * it uses for a static document. An author could hand out a link in good faith
 * and have half the recipients see an access message and the other half see
 * numbers the author has never seen.
 *
 * So this states the two things the author cannot discover from the dialog:
 *  - what the recipient will see (their own data, not the author's), and
 *  - that the PUBLIC address is the one place it cannot work — `/p/<slug>` is
 *    anonymous by contract, and a query has to be scoped to somebody.
 *
 * The public line is a separate export because it belongs beside the Level
 * picker (the control that creates the problem), not in the notice at the top.
 * Both are pure presentation: the mode is read upstream and passed in.
 */

import { Database } from "lucide-react";
import type { ContentDataAccess } from "@/lib/content/types";

/** Exact copy, kept in one place so the tests pin the sentence, not a paraphrase. */
export const LIVE_DATA_NOTICE_TEXT =
  "This page shows live PSD data. Each person sees only what their own district permissions allow. People without PSD Data access will see an access message.";

/** Why the Public level is the one audience live data cannot serve. */
export const PUBLIC_LIVE_DATA_WARNING_TEXT =
  "Live data doesn't load on the public web: the public page has no signed-in viewer to read the data as, so a public visitor sees an access message instead of the dashboard.";

/**
 * True when this object's sharing needs the live-data framing — i.e. its bridge
 * mode is `query`. `records` and `none` artifacts, and every document, show the
 * same thing to everyone, so the notice would be noise.
 */
export function isLiveDataObject(
  dataAccess: ContentDataAccess | undefined
): boolean {
  return dataAccess === "query";
}

/** The notice at the top of the Share dialog. Renders nothing off `query` mode. */
export function ShareLiveDataNotice({
  dataAccess,
}: {
  dataAccess?: ContentDataAccess;
}): React.JSX.Element | null {
  if (!isLiveDataObject(dataAccess)) return null;
  return (
    <p className="mer-share-live-data" data-testid="share-live-data-notice">
      <Database className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{LIVE_DATA_NOTICE_TEXT}</span>
    </p>
  );
}

/**
 * The Public-level caveat, shown under the Level picker when the author has
 * actually selected Public for a live-data object. Deliberately an ANNOTATION
 * rather than a disabled option: a live-data artifact may legitimately be set
 * Public (the artifact still opens; only its data does not load), and silently
 * removing an audience the author can otherwise choose would be a worse lie
 * than the silence this replaces.
 */
export function ShareLiveDataPublicWarning({
  dataAccess,
  level,
}: {
  dataAccess?: ContentDataAccess;
  level: string;
}): React.JSX.Element | null {
  if (!isLiveDataObject(dataAccess) || level !== "public") return null;
  return (
    <p
      className="mer-share-link-warning"
      role="status"
      data-testid="share-live-data-public-warning"
    >
      <span>{PUBLIC_LIVE_DATA_WARNING_TEXT}</span>
    </p>
  );
}

export default ShareLiveDataNotice;
