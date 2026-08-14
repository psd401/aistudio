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
 * The image bytes are stored BEFORE the update call, so a rejected update
 * leaves an orphaned object rather than a collection row pointing at bytes that
 * were never written. Orphans are inert (nothing serves a key no row
 * references) and are reaped by the bucket lifecycle rule; the inverse — a row
 * pointing at a missing key — would render a broken hero on a live page.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { collectionManagementService } from "@/lib/content/collection-management-service";
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
      // Clearing the key also clears the alt text — see `collectionUpdateValues`.
      const cleared = await collectionManagementService.update(
        requester,
        collectionId,
        { heroImageKey: null }
      );
      timer({ status: "success" });
      return createSuccess(cleared, "Header image removed");
    }

    const alt = parsed.alt?.trim() ?? "";
    if (alt.length === 0) {
      // Enforced here rather than in the schema so it applies only to the two
      // set paths — a clear has no image left to describe.
      throw new ValidationError(
        "Describe the image for people using a screen reader."
      );
    }

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
