import { createHash } from "node:crypto";
import type {
  RepositorySourceLocator,
  RepositorySourceRegion,
} from "@/lib/db/schema";
import type { PublishableSegment } from "./publication-service";

export const MEDIA_PROCESSOR_VERSION = "aistudio-media-bda-v1";
export const BDA_AUDIO_MAX_BYTES = 2 * 1024 ** 3;
export const BDA_VIDEO_MAX_BYTES = 10 * 1024 ** 3;

const MAX_TRANSCRIPT_CHUNK_CHARACTERS = 2_400;

const AUDIO_CONTENT_TYPES = new Set([
  "audio/amr",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-flac",
  "audio/x-m4a",
  "audio/x-wav",
]);

const VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
]);

export type MediaKind = "audio" | "video";

interface TimedText {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
  channel?: string;
  regions?: RepositorySourceRegion[];
}

interface MediaMetadata {
  durationMs: number;
  format?: string;
  codec?: string;
  language?: string;
  channels?: number;
  frameRate?: number;
  frameWidth?: number;
  frameHeight?: number;
  wordCount?: number;
  topicCount?: number;
  shotCount?: number;
  chapterCount?: number;
  speakerCount?: number;
}

export interface ProcessedMediaOutput {
  modality: MediaKind;
  canonicalText: string;
  transcriptText: string;
  summary?: string;
  segments: PublishableSegment[];
  metadata: MediaMetadata;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nestedObject(object: JsonObject, key: string): JsonObject | null {
  return asObject(object[key]);
}

function nestedString(
  object: JsonObject,
  ...keys: string[]
): string | undefined {
  let current: unknown = object;
  for (const key of keys) {
    const currentObject = asObject(current);
    if (!currentObject) return undefined;
    current = currentObject[key];
  }
  return asString(current);
}

function findArray(object: JsonObject, key: string, depth = 0): unknown[] {
  if (Array.isArray(object[key])) return object[key] as unknown[];
  if (depth >= 4) return [];
  for (const value of Object.values(object)) {
    const child = asObject(value);
    if (!child) continue;
    const found = findArray(child, key, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function unwrapStandardOutput(value: unknown, depth = 0): JsonObject | null {
  const object = asObject(value);
  if (!object || depth > 6) return null;
  const metadata = nestedObject(object, "metadata");
  const modality =
    metadata && asString(metadata.semantic_modality)?.toUpperCase();
  if (modality === "AUDIO" || modality === "VIDEO") return object;

  const standardOutput = asObject(
    object.standardOutput ?? object.standard_output,
  );
  if (standardOutput) {
    const unwrapped = unwrapStandardOutput(standardOutput, depth + 1);
    if (unwrapped) return unwrapped;
  }

  const outputSegments = Array.isArray(object.outputSegments)
    ? object.outputSegments
    : [];
  for (const segment of outputSegments) {
    const unwrapped = unwrapStandardOutput(segment, depth + 1);
    if (unwrapped) return unwrapped;
  }

  for (const child of Object.values(object)) {
    if (Array.isArray(child)) continue;
    const unwrapped = unwrapStandardOutput(child, depth + 1);
    if (unwrapped) return unwrapped;
  }
  return null;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function estimatedTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function formatTimestamp(milliseconds: number): string {
  const totalMilliseconds = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const remainder = totalMilliseconds % 1_000;
  return (
    [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":") + `.${String(remainder).padStart(3, "0")}`
  );
}

function labelForTimedText(item: TimedText): string {
  return [item.speaker, item.channel].filter(Boolean).join(" / ");
}

function transcriptLine(item: TimedText): string {
  const label = labelForTimedText(item);
  return (
    `[${formatTimestamp(item.startMs)}–${formatTimestamp(item.endMs)}]` +
    `${label ? ` [${label}]` : ""} ${item.text}`
  );
}

function parseTimedText(value: unknown): TimedText | null {
  const object = asObject(value);
  if (!object) return null;
  const text = asString(object.text ?? object.content);
  const startMs = asNumber(
    object.start_timestamp_millis ?? object.startTimeMillis,
  );
  const endMs = asNumber(object.end_timestamp_millis ?? object.endTimeMillis);
  if (!text || startMs == null || endMs == null || endMs < startMs) return null;
  const speaker = nestedString(object, "speaker", "speaker_label");
  const channel = nestedString(object, "channel", "channel_label");
  return { text, startMs, endMs, speaker, channel };
}

function normalizeRegion(value: unknown): RepositorySourceRegion | null {
  const location = asObject(value);
  const box =
    location && asObject(location.bounding_box ?? location.boundingBox);
  if (!box) return null;
  const x = asNumber(box.left ?? box.x);
  const y = asNumber(box.top ?? box.y);
  const width = asNumber(box.width);
  const height = asNumber(box.height);
  if (x == null || y == null || width == null || height == null) return null;
  if (x > 1 || y > 1 || width > 1 || height > 1) return null;
  return { x, y, width, height };
}

function parseFrameText(value: unknown): TimedText | null {
  const frame = asObject(value);
  if (!frame) return null;
  const timestamp = asNumber(frame.timestamp_millis ?? frame.timestampMillis);
  if (timestamp == null) return null;
  const lines = Array.isArray(frame.text_lines)
    ? frame.text_lines
    : Array.isArray(frame.text_words)
      ? frame.text_words
      : [];
  const text: string[] = [];
  const regions: RepositorySourceRegion[] = [];
  for (const rawLine of lines) {
    const line = asObject(rawLine);
    const content = line && asString(line.text);
    if (!line || !content) continue;
    text.push(content);
    const locations = Array.isArray(line.locations) ? line.locations : [];
    for (const location of locations) {
      const region = normalizeRegion(location);
      if (region) regions.push(region);
    }
  }
  const uniqueText = [...new Set(text)];
  if (uniqueText.length === 0) return null;
  return {
    text: uniqueText.join(" "),
    startMs: timestamp,
    endMs: timestamp,
    regions: regions.slice(0, 100),
  };
}

function mediaSummary(
  root: JsonObject,
  modality: MediaKind,
): string | undefined {
  const container = nestedObject(root, modality);
  return (
    asString(root.summary) ??
    asString(root[`${modality}_summary`]) ??
    asString(root[`full_${modality}_summary`]) ??
    (container ? asString(container.summary) : undefined)
  );
}

function mediaMetadata(root: JsonObject, modality: MediaKind): MediaMetadata {
  const metadata = nestedObject(root, "metadata");
  if (!metadata) throw new Error("BDA media output is missing metadata");
  const durationMs = asNumber(
    metadata.duration_millis ?? metadata.durationMillis,
  );
  if (durationMs == null)
    throw new Error("BDA media output is missing duration");
  const statistics = nestedObject(root, "statistics") ?? {};
  return {
    durationMs,
    format: asString(metadata.format),
    codec: asString(metadata.codec),
    language: asString(metadata.dominant_asset_language),
    channels: asNumber(metadata.number_of_channels),
    frameRate: modality === "video" ? asNumber(metadata.frame_rate) : undefined,
    frameWidth:
      modality === "video" ? asNumber(metadata.frame_width) : undefined,
    frameHeight:
      modality === "video" ? asNumber(metadata.frame_height) : undefined,
    wordCount: asNumber(statistics.word_count),
    topicCount: asNumber(statistics.topic_count),
    shotCount: asNumber(statistics.shot_count),
    chapterCount: asNumber(statistics.chapter_count),
    speakerCount: asNumber(statistics.speaker_count),
  };
}

function locatorFor(item: TimedText): RepositorySourceLocator {
  return {
    timeStartMs: item.startMs,
    timeEndMs: item.endMs,
    ...(item.regions?.length ? { regions: item.regions } : {}),
  };
}

function addSegment(
  segments: PublishableSegment[],
  content: string,
  sourceLocator: RepositorySourceLocator,
  modality: MediaKind,
): void {
  const normalized = content.trim();
  if (!normalized) return;
  segments.push({
    content: normalized,
    contentHash: contentHash(normalized),
    chunkIndex: segments.length,
    tokens: estimatedTokens(normalized),
    sourceLocator,
    modality,
  });
}

function groupTranscript(items: TimedText[]): TimedText[] {
  const grouped: TimedText[] = [];
  for (const item of items) {
    const previous = grouped[grouped.length - 1];
    const labelMatches =
      previous?.speaker === item.speaker && previous?.channel === item.channel;
    const joined = previous ? `${previous.text} ${item.text}` : item.text;
    if (
      previous &&
      labelMatches &&
      joined.length <= MAX_TRANSCRIPT_CHUNK_CHARACTERS &&
      item.startMs - previous.endMs <= 5_000
    ) {
      previous.text = joined;
      previous.endMs = item.endMs;
    } else {
      grouped.push({ ...item });
    }
  }
  return grouped;
}

function parseTopics(root: JsonObject): TimedText[] {
  return findArray(root, "topics").flatMap((value) => {
    const object = asObject(value);
    if (!object) return [];
    const summary = asString(object.summary);
    const startMs = asNumber(object.start_timestamp_millis);
    const endMs = asNumber(object.end_timestamp_millis);
    if (!summary || startMs == null || endMs == null || endMs < startMs)
      return [];
    return [{ text: summary, startMs, endMs }];
  });
}

function parseChapters(root: JsonObject): TimedText[] {
  return findArray(root, "chapters").flatMap((value) => {
    const object = asObject(value);
    if (!object) return [];
    const summary = asString(object.summary);
    const startMs = asNumber(object.start_timestamp_millis);
    const endMs = asNumber(object.end_timestamp_millis);
    if (!summary || startMs == null || endMs == null || endMs < startMs)
      return [];
    return [{ text: summary, startMs, endMs }];
  });
}

export function mediaKindForContentType(contentType: string): MediaKind | null {
  if (AUDIO_CONTENT_TYPES.has(contentType.toLowerCase())) return "audio";
  if (VIDEO_CONTENT_TYPES.has(contentType.toLowerCase())) return "video";
  return null;
}

export function isMediaContentType(contentType: string): boolean {
  return mediaKindForContentType(contentType) !== null;
}

export function maximumMediaBytes(kind: MediaKind): number {
  return kind === "audio" ? BDA_AUDIO_MAX_BYTES : BDA_VIDEO_MAX_BYTES;
}

export function mediaArtifactObjectPrefix(
  repositoryId: number,
  itemVersionId: string,
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("A valid repository id is required");
  }
  if (!/^[0-9a-f-]{36}$/i.test(itemVersionId)) {
    throw new Error("A valid item version id is required");
  }
  return `repositories/${repositoryId}/artifacts/${itemVersionId}/bda/`;
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2])
    throw new Error("BDA returned an invalid S3 URI");
  return { bucket: match[1], key: match[2] };
}

export function processBdaMediaOutput(
  value: unknown,
  expectedModality: MediaKind,
): ProcessedMediaOutput {
  const root = unwrapStandardOutput(value);
  if (!root)
    throw new Error("BDA output does not contain media standard output");
  const metadataObject = nestedObject(root, "metadata");
  const semanticModality =
    metadataObject && asString(metadataObject.semantic_modality)?.toLowerCase();
  if (semanticModality !== expectedModality) {
    throw new Error(
      `BDA returned ${semanticModality ?? "unknown"} output for ${expectedModality}`,
    );
  }

  const metadata = mediaMetadata(root, expectedModality);
  const summary = mediaSummary(root, expectedModality);
  const transcript = findArray(root, "audio_segments")
    .map(parseTimedText)
    .filter((item): item is TimedText => item !== null)
    .sort((left, right) => left.startMs - right.startMs);
  const groupedTranscript = groupTranscript(transcript);
  const topics = expectedModality === "audio" ? parseTopics(root) : [];
  const chapters = expectedModality === "video" ? parseChapters(root) : [];
  const frames =
    expectedModality === "video"
      ? findArray(root, "frames")
          .map(parseFrameText)
          .filter((item): item is TimedText => item !== null)
          .sort((left, right) => left.startMs - right.startMs)
      : [];

  const segments: PublishableSegment[] = [];
  if (summary) {
    addSegment(
      segments,
      summary,
      { timeStartMs: 0, timeEndMs: metadata.durationMs },
      expectedModality,
    );
  }
  for (const topic of topics) {
    addSegment(
      segments,
      `Topic summary: ${topic.text}`,
      locatorFor(topic),
      "audio",
    );
  }
  for (const chapter of chapters) {
    addSegment(
      segments,
      `Chapter summary: ${chapter.text}`,
      locatorFor(chapter),
      "video",
    );
  }
  for (const item of groupedTranscript) {
    const label = labelForTimedText(item);
    addSegment(
      segments,
      `${label ? `${label}: ` : ""}${item.text}`,
      locatorFor(item),
      expectedModality,
    );
  }
  for (const frame of frames) {
    addSegment(
      segments,
      `On-screen text: ${frame.text}`,
      locatorFor(frame),
      "video",
    );
  }
  if (segments.length === 0) {
    addSegment(
      segments,
      `${expectedModality === "audio" ? "Audio" : "Video"} with no detected speech or text`,
      { timeStartMs: 0, timeEndMs: metadata.durationMs },
      expectedModality,
    );
  }

  const transcriptText = transcript.map(transcriptLine).join("\n");
  const sections = [
    `# ${expectedModality === "audio" ? "Audio" : "Video"} analysis`,
    summary ? `## Summary\n\n${summary}` : "",
    topics.length
      ? `## Topics\n\n${topics.map((item) => transcriptLine(item)).join("\n\n")}`
      : "",
    chapters.length
      ? `## Chapters\n\n${chapters.map((item) => transcriptLine(item)).join("\n\n")}`
      : "",
    transcriptText ? `## Transcript\n\n${transcriptText}` : "",
    frames.length
      ? `## On-screen text\n\n${frames.map((item) => transcriptLine(item)).join("\n")}`
      : "",
  ].filter(Boolean);

  return {
    modality: expectedModality,
    canonicalText: sections.join("\n\n"),
    transcriptText,
    summary,
    segments,
    metadata,
  };
}
