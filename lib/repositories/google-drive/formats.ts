export const GOOGLE_DRIVE_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const GOOGLE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
export const GOOGLE_VIDS_MIME_TYPE = "application/vnd.google-apps.vid";

export interface GoogleDriveExportFormat {
  contentType: string;
  extension: string;
  method: "blob" | "export" | "long_running_download";
  repositoryItemType: "document" | "image" | "audio" | "video" | "text";
}

const NATIVE_EXPORTS: Record<string, GoogleDriveExportFormat> = {
  "application/vnd.google-apps.document": {
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
    method: "export",
    repositoryItemType: "document",
  },
  "application/vnd.google-apps.spreadsheet": {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
    method: "export",
    repositoryItemType: "document",
  },
  "application/vnd.google-apps.presentation": {
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: ".pptx",
    method: "export",
    repositoryItemType: "document",
  },
  "application/vnd.google-apps.drawing": {
    contentType: "application/pdf",
    extension: ".pdf",
    method: "export",
    repositoryItemType: "document",
  },
  "application/vnd.google-apps.jam": {
    contentType: "application/pdf",
    extension: ".pdf",
    method: "long_running_download",
    repositoryItemType: "document",
  },
  [GOOGLE_VIDS_MIME_TYPE]: {
    contentType: "video/mp4",
    extension: ".mp4",
    method: "long_running_download",
    repositoryItemType: "video",
  },
};

const BLOB_ITEM_TYPES: Array<{
  matches: (mimeType: string) => boolean;
  type: GoogleDriveExportFormat["repositoryItemType"];
}> = [
  { matches: (mimeType) => mimeType.startsWith("image/"), type: "image" },
  { matches: (mimeType) => mimeType.startsWith("audio/"), type: "audio" },
  { matches: (mimeType) => mimeType.startsWith("video/"), type: "video" },
  { matches: (mimeType) => mimeType.startsWith("text/"), type: "text" },
  {
    matches: (mimeType) =>
      mimeType === "application/pdf" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    type: "document",
  },
];

export function resolveGoogleDriveExportFormat(
  sourceMimeType: string,
): GoogleDriveExportFormat | null {
  const native = NATIVE_EXPORTS[sourceMimeType];
  if (native) return native;
  if (sourceMimeType.startsWith("application/vnd.google-apps.")) return null;

  const mapping = BLOB_ITEM_TYPES.find(({ matches }) =>
    matches(sourceMimeType),
  );
  if (!mapping) return null;
  const contentType =
    mapping.type === "text" &&
    sourceMimeType !== "text/markdown" &&
    sourceMimeType !== "text/csv"
      ? "text/plain"
      : sourceMimeType;
  return {
    // The canonical text processor deliberately has a narrow media-type
    // contract. Drive uses many vendor text subtypes (for example
    // text/x-python); their original MIME type remains in connector/version
    // metadata while the byte-identical UTF-8 source is processed as plain
    // text.
    contentType,
    extension: "",
    method: "blob",
    repositoryItemType: mapping.type,
  };
}

function sanitizeBaseName(name: string): string {
  const sanitized = name
    .replace(/[^\d A-Za-z._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 220);
  return sanitized || "google-drive-file";
}

export function exportedGoogleDriveFileName(
  name: string,
  format: GoogleDriveExportFormat,
): string {
  const safeName = sanitizeBaseName(name);
  if (!format.extension) return safeName;
  return safeName.toLowerCase().endsWith(format.extension)
    ? safeName
    : `${safeName}${format.extension}`;
}
