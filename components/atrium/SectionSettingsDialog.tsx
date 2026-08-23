"use client";

/**
 * "Edit this page" — the section landing page's own settings.
 *
 * ## Why it lives here and not in the admin collection panel
 *
 * This edits the two things you can SEE on the landing page: the description in
 * the hero and which page is pinned to the top. Editing them anywhere else means
 * writing hero copy while looking at a table of collection rows. The admin panel
 * keeps what it is actually for — structure: name, parent, order, and grants.
 *
 * ## Who can open it
 *
 * Anyone with `create` access to the section (`node.selectableForCreate`), not
 * only administrators. `collectionManagementService.update` enforces the same
 * split server-side via `SECTION_EDITOR_FIELDS`: a patch touching only these two
 * fields waives the district-admin requirement, and any other field still
 * requires an administrator. Describing the section you contribute to should not
 * need an admin; restructuring it still does.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateCollectionAction } from "@/actions/db/atrium/collection-management";
import { setCollectionHeroImageAction } from "@/actions/db/atrium/collection-hero";
import { listContentAction } from "@/actions/db/atrium/list-content";
import type { ContentObjectDTO } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";
import { meridianPortalClassName } from "@/lib/meridian/fonts";

const log = createLogger({ component: "SectionSettingsDialog" });

const DESCRIPTION_MAX = 2000;

export interface SectionSettingsDialogProps {
  collectionId: string;
  sectionName: string;
  initialDescription: string | null;
  initialLandingObjectId: string | null;
  /** Whether the section currently has hero art (migration 178). */
  hasHeroImage?: boolean;
  /** Existing alt text, pre-filled when replacing an image. */
  initialHeroImageAlt?: string | null;
}

/** Mirrors `MAX_HERO_IMAGE_BYTES` — checked client-side to fail fast, and again on the server. */
const HERO_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read a picked file as a `data:` URL for the server action.
 *
 * Base64 through a server action rather than a presigned direct-to-S3 upload:
 * a hero image is a single small file chosen once in a settings dialog, and the
 * presigned flow would need an initiate endpoint, a client PUT, and a
 * confirmation round-trip to save nothing at this size.
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(new Error("Could not read that file"))
    );
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.readAsDataURL(file);
  });
}

/**
 * All hero-image state and side effects, for `HeroImageEditor`.
 *
 * Changes apply IMMEDIATELY rather than participating in the dialog's Save.
 * Image work is slow (generation takes seconds) and independently fallible (no
 * model configured, a provider refusal, an oversized file) — folding it into
 * Save would let an image failure discard the description edits beside it, and
 * would make Save's latency unpredictable.
 *
 * Split from the component so the component is markup only and both stay under
 * the max-lines lint.
 */
function useHeroImage(
  collectionId: string,
  hasHeroImage: boolean,
  initialAlt: string | null
) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [alt, setAlt] = useState(initialAlt ?? "");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [present, setPresent] = useState(hasHeroImage);
  /**
   * Cache-buster for the preview `src`.
   *
   * The hero route sets `immutable` and each write stores a NEW key, so the URL
   * is stable while its bytes change. Without a changing query the browser
   * keeps showing the OLD image after a replace — which reads as "nothing
   * happened", the single most confusing thing about the first version of this
   * control.
   */
  const [previewSeq, setPreviewSeq] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apply = useCallback(
    async (
      input: { dataUrl?: string; prompt?: string; clear?: boolean },
      label: string,
      /**
       * Alt text to send. Generation passes the PROMPT when the author has not
       * written alt text separately — the prompt already describes the image,
       * so demanding it twice was pure friction.
       */
      altToSend: string
    ) => {
      setBusy(true);
      setBusyLabel(label);
      setError(null);
      setNotice(null);
      try {
        const res = await setCollectionHeroImageAction(collectionId, {
          ...input,
          alt: altToSend,
        });
        if (res.isSuccess) {
          setPresent(!input.clear);
          setAlt(input.clear ? "" : altToSend);
          setPrompt("");
          setPreviewSeq((n) => n + 1);
          setNotice(
            input.clear ? "Header image removed." : "Header image updated."
          );
          // The hero is server-rendered; re-run the server components in place
          // rather than reloading the document.
          router.refresh();
        } else {
          setError(res.message ?? "Could not update the header image");
        }
      } catch (e) {
        setError("Could not update the header image");
        log.error("setCollectionHeroImageAction threw", {
          collectionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      setBusy(false);
      setBusyLabel("");
    },
    [collectionId, router]
  );

  const onPickFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      // Checked here as well as on the server so an oversized pick fails
      // instantly instead of after base64-inflating it over the wire.
      if (file.size > HERO_MAX_BYTES) {
        setError(
          `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${
            HERO_MAX_BYTES / 1024 / 1024
          }MB.`
        );
        return;
      }
      // An UPLOAD has no prompt to borrow, so alt text is genuinely required.
      // Say so on the attempt rather than disabling the control — a dead button
      // with a hint underneath reads as "broken", which is exactly how the
      // first version of this was received.
      if (alt.trim().length === 0) {
        setError(
          "Add a short description of the image first — screen readers need it."
        );
        return;
      }
      void (async () => {
        try {
          await apply(
            { dataUrl: await readFileAsDataUrl(file) },
            "Uploading…",
            alt.trim()
          );
        } catch {
          setError("Could not read that file");
        }
      })();
    },
    [apply, alt]
  );

  const onGenerate = useCallback(() => {
    const description = prompt.trim();
    if (description.length < 3) {
      setError("Describe the image you want in a few more words.");
      return;
    }
    // The prompt IS a description of the image, so it doubles as alt text when
    // the author has not written their own. Requiring both was asking the same
    // question twice.
    void apply({ prompt: description }, "Generating…", alt.trim() || description);
  }, [apply, prompt, alt]);

  return {
    prompt, setPrompt, alt, setAlt, busy, busyLabel, error, notice, present,
    previewSeq, fileInputRef, apply, onPickFile, onGenerate,
  };
}

