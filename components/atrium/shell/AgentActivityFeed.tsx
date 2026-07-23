"use client";

/**
 * Atrium AGENT ACTIVITY feed (Epic #1059 Meridian redesign, slice A)
 *
 * The workspace nav column's panel of recent AI-agent edits on content the
 * caller can see. Read-only: it fetches `listAgentActivityAction` (which is
 * itself visibility-gated) once on mount and renders a dot + "<verb> <title> ·
 * <ago>" line per row — a snapshot as of page load, not a real-time stream. A row
 * whose action landed within the last few minutes pulses violet to draw the eye
 * to just-happened activity; violet is reserved for agent presence, always and
 * only.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  listAgentActivityAction,
  type AgentActivityItemDTO,
} from "@/actions/db/atrium/agent-activity";
import { timeAgo } from "@/lib/atrium/relative-time";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "AgentActivityFeed" });

/** A row is "live" (pulsing dot) when its action landed within this window. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

/** The verb shown before the object title for each audit action. */
function verbFor(action: string): string {
  switch (action) {
    case "create":
      return "Created";
    case "create_version":
    case "update":
      return "Updated";
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
        items.map((item) => {
          const ago = timeAgo(item.createdAt);
          return (
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
                {ago ? ` · ${ago}` : ""}
              </span>
            </Link>
          );
        })
      )}
    </section>
  );
}
