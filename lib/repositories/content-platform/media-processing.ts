import { createHash } from "node:crypto";
import type {
  RepositorySourceLocator,
  RepositorySourceRegion,
} from "@/lib/db/schema";
import type { PublishableSegment } from "./publication-service";
import { countRepositoryTokens } from "./token-segmentation";

export const MEDIA_PROCESSOR_VERSION = "aistudio-media-bda-v2";
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

  for (const candidate of standardOutputCandidates(object)) {
    const unwrapped = unwrapStandardOutput(candidate, depth + 1);
    if (unwrapped) return unwrapped;
  }
  return null;
}

function standardOutputCandidates(object: JsonObject): unknown[] {
  const candidates: unknown[] = [];
  const standardOutput = object.standardOutput ?? object.standard_output;
  if (asObject(standardOutput)) candidates.push(standardOutput);
  if (Array.isArray(object.outputSegments)) {
    candidates.push(...object.outputSegments);
  }
  for (const child of Object.values(object)) {
    if (!Array.isArray(child)) candidates.push(child);
  }
  return candidates;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  options: {
    segments: PublishableSegment[];
    content: string;
    sourceLocator: RepositorySourceLocator;
    modality: MediaKind;
    segmentLevel?: "document" | "section" | "chunk";
    parentChunkIndex?: number;
  }
): void {
  const {
    segments,
    content,
    sourceLocator,
    modality,
    segmentLevel = "chunk",
    parentChunkIndex,
  } = options;
  const normalized = content.trim();
  if (!normalized) return;
  segments.push({
    content: normalized,
    contentHash: contentHash(normalized),
    chunkIndex: segments.length,
    tokens: countRepositoryTokens(normalized),
    sourceLocator,
    modality,
    contextPrefix: `${modality === "audio" ? "Audio" : "Video"} ${Math.floor(
      (sourceLocator.timeStartMs ?? 0) / 1000
    )}s`,
    segmentLevel,
    parentChunkIndex,
  });
}

function parentForTime(
  segments: PublishableSegment[],
  startMs: number
): number | undefined {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = segments[index];
    if (!candidate || candidate.segmentLevel === "chunk") continue;
    const start = candidate.sourceLocator.timeStartMs ?? 0;
    const end = candidate.sourceLocator.timeEndMs ?? Number.MAX_SAFE_INTEGER;
    if (startMs >= start && startMs <= end) return candidate.chunkIndex;
  }
  return segments[0]?.chunkIndex;
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
  const root = requireMediaStandardOutput(value, expectedModality);
  const metadata = mediaMetadata(root, expectedModality);
  const summary = mediaSummary(root, expectedModality);
  const transcript = sortedTimedText(root, "audio_segments", parseTimedText);
  const groupedTranscript = groupTranscript(transcript);
  const topics = expectedModality === "audio" ? parseTopics(root) : [];
  const chapters = expectedModality === "video" ? parseChapters(root) : [];
  const frames =
    expectedModality === "video"
      ? sortedTimedText(root, "frames", parseFrameText)
      : [];
  const segments = buildMediaSegments({
    expectedModality,
    metadata,
    summary,
    topics,
    chapters,
    groupedTranscript,
    frames,
  });

  const transcriptText = transcript.map(transcriptLine).join("\n");
  const canonicalText = buildCanonicalMediaText({
    expectedModality,
    summary,
    topics,
    chapters,
    transcriptText,
    frames,
  });

  return {
    modality: expectedModality,
    canonicalText,
    transcriptText,
    summary,
    segments,
    metadata,
  };
}

function requireMediaStandardOutput(
  value: unknown,
  expectedModality: MediaKind,
): JsonObject {
  const root = unwrapStandardOutput(value);
  if (!root) {
    throw new Error("BDA output does not contain media standard output");
  }
  const metadataObject = nestedObject(root, "metadata");
  const semanticModality =
    metadataObject && asString(metadataObject.semantic_modality)?.toLowerCase();
  if (semanticModality !== expectedModality) {
    throw new Error(
      `BDA returned ${semanticModality ?? "unknown"} output for ${expectedModality}`,
    );
  }
  return root;
}

