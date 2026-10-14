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
 * Do not add a detection pattern here.
 *
 * This is a different detector from `pii-detection-service.ts` on purpose.
 * That one is Amazon Comprehend: ML, confidence-scored, network-bound, and
 * unavailable inside the agent image. This one is four deterministic regexes
 * every runtime can run offline. The two can disagree on the same text (a
 * low-confidence phone number Comprehend drops, the regex always catches) and
 * that is expected — they serve different callers. Only the student-number
 * pattern is shared with Comprehend's custom-pattern list, because Comprehend
 * has no native detector for a district-specific number; it already detects
 * SSNs, emails and phone numbers itself.
 */

import patternFile from "@/lib/safety/personal-data-patterns.json";

export type PersonalDataKind =
  | "psd-student-id"
  | "ssn"
  | "email"
  | "us-phone";

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

const COMPILED: ReadonlyArray<{ kind: PersonalDataKind; pattern: RegExp }> =
  patternFile.patterns.map((raw) => ({
    kind: assertKind(raw.kind),
    // Patterns come only from the versioned, source-controlled policy file —
    // same arrangement as lib/agent-workspace/path-policy.ts, and the ship
    // test asserts every quantifier in it stays bounded.
    // `matchAll` clones the regex, so a module-level global pattern carries no
    // `lastIndex` state between scans.
    // eslint-disable-next-line security/detect-non-literal-regexp
    pattern: new RegExp(raw.source, "gi"),
  }));

/**
 * The public-file thresholds: how many DISTINCT values of a kind make a file
 * unfit for an unsigned public URL. One contact detail is normal public
 * district content (the school phone number in a flyer footer); two is a
 * contact list. The numbers live in the canonical JSON, not here.
 *
 * The JSON's `narrationMinDistinct` is psd-tts's rule and is read only by the
 * agent image's Python loader — nothing in this app narrates.
 */
const PUBLIC_FILE_MIN_DISTINCT: Readonly<Record<string, number>> =
  patternFile.publicFileMinDistinct;

/**
 * The canonical PSD student-number pattern, for callers that need the regex
 * itself rather than a scan (see `lib/safety/types.ts`). Non-global so it
 * behaves like a plain `.test()` pattern.
 */
export const PSD_STUDENT_ID_PATTERN: RegExp = (() => {
  const raw = patternFile.patterns.find(
    (entry) => entry.kind === "psd-student-id"
  );
  if (!raw) {
    throw new Error("Pattern file has no psd-student-id pattern");
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- versioned policy file, see above
  return new RegExp(raw.source);
})();

/**
 * The value a match counts as when deciding how many DISTINCT ones a file
 * holds. Phone numbers are reduced to their ten digits: the pattern file has a
 * country-code form (`1-253-530-1000`) and a bare form (`253-530-1000`), and
 * both match the one number, so comparing the matched text would count a
 * single flyer-footer number twice and refuse it as a contact list.
 */
function distinctValue(kind: PersonalDataKind, matched: string): string {
  if (kind !== "us-phone") return matched.toLowerCase();
  const digits = matched.replace(/\D/g, "");
  return digits.length === 11 ? digits.slice(1) : digits;
}

/**
 * How many DISTINCT values of each kind the text contains.
 *
 * Distinct rather than total: a flyer that repeats the same school phone
 * number in a header and a footer is still one phone number, while a
 * substitute call list of ten different numbers is ten.
 */
function countDistinctPersonalData(
  text: string
): Map<PersonalDataKind, number> {
  const byKind = new Map<PersonalDataKind, Set<string>>();
  for (const { kind, pattern } of COMPILED) {
    for (const match of text.matchAll(pattern)) {
      const value = distinctValue(kind, match[0]);
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
 * The kinds of personal data that make this text unfit for a public link,
 * sorted for a stable message. Empty means "nothing found that the public-file
 * rule refuses" — never the values themselves, which must not be logged or
 * returned.
 */
export function detectPersonalDataKinds(text: string): PersonalDataKind[] {
  const counts = countDistinctPersonalData(text);
  return [...counts]
    .filter(([kind, distinct]) => {
      const minimum = PUBLIC_FILE_MIN_DISTINCT[kind];
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
 * Narrower than the broker's `PUBLIC_EXTENSIONS`: raster images, video and
 * audio are out of scope for #1886. `.svg` is in, although the issue's list
 * left it out: it is an image only once rendered — on disk it is plain XML,
 * and a `<text>` element can carry a roster as easily as a CSV can. The
 * psd-publish-file SKILL.md restates this list, and a ship test keeps the two
 * in step. The pairing is checked against the content type as well as the
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
  [".svg", { contentType: "image/svg+xml", extraction: "utf8" }],
]);

/** The extensions whose contents the public-link check reads, sorted. */
export const TEXT_EXTRACTABLE_EXTENSIONS: readonly string[] = [
  ...TEXT_EXTRACTABLE.keys(),
].sort();

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
  const declared = contentType.split(";")[0].trim().toLowerCase();
  return declared === known.contentType ? known.extraction : null;
}
