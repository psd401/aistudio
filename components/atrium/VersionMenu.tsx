"use client";

/**
 * Atrium VersionMenu — version history + restore (Epic #1059 completion)
 *
 * A "History" dialog listing an object's versions (vN · AI/human · date ·
 * summary) with a "Restore" action per non-current version. Works for BOTH
 * kinds via `listContentVersionsAction`; restore calls `rollbackVersionAction`,
 * which points the working head at the chosen version (the service enforces
 * canView 404-masking + assertCanEdit server-side — this UI is presentation
 * only).
 *
 * Mounted on the authoring page header for documents (the artifact canvas has
 * its own inline version select + restore, sharing the same actions). For a
 * document, restoring changes the WORKING HEAD — what Publish makes live — but
 * does not rewrite the live collaborative editor content (spec §14: rollback
 * repoints the head; the collab doc is its own live state), so the dialog says
 * exactly that. After a restore we refresh the version list, call
 * `router.refresh()`, and invoke `onRestored` so a mounting surface can reload
 * its own state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { listContentVersionsAction, rollbackVersionAction } from "@/actions/db/atrium/rollback-version";
import type { VersionSummary } from "@/actions/db/atrium/list-versions";
import { meridianPortalClassName } from "@/lib/atrium/meridian-fonts";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "VersionMenu" });

/** "AI" | "human" author label for a version (matches the canvas labels). */
function authorLabel(v: VersionSummary): string {
  return v.authorActor === "agent" ? "AI" : "human";
}

/** Locale date-time for a version's createdAt, or empty when unknown. */
function versionDate(v: VersionSummary): string {
  if (!v.createdAt) return "";
  const d = new Date(v.createdAt);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export interface VersionMenuProps {
  /** Content object id or slug (the actions resolve slugs). */
  idOrSlug: string;
  /** Whether the viewer may restore (the server re-checks regardless). */
  canEdit: boolean;
  /** Called after a successful restore (e.g. so a canvas can reload its state). */
  onRestored?: (versionId: string) => void;
}

export function VersionMenu({
  idOrSlug,
  canEdit,
  onRestored,
}: VersionMenuProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic sequence so a slow earlier list response cannot overwrite a newer
  // one (open/close/open, or a post-restore refresh racing a stale open fetch).
  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const reqSeq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listContentVersionsAction(idOrSlug);
      if (reqSeq !== reqSeqRef.current) return; // stale — drop it
      if (res.isSuccess) {
        setVersions(res.data);
      } else {
        setError(res.message ?? "Could not load version history");
        log.warn("listContentVersionsAction failed", { message: res.message });
      }
    } catch (e) {
      if (reqSeq !== reqSeqRef.current) return;
      setError("Could not load version history");
      log.error("listContentVersionsAction threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqSeq === reqSeqRef.current) setLoading(false);
    }
  }, [idOrSlug]);

  // Fetch the history each time the dialog opens (versions may have advanced
  // since the last open — snapshots/agent edits happen while the dialog is
  // closed, so a cached list would silently show stale history).
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const restore = useCallback(
    async (version: VersionSummary) => {
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Restore v${version.versionNumber} as the current version? Publishing will then make v${version.versionNumber} live.`
        )
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await rollbackVersionAction(idOrSlug, version.id);
        if (res.isSuccess) {
          await load();
          // Server-rendered surfaces (title header, reader) may depend on the
          // head — refresh them, then let the mounting surface react.
          router.refresh();
          onRestored?.(version.id);
        } else {
          setError(res.message ?? "Could not restore this version");
          log.warn("rollbackVersionAction failed", { message: res.message });
        }
      } catch (e) {
        setError("Could not restore this version — please try again.");
        log.error("rollbackVersionAction threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [idOrSlug, load, router, onRestored]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="mer-ectl">
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          History
        </button>
      </DialogTrigger>
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Restoring points the current version at an earlier snapshot; the live
            editor content is unchanged until you publish or snapshot again.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="text-sm text-muted-foreground">Loading versions…</p>
        )}
        {error && !loading && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && versions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No versions yet — save a snapshot to create one.
          </p>
        )}

        {!loading && versions.length > 0 && (
          <ul className="max-h-80 space-y-2 overflow-y-auto" data-testid="version-menu-list">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="font-medium">v{v.versionNumber}</span>
                <Badge variant={v.authorActor === "agent" ? "info" : "success"}>
                  {authorLabel(v)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {versionDate(v)}
                  {v.summary ? ` · ${v.summary}` : ""}
                </span>
                {v.isCurrent ? (
                  <Badge variant="outline">current</Badge>
                ) : (
                  canEdit && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void restore(v)}
                    >
                      Restore
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
