"use server"

/**
 * Atrium collection hero-image server action (migration 178).
 *
 * Sets, generates, or clears a section's header image. Authorization is
 * delegated entirely to `collectionManagementService.update`: the hero fields
 * are part of the section-editor carve-out, so an administrator may set them on
 * any district section and a non-admin holding `create` access may set them on
 * a section they contribute to — the same rule that already governs the
 * section description. A personal collection's owner may set them on their own.
 *
 * Ordering, which matters twice over:
 *
 *  1. AUTHORIZE, then spend. `assertMaySetSectionCopy` runs before any S3 write
 *     or image-generation call. Relying on `update`'s own check afterwards let
 *     any signed-in account burn storage and paid generation against any
 *     collectionId; the rejection arrived after the cost.
 *  2. WRITE the row, then delete the old object. Each hero write uses a new
 *     key, so the previous object is the live image until the row points at
 *     its replacement — deleting first would break a live section if the
 *     update then failed. The reverse leak (a row pointing at bytes that were
 *     never written) cannot happen, because the store completes first.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { collectionManagementService } from "@/lib/content/collection-management-service";
import { s3Store } from "@/lib/content/storage/s3-store";
import {
  generateHeroImage,
  storeHeroImageFromDataUrl,
} from "@/lib/content/collection-hero-service";
import { ValidationError } from "@/lib/content/errors";
import type { CollectionDTO, Requester } from "@/lib/content";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";
import { z } from "zod";

const heroInputSchema = z
  .object({
    /** A `data:` URL from the file picker. Mutually exclusive with `prompt`. */
    dataUrl: z.string().min(1).optional(),
    /** A description to generate from. Mutually exclusive with `dataUrl`. */
    prompt: z.string().min(1).max(1000).optional(),
    /** Required whenever an image is being set; ignored when clearing. */
    alt: z.string().max(300).optional(),
    /** Remove the current hero image. */
    clear: z.boolean().optional(),
  })
  .refine(
    (v) =>
      [v.dataUrl, v.prompt, v.clear ? "clear" : undefined].filter(Boolean)
        .length === 1,
    { message: "Provide exactly one of: an uploaded image, a prompt, or clear" }
  );

/**
 * The human user id behind a requester, for attributing a generated image.
 * `getUserRequester` only ever returns the `user` variant, so the other branch
 * is a contract violation rather than a runtime case to handle gracefully.
 */
function requesterUserId(req: Requester): number {
  // `user` covers the guest shape too, whose id is null — hence the explicit
  // null check rather than trusting the variant tag alone.
  if (req.kind === "user" && req.userId != null) return req.userId;
  if (req.kind === "agent-delegated") return req.actingForUserId;
  throw new ValidationError(
    "Generating a header image requires a signed-in person"
  );
}

/**
 * Delete the hero image a change just superseded.
 *
 * Called only AFTER the collection row has been updated, never before. Every
 * hero write stores a NEW key rather than overwriting, so until the row points
 * at the replacement the old object is still the live image — deleting first
 * would leave a broken hero on a live section if the update then failed.
 *
 * Best-effort: a failed delete leaks one S3 object, which is strictly better
 * than failing a change the user already sees as applied. The bucket's
 * lifecycle rules are storage-class TRANSITIONS and multi-year retention, not
 * orphan cleanup, so without this every replace and clear would leak
 * indefinitely.
 */
async function deleteSupersededHero(
  key: string | null,
  collectionId: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!key) return;
  try {
    await s3Store.deleteKey(key);
  } catch (error) {
    log.warn("Could not delete the superseded hero image", {
      collectionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function setCollectionHeroImageAction(
  collectionId: string,
  input: {
    dataUrl?: string;
    prompt?: string;
    alt?: string;
    clear?: boolean;
  }
): Promise<ActionState<CollectionDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("setCollectionHeroImageAction");
  const log = createLogger({
    requestId,
    action: "setCollectionHeroImageAction",
  });

  try {
    const parsed = heroInputSchema.parse(input);
    // The prompt is user-authored free text describing district content; log
    // only its shape, never its content.
    log.info("Action started: set collection hero image", {
      collectionId,
      mode: parsed.clear ? "clear" : parsed.prompt ? "generate" : "upload",
    });

    const requester = await getUserRequester(requestId);

    if (parsed.clear) {
      const { previousHeroImageKey } =
        await collectionManagementService.assertMaySetSectionCopy(
          requester,
          collectionId
        );
      // Clearing the key also clears the alt text — see `collectionUpdateValues`.
      const cleared = await collectionManagementService.update(
        requester,
        collectionId,
        { heroImageKey: null }
      );
      await deleteSupersededHero(previousHeroImageKey, collectionId, log);
      timer({ status: "success" });
      return createSuccess(cleared, "Header image removed");
    }

    // Alt text, with the GENERATION prompt as its fallback.
    //
    // The prompt is already a description of the image, so requiring separate
    // alt text asked the same question twice — and the UI expressed that by
    // disabling Generate until both were filled, which read as a broken button.
    // Defaulting here rather than only in the client means every caller gets
    // the same behaviour and the accessibility requirement still always holds.
    //
    // An UPLOAD has no prompt to borrow, so alt text remains genuinely
    // required there.
    const alt = parsed.alt?.trim() || parsed.prompt?.trim() || "";
    if (alt.length === 0) {
      // Enforced here rather than in the schema so it applies only to the two
      // set paths — a clear has no image left to describe.
      throw new ValidationError(
        "Describe the image for people using a screen reader."
      );
    }

    // AUTHORIZE BEFORE SPENDING ANYTHING.
    //
    // The store/generate below writes up to 8MB to S3 or calls a paid image
    // model. `collectionManagementService.update` further down does enforce
    // permission — but only AFTER that work has happened, which left any
    // signed-in account able to burn storage and generation spend against any
    // collectionId at all, including ones they cannot edit and ones that do not
    // exist. The rejection came too late to prevent the cost.
    //
    // This is a pre-flight, not the authority: `update` still re-asserts
    // against the FOR-UPDATE-locked row, so a permission revoked in between
    // still blocks the write.
    const { previousHeroImageKey } =
      await collectionManagementService.assertMaySetSectionCopy(
        requester,
        collectionId
      );

    const stored = parsed.dataUrl
      ? await storeHeroImageFromDataUrl(collectionId, parsed.dataUrl)
      : await generateHeroImage(
          collectionId,
          parsed.prompt as string,
          // `getUserRequester` resolves a human session, so this is always the
          // `user` variant. Narrowed explicitly rather than cast: the id is
          // passed to the generation service as the attributed actor, and an
          // agent-delegated requester reaching here should be a type error
          // rather than a silently mis-attributed image.
          requesterUserId(requester)
        );

    const updated = await collectionManagementService.update(
      requester,
      collectionId,
      { heroImageKey: stored.key, heroImageAlt: alt }
    );
    await deleteSupersededHero(previousHeroImageKey, collectionId, log);

    timer({ status: "success" });
    log.info("Collection hero image set", {
      collectionId,
      byteLength: stored.byteLength,
    });
    return createSuccess(updated, "Header image updated");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update the header image", {
      context: "setCollectionHeroImageAction",
      requestId,
      operation: "setCollectionHeroImageAction",
    });
  }
}
