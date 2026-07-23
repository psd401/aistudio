const TEMPORARY_ATTACHMENT_MARKER_PREFIX = "repository-attachment:v1";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MARKER_PATTERN = new RegExp(
  String.raw`\[\[${TEMPORARY_ATTACHMENT_MARKER_PREFIX}:(${UUID_PATTERN}):([1-9]\d*):([^\]]{1,768})\]\]`,
  "gi"
);

export interface TemporaryAttachmentReference {
  bindingId: string;
  itemId: number;
  name: string;
}

export interface AuthoritativeTemporaryAttachmentLabel {
  bindingId: string;
  itemId: number;
  name: string;
}

export interface CanonicalTemporaryAttachmentUpload {
  mode: "canonical";
  reference: TemporaryAttachmentReference;
  repositoryId: number;
  itemVersionId: string;
  processingJobId: string;
}

export interface LegacyTemporaryAttachmentUpload {
  mode: "legacy";
}

export type TemporaryAttachmentUploadResponse =
  | CanonicalTemporaryAttachmentUpload
  | LegacyTemporaryAttachmentUpload;

export function sanitizeTemporaryAttachmentName(name: string): string {
  return name
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .trim()
    .slice(0, 255) || "attachment";
}

export function buildTemporaryAttachmentMarker(
  reference: TemporaryAttachmentReference
): string {
  return `[[${TEMPORARY_ATTACHMENT_MARKER_PREFIX}:${reference.bindingId}:${reference.itemId}:${encodeURIComponent(
    sanitizeTemporaryAttachmentName(reference.name)
  )}]]`;
}

export function parseTemporaryAttachmentMarkers(
  text: string
): TemporaryAttachmentReference[] {
  const references: TemporaryAttachmentReference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const bindingId = match[1]?.toLowerCase();
    const itemId = Number(match[2]);
    const encodedName = match[3];
    if (
      !bindingId ||
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !encodedName
    ) {
      continue;
    }
    const key = `${bindingId}:${itemId}`;
    if (seen.has(key)) continue;
    let name: string;
    try {
      name = sanitizeTemporaryAttachmentName(decodeURIComponent(encodedName));
    } catch {
      continue;
    }
    seen.add(key);
    references.push({ bindingId, itemId, name });
  }
  return references;
}

export function temporaryAttachmentReferencesFromValue(
  value: unknown,
  depth = 0
): TemporaryAttachmentReference[] {
  if (depth > 8) return [];
  if (typeof value === "string") {
    return parseTemporaryAttachmentMarkers(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      temporaryAttachmentReferencesFromValue(entry, depth + 1)
    );
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap((entry) =>
    temporaryAttachmentReferencesFromValue(entry, depth + 1)
  );
}

/**
 * Replace opaque repository identifiers with bounded human-readable labels
 * before arbitrary structured inputs are rendered into a model prompt. Values
 * below the same traversal bound used for reference resolution are omitted so
 * a deeply nested marker cannot bypass resolution and reach the provider.
 */
export function prepareTemporaryAttachmentValueForModel(
  value: unknown,
  depth = 0
): unknown {
  if (depth > 8) return "[Nested input omitted]";
  if (typeof value === "string") {
    return stripTemporaryAttachmentMarkers(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      prepareTemporaryAttachmentValueForModel(entry, depth + 1)
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      prepareTemporaryAttachmentValueForModel(entry, depth + 1),
    ])
  );
}

/**
 * Prepare arbitrary structured input for persistence and model use while
 * sourcing every attachment label from the repository row resolved by the
 * server. The marker's display name is caller-controlled provenance and must
 * never be trusted once an authoritative resolution is available.
 */
export function prepareTemporaryAttachmentValueWithAuthoritativeLabels(
  value: unknown,
  labels: readonly AuthoritativeTemporaryAttachmentLabel[],
  depth = 0
): unknown {
  if (depth > 8) return "[Nested input omitted]";
  if (typeof value === "string") {
    return replaceTemporaryAttachmentMarkersWithAuthoritativeLabels(
      value,
      labels
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      prepareTemporaryAttachmentValueWithAuthoritativeLabels(
        entry,
        labels,
        depth + 1
      )
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      prepareTemporaryAttachmentValueWithAuthoritativeLabels(
        entry,
        labels,
        depth + 1
      ),
    ])
  );
}

export function stripTemporaryAttachmentMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, (_marker, _bindingId, _itemId, encodedName) => {
    try {
      return `[Attached repository content: ${sanitizeTemporaryAttachmentName(
        decodeURIComponent(String(encodedName))
      )}]`;
    } catch {
      return "[Attached repository content]";
    }
  });
}

/**
 * Replace client-carried markers with labels sourced from the repository
 * record. A marker absent from the authoritative set is rendered generically:
 * its caller-controlled display name and opaque identifiers never reach a
 * safety, routing, or model provider.
 */
export function replaceTemporaryAttachmentMarkersWithAuthoritativeLabels(
  text: string,
  labels: readonly AuthoritativeTemporaryAttachmentLabel[]
): string {
  const namesByReference = new Map(
    labels.map((label) => [
      `${label.bindingId.toLowerCase()}:${label.itemId}`,
      sanitizeTemporaryAttachmentName(label.name),
    ])
  );
  return text.replace(
    MARKER_PATTERN,
    (_marker, bindingId, itemId) => {
      const name = namesByReference.get(
        `${String(bindingId).toLowerCase()}:${Number(itemId)}`
      );
      return name
        ? `[Attached repository content: ${name}]`
        : "[Attached repository content]";
    }
  );
}

/**
 * Removes opaque attachment references from user-visible text. The references
 * are rendered as dedicated attachment cards by the chat UI, while server-side
 * message preparation retains a safe model-facing label.
 */
export function removeTemporaryAttachmentMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, "");
}
