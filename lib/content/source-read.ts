/**
 * Permission-checked immutable source reads (#1288).
 */

import { contentService } from "./content-service";
import { NotFoundError } from "./errors";
import type {
  ContentSourceDTO,
  ContentVersionDTO,
  Requester,
} from "./types";
import { versionService } from "./version-service";

export const contentSourceService = {
  async resolve(
    req: Requester,
    idOrSlug: string,
    versionId?: string
  ): Promise<ContentVersionDTO> {
    // The object permission check always happens before the version lookup or any
    // storage read, preserving the existing 404 existence-masking contract.
    const object = await contentService.get(req, idOrSlug);
    const version = versionId
      ? await versionService.getById(object.id, versionId)
      : object.version;
    if (!version) {
      throw new NotFoundError("Content version not found", {
        objectId: object.id,
      });
    }
    return version;
  },

  async loadResolved(
    version: ContentVersionDTO
  ): Promise<ContentSourceDTO> {
    return versionService.loadSource(version);
  },

  async read(
    req: Requester,
    idOrSlug: string,
    versionId?: string
  ): Promise<ContentSourceDTO> {
    const version = await this.resolve(req, idOrSlug, versionId);
    return this.loadResolved(version);
  },
};

/** Strong ETag for an immutable source version. */
export function contentSourceEtag(versionId: string): string {
  return `"${versionId}"`;
}

/** RFC 9110-compatible match for If-None-Match lists and weak validators. */
export function ifNoneMatchIncludes(
  header: string | null,
  etag: string
): boolean {
  if (!header) return false;
  const normalizedTarget = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return (
      trimmed === "*" ||
      trimmed.replace(/^W\//, "") === normalizedTarget
    );
  });
}
