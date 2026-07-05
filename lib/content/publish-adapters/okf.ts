/**
 * Atrium OKF publish adapter — Phase 8 (Issue #1103, Epic #1059, spec §36.2)
 *
 * The `okf` destination models exporting a SINGLE object as a portable Open
 * Knowledge Format concept bundle through the standard §15.3 publish pipeline: the
 * publish service runs the `canView` (404-mask) + `assertCanEdit` gates and writes
 * the canonical `content_publications` row, THEN calls this adapter to produce the
 * bundle and return its S3 location as `external_ref`.
 *
 * This is the object-grained companion to `lib/content/okf/export.ts` (the
 * collection-subtree exporter and the primary `export_okf` surface); both share the
 * pure serializers in `lib/content/okf/serialize.ts`. The adapter has no external
 * system to call — it serializes + persists to S3, so it never fails in a way that
 * needs the publish service's compensation branch beyond an S3 outage.
 *
 * `okf` is deliberately NOT a public destination (`isPublicDestination` → false): a
 * single-object bundle is a portable copy of an object the caller already owns/edits
 * (the publish service enforced `assertCanEdit`), so it carries the internal-publish
 * authority. The §26.4 public gate applies to the COLLECTION exporter's `public`
 * audience (spec §36.2), enforced in `okfExportService`.
 */

import { contentService } from "../content-service";
import { versionService } from "../version-service";
import { s3Store } from "../storage/s3-store";
import { createLogger } from "@/lib/logger";
import {
  OKF_GENERATOR,
  OKF_LOG_FILE,
  OKF_VERSION,
  conceptFileName,
  type OkfBundle,
  type OkfFile,
} from "../okf/profile";
import {
  buildConceptFile,
  buildLogFile,
  toLogEntries,
  type ConceptSource,
} from "../okf/serialize";
import type { PublishAdapter } from "./types";

const log = createLogger({ module: "atrium-okf-adapter" });

/**
 * Load the head-version source text for an already-authorized object. No `canView`
 * here — the publish service ran it before this adapter is reached — and no
 * published-status gate (publishing to `okf` is itself what marks it live).
 */
async function loadBody(
  objectId: string,
  version: Awaited<ReturnType<typeof versionService.current>>
): Promise<string> {
  if (!version) return "";
  if (version.bodyFormat === "markdown") {
    return s3Store.getText(s3Store.key(objectId, version.versionNumber, "source.md"));
  }
  return versionService.loadArtifactCode(version);
}

export const okfAdapter: PublishAdapter = {
  destination: "okf",

  /**
   * Serialize the published version to a single-concept OKF bundle, persist it to
   * S3, and return a presigned URL as `external_ref`. Returns `{ externalRef: null }`
   * when the object/version can no longer be loaded (a concurrent delete) — the
   * publish service treats a null ref as "no external system", not a failure.
   */
  async publish({ objectId, slug, versionId, title }): Promise<{ externalRef: string | null }> {
    const obj = await contentService.loadByIdOrSlug(objectId);
    if (!obj) return { externalRef: null };

    const version =
      (await versionService.getById(objectId, versionId)) ??
      (await versionService.current(objectId));
    if (!version) return { externalRef: null };

    const body = await loadBody(objectId, version);
    const versions = await versionService.list(objectId);

    const source: ConceptSource = {
      kind: obj.kind,
      title,
      summary: version.summary,
      tags: obj.tags,
      updatedAt: obj.updatedAt,
      resource: null,
      bodyFormat: version.bodyFormat,
      body,
    };

    const files: OkfFile[] = [
      { path: conceptFileName(slug), content: buildConceptFile(source) },
      {
        path: OKF_LOG_FILE,
        content: buildLogFile(title, toLogEntries(versions)),
      },
    ];

    const bundle: OkfBundle = {
      okfVersion: OKF_VERSION,
      generator: OKF_GENERATOR,
      rootCollectionId: obj.collectionId,
      rootCollectionSlug: null,
      audience: "internal",
      objectCount: 1,
      collectionCount: 0,
      files,
    };

    // Scope the bundle key by collection id (the documented `okfBundleKey`
    // convention), falling back to the object id for a collection-less object.
    // versionId is a uuid — a safe key segment.
    const key = s3Store.okfBundleKey(obj.collectionId ?? objectId, versionId);
    await s3Store.putText(key, JSON.stringify(bundle), "application/json", "attachment");
    const url = await s3Store.signedReadUrl(key);
    log.info("Published single-object OKF concept bundle", { objectId, key });
    return { externalRef: url };
  },
};