function sortedTimedText(
  root: JsonObject,
  key: string,
  parser: (value: unknown) => TimedText | null,
): TimedText[] {
  return findArray(root, key)
    .map(parser)
    .filter((item): item is TimedText => item !== null)
    .sort((left, right) => left.startMs - right.startMs);
}

interface MediaSegmentInput {
  expectedModality: MediaKind;
  metadata: MediaMetadata;
  summary?: string;
  topics: TimedText[];
  chapters: TimedText[];
  groupedTranscript: TimedText[];
  frames: TimedText[];
}

function buildMediaSegments(input: MediaSegmentInput): PublishableSegment[] {
  const segments: PublishableSegment[] = [];
  addMediaSummarySegment(segments, input);
  addMediaSectionSegments(segments, input.topics, "audio", "Topic summary");
  addMediaSectionSegments(segments, input.chapters, "video", "Chapter summary");
  addTranscriptSegments(segments, input.groupedTranscript, input.expectedModality);
  addFrameSegments(segments, input.frames);
  if (segments.length === 0) addEmptyMediaSegment(segments, input);
  return segments;
}

function addMediaSummarySegment(
  segments: PublishableSegment[],
  input: MediaSegmentInput,
): void {
  if (!input.summary) return;
  addSegment({
    segments,
    content: input.summary,
    sourceLocator: { timeStartMs: 0, timeEndMs: input.metadata.durationMs },
    modality: input.expectedModality,
    segmentLevel: "document",
  });
}

function addMediaSectionSegments(
  segments: PublishableSegment[],
  items: TimedText[],
  modality: MediaKind,
  prefix: string,
): void {
  for (const item of items) {
    addSegment({
      segments,
      content: `${prefix}: ${item.text}`,
      sourceLocator: locatorFor(item),
      modality,
      segmentLevel: "section",
      parentChunkIndex: segments[0]?.chunkIndex,
    });
  }
}

function addTranscriptSegments(
  segments: PublishableSegment[],
  items: TimedText[],
  modality: MediaKind,
): void {
  for (const item of items) {
    const label = labelForTimedText(item);
    addSegment({
      segments,
      content: `${label ? `${label}: ` : ""}${item.text}`,
      sourceLocator: locatorFor(item),
      modality,
      segmentLevel: "chunk",
      parentChunkIndex: parentForTime(segments, item.startMs),
    });
  }
}

function addFrameSegments(
  segments: PublishableSegment[],
  frames: TimedText[],
): void {
  for (const frame of frames) {
    addSegment({
      segments,
      content: `On-screen text: ${frame.text}`,
      sourceLocator: locatorFor(frame),
      modality: "video",
      segmentLevel: "chunk",
      parentChunkIndex: parentForTime(segments, frame.startMs),
    });
  }
}

function addEmptyMediaSegment(
  segments: PublishableSegment[],
  input: MediaSegmentInput,
): void {
  const label = input.expectedModality === "audio" ? "Audio" : "Video";
  addSegment({
    segments,
    content: `${label} with no detected speech or text`,
    sourceLocator: { timeStartMs: 0, timeEndMs: input.metadata.durationMs },
    modality: input.expectedModality,
    segmentLevel: "document",
  });
}

interface CanonicalMediaTextInput {
  expectedModality: MediaKind;
  summary?: string;
  topics: TimedText[];
  chapters: TimedText[];
  transcriptText: string;
  frames: TimedText[];
}

function buildCanonicalMediaText(input: CanonicalMediaTextInput): string {
  const sections = [
    `# ${input.expectedModality === "audio" ? "Audio" : "Video"} analysis`,
    input.summary ? `## Summary\n\n${input.summary}` : "",
    timedTextSection("Topics", input.topics, "\n\n"),
    timedTextSection("Chapters", input.chapters, "\n\n"),
    input.transcriptText ? `## Transcript\n\n${input.transcriptText}` : "",
    timedTextSection("On-screen text", input.frames, "\n"),
  ].filter(Boolean);
  return sections.join("\n\n");
}

function timedTextSection(
  heading: string,
  items: TimedText[],
  separator: string,
): string {
  return items.length > 0
    ? `## ${heading}\n\n${items.map(transcriptLine).join(separator)}`
    : "";
}