function HeroImageEditor({
  collectionId,
  hasHeroImage,
  initialAlt,
}: {
  collectionId: string;
  hasHeroImage: boolean;
  initialAlt: string | null;
}): React.JSX.Element {
  const {
    prompt, setPrompt, alt, setAlt, busy, busyLabel, error, notice, present,
    previewSeq, fileInputRef, apply, onPickFile, onGenerate,
  } = useHeroImage(collectionId, hasHeroImage, initialAlt);

  return (
    <div className="space-y-2">
      <Label>Header image</Label>

      {/*
        PREVIEW. The first version showed nothing at all: the hero renders on
        the page BEHIND this modal, so generating produced no visible change
        and looked like a no-op even when it had worked. `previewSeq` busts the
        immutable cache so a replacement actually appears.
      */}
      {present ? (
        <img
          src={`/api/atrium/collections/${collectionId}/hero?v=${previewSeq}`}
          alt={alt || "Current header image"}
          className="mer-hero-preview"
          data-testid="section-hero-preview"
        />
      ) : (
        <p className="mer-hero-preview mer-hero-preview--empty">
          No header image yet
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/*
          A real button. This was a bare <input type="file">, which macOS
          renders as the unstyled text "Choose File / No file chosen" — it did
          not read as clickable and was routinely missed. The input is still
          the thing that opens the picker (that cannot be synthesised
          accessibly), just visually hidden behind a label styled as a button.
        */}
        <label className="mer-btn" data-testid="section-hero-upload-label">
          Upload image…
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              onPickFile(e.target.files?.[0]);
              // Reset so picking the SAME file again still fires onChange.
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            data-testid="section-hero-upload"
          />
        </label>
        {present && (
          <button
            type="button"
            className="mer-btn"
            disabled={busy}
            onClick={() => void apply({ clear: true }, "Removing…", "")}
            data-testid="section-hero-remove"
          >
            Remove image
          </button>
        )}
      </div>

      <input
        id="section-hero-alt"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={alt}
        maxLength={300}
        disabled={busy}
        placeholder="Describe the image for screen readers"
        onChange={(e) => setAlt(e.target.value)}
        aria-label="Describe the image for screen readers"
        data-testid="section-hero-alt"
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          value={prompt}
          maxLength={1000}
          disabled={busy}
          placeholder="…or describe an image to generate"
          onChange={(e) => setPrompt(e.target.value)}
          data-testid="section-hero-prompt"
        />
        {/*
          Enabled whenever there is a prompt. It used to also require the alt
          field, which meant pressing it after typing a prompt did NOTHING and
          gave no reason why. The prompt now doubles as the alt text.
        */}
        <button
          type="button"
          className="mer-btn"
          disabled={busy}
          onClick={onGenerate}
          data-testid="section-hero-generate"
        >
          {busy && busyLabel === "Generating…" ? "Generating…" : "Generate"}
        </button>
      </div>

      {busy && (
        <p className="text-xs text-muted-foreground" role="status">
          {busyLabel} This can take a few seconds.
        </p>
      )}
      {notice && !busy && (
        <p className="text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The "start here" pin candidates — this section's pages.
 *
 * Loaded only while the dialog is OPEN: the landing page already paid for its
 * own listing, and this is a different (unpaginated, title-only) shape that
 * would otherwise be fetched on every section render for a dialog most viewers
 * never open.
 *
 * Extracted from the component to keep it under the max-lines lint.
 */
function usePinOptions(
  open: boolean,
  collectionId: string
): { options: ContentObjectDTO[]; loadingOptions: boolean } {
  const [options, setOptions] = useState<ContentObjectDTO[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      // Inside the IIFE, not synchronously in the effect body: a synchronous
      // setState in an effect triggers a cascading render (and the lint that
      // guards against it). This is the pattern the rest of the codebase uses.
      setLoadingOptions(true);
      try {
        const res = await listContentAction({ collectionId, limit: 100 });
        if (!cancelled && res.isSuccess) setOptions(res.data);
      } catch (e) {
        // A failed load leaves the pin picker empty; the description still saves.
        if (!cancelled) {
          setOptions([]);
          log.warn("pin options load failed", {
            collectionId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!cancelled) setLoadingOptions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, collectionId]);

  return { options, loadingOptions };
}

/** Help text under the pin picker, by load state. */
function pinHelpText(loading: boolean, count: number): string {
  if (loading) return "Loading this section's pages…";
  if (count === 0) return "This section has no pages yet.";
  return "Pinned above everything else, so the page to read first is not buried by whatever changed most recently.";
}

export function SectionSettingsDialog({
  collectionId,
  sectionName,
  initialDescription,
  initialLandingObjectId,
  hasHeroImage = false,
  initialHeroImageAlt = null,
}: SectionSettingsDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [landingObjectId, setLandingObjectId] = useState(
    initialLandingObjectId ?? ""
  );
  const { options, loadingOptions } = usePinOptions(open, collectionId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(() => {
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const res = await updateCollectionAction(collectionId, {
          // Empty string CLEARS (the service maps blank to null). Sending
          // `undefined` would drop the column from the UPDATE and silently keep
          // the old copy while the form showed it as cleared.
          description,
          landingObjectId: landingObjectId || null,
        });
        if (res.isSuccess) {
          setOpen(false);
          // The hero is server-rendered, so a client state update cannot show
          // the new copy. `router.refresh()` re-runs the server components in
          // place — unlike `window.location.reload()`, which threw away the
          // whole document (a visible white flash, scroll position lost, and a
          // navigation that raced anything still settling on the page).
          router.refresh();
          return;
        }
        setError(res.message ?? "Could not save these settings");
      } catch (e) {
        setError("Could not save these settings");
        log.error("updateCollectionAction threw", {
          collectionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      setSaving(false);
    })();
  }, [collectionId, description, landingObjectId, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="mer-btn" data-testid="section-settings">
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Edit this page
        </button>
      </DialogTrigger>
      {/* `meridianPortalClassName` is REQUIRED on every Atrium dialog. Radix
          portals dialog content to the document body, outside the `.meridian`
          scope that defines the design tokens — without it the dialog falls back
          to the app's older cream theme, which is exactly what this one did. */}
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>{sectionName}</DialogTitle>
          <DialogDescription>
            What people see at the top of this section, and which page they
            should read first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="section-description">Description</Label>
            <textarea
              id="section-description"
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={description}
              maxLength={DESCRIPTION_MAX}
              disabled={saving}
              placeholder="What belongs in this section, and who it is for."
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <HeroImageEditor
            collectionId={collectionId}
            hasHeroImage={hasHeroImage}
            initialAlt={initialHeroImageAlt}
          />

          <div className="space-y-2">
            <Label htmlFor="section-landing">Start here</Label>
            <select
              id="section-landing"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={landingObjectId}
              disabled={saving || loadingOptions}
              onChange={(e) => setLandingObjectId(e.target.value)}
              data-testid="section-start-here"
            >
              <option value="">No pinned page</option>
              {/* A pin at something no longer in this section (it was moved)
                  would otherwise vanish from the list and silently reset to
                  "none" on the next save. Keep it visible and clearable. */}
              {landingObjectId &&
                !options.some((o) => o.id === landingObjectId) && (
                  <option value={landingObjectId}>
                    Currently pinned page (no longer in this section)
                  </option>
                )}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {pinHelpText(loadingOptions, options.length)}
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SectionSettingsDialog;
