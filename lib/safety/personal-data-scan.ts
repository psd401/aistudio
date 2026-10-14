/**
 * Personal-data detection over text, from the canonical pattern file.
 *
 * Issue #1886: public links were the one real privacy problem in a read of 375
 * staff members' agent use — seating charts with grades, per-student test score
 * tables, roster CSVs and substitute contact lists all reached
 * anyone-with-the-link URLs because nothing looked at the contents before the
 * link was minted.
 *
 * This module is pure: text in, matched kinds out. It holds no S3, no PDF
 * parser and no I/O, so it is cheap to unit test and safe to import from
 * anywhere. Byte-level extraction for public uploads lives in
 * `lib/agent-workspace/public-artifact-personal-data.ts`.
 *
 * The regexes themselves live in `personal-data-patterns.json` and are written
 * exactly once; the agent image's JS and Python loaders read that same file.
 * Do not add a regex here.
 */

import patternFile from "@/lib/safety/personal-data-patterns.json";

export type PersonalDataKind =
  | "psd-student-id"
  | "ssn"
  | "email"
  | "us-phone";

/**
 * Which rule set to apply.
 *
 * - `public-file`: a text-extractable file about to get an unsigned public URL.
 *   One contact detail is normal public district content (the school phone
 *   number in a flyer footer); two is a contact list.
 * - `narration`: text about to be synthesised into a public-by-link MP3 with no
 *   expiry. Refuses on the first match of anything.
 *
 * The thresholds for both live in the canonical JSON, not here.
 */
export type PersonalDataPolicy = "public-file" | "narration";

type RawPattern = { kind: string; source: string; description: string };

const KINDS: readonly PersonalDataKind[] = [
  "psd-student-id",
  "ssn",
  "email",
  "us-phone",
];

function assertKind(kind: string): PersonalDataKind {
  const known = KINDS.find((candidate) => candidate === kind);
  if (!known) {
    throw new Error(`Unknown personal-data kind in pattern file: ${kind}`);
  }
  return known;
}

const COMPILED: ReadonlyArray<{ kind: PersonalDataKind; pattern: RegExp }> = (
  patternFile.patterns as RawPattern[]
).map((raw) => ({
  kind: assertKind(raw.kind),
  // Patterns come only from the versioned, source-controlled policy file —
  // same arrangement as lib/agent-workspace/path-policy.ts, and the ship test
  // asserts every quantifier in it stays bounded.
  // `matchAll` clones the regex, so a module-level global pattern carries no
  // `lastIndex` state between scans.
  // eslint-disable-next-line security/detect-non-literal-regexp
  pattern: new RegExp(raw.source, "gi"),
}));

function thresholds(
  policy: PersonalDataPolicy
): Readonly<Record<string, number>> {
  return policy === "narration"
    ? patternFile.narrationMinDistinct
    : patternFile.publicFileMinDistinct;
}

/**
 * The canonical PSD student-number pattern, for callers that need the regex
 * itself rather than a scan (see `lib/safety/types.ts`). Non-global so it
 * behaves like a plain `.test()` pattern.
 */
// eslint-disable-next-line security/detect-non-literal-regexp -- versioned policy file, see above
export const PSD_STUDENT_ID_PATTERN: RegExp = new RegExp(
  (patternFile.patterns as RawPattern[]).find(
    (raw) => raw.kind === "psd-student-id"
  )!.source
);

/**
 * How many DISTINCT values of each kind the text contains.
 *
 * Distinct rather than total: a flyer that repeats the same school phone
 * number in a header and a footer is still one phone number, while a
 * substitute call list of ten different numbers is ten.
 */
export function countDistinctPersonalData(
  text: string
): Map<PersonalDataKind, number> {
  const byKind = new Map<PersonalDataKind, Set<string>>();
  for (const { kind, pattern } of COMPILED) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].toLowerCase();
      const seen = byKind.get(kind);
      if (seen) seen.add(value);
      else byKind.set(kind, new Set([value]));
    }
  }
  return new Map(
    [...byKind].map(([kind, values]) => [kind, values.size])
  );
}

/**
 * The kinds of personal data that make this text unfit for the given surface,
 * sorted for a stable message. Empty means "nothing found that this policy
 * refuses" — never the values themselves, which must not be logged or returned.
 */
export function detectPersonalDataKinds(
  text: string,
  policy: PersonalDataPolicy
): PersonalDataKind[] {
  const minimums = thresholds(policy);
  const counts = countDistinctPersonalData(text);
  return [...counts]
    .filter(([kind, distinct]) => {
      const minimum = minimums[kind];
      return typeof minimum === "number" && distinct >= minimum;
    })
    .map(([kind]) => kind)
    .sort();
}

/** How a public upload's bytes become text, or `null` if they cannot. */
export type TextExtraction = "utf8" | "pdf";

/**
 * The publishable types whose contents a text check can actually read.
 *
 * Deliberately narrower than the broker's `PUBLIC_EXTENSIONS`: images, video
 * and audio are out of scope for #1886, and `.svg` is an image by the issue's
 * own wording. The pairing is checked against the content type as well as the
 * extension, because the broker already enforces that the two agree — a
 * mismatch here means something changed and the scan should not guess.
 */
const TEXT_EXTRACTABLE: ReadonlyMap<
  string,
  { contentType: string; extraction: TextExtraction }
> = new Map([
  [".csv", { contentType: "text/csv", extraction: "utf8" }],
  [".json", { contentType: "application/json", extraction: "utf8" }],
  [".md", { contentType: "text/markdown", extraction: "utf8" }],
  [".txt", { contentType: "text/plain", extraction: "utf8" }],
  [".pdf", { contentType: "application/pdf", extraction: "pdf" }],
]);

/**
 * How to read this upload as text, or `null` when its contents are not
 * text-extractable and it passes unchecked (an image, audio, video).
 */
export function textExtractionFor(
  fileName: string,
  contentType: string
): TextExtraction | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const known = TEXT_EXTRACTABLE.get(fileName.slice(dot).toLowerCase());
  if (!known) return null;
  const declared = contentType.split(";")[0]!.trim().toLowerCase();
  return declared === known.contentType ? known.extraction : null;
}
