"use client";

/**
 * Atrium AGENT ACTIVITY feed (Epic #1059 Meridian redesign, slice A)
 *
 * The workspace nav column's live-ish panel of recent AI-agent edits on content
 * the caller can see. Read-only: it fetches `listAgentActivityAction` (which is
 * itself visibility-gated) on mount and renders a dot + "<verb> <title> · <ago>"
 * line per row. The newest row within the live window pulses violet; violet is
 * reserved for agent presence, always and only.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  listAgentActivityAction,
  type AgentActivityItemDTO,
} from "@/actions/db/atrium/agent-activity";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "AgentActivityFeed" });

/** A row is "live" (pulsing dot) when its action landed within this window. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

/** Compact relative time: now / 3m / 2h / 4d / 1w (never a future value). */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/** The verb shown before the object title for each audit action. */
function verbFor(action: string): string {
  switch (action) {
    case "create":
      return "Created";
    case "create_version":
    case "update":
      return "Updating";
    case "publish":
      return "Published";
    default:
      return "Changed";
  }
}

function isLive(iso: string | null): boolean {
  if (!iso) return false;
  const then = new Date(iso).getTime();
  return !Number.isNaN(then) && Date.now() - then <= LIVE_WINDOW_MS;
}

export function AgentActivityFeed(): React.JSX.Element {
  const [items, setItems] = useState<AgentActivityItemDTO[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listAgentActivityAction();
      if (res.isSuccess) {
        setItems(res.data);
      } else {
        log.warn("listAgentActivityAction failed", { message: res.message });
      }
    } catch (e) {
      log.error("listAgentActivityAction threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-label="Agent activity" className="mer-activity">
      {loaded && items.length === 0 ? (
        <p className="mer-activity-empty">No recent agent activity.</p>
      ) : (
        items.map((item) => (
          <Link
            key={item.id}
            href={`/atrium/${item.objectId}/edit`}
            className="mer-activity-item"
          >
            <span
              className="mer-activity-dot"
              data-live={isLive(item.createdAt) ? "true" : "false"}
              aria-hidden="true"
            />
            <span>
              {verbFor(item.action)}{" "}
              <span className="mer-activity-title">{item.title}</span>
              {" · "}
              {timeAgo(item.createdAt)}
            </span>
          </Link>
        ))
      )}
    </section>
  );
}
