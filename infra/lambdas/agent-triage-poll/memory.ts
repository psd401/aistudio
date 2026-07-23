/**
 * Pull the user's MEMORY.md from their S3 workspace and extract the
 * "Email Triage" section. The Lambda passes that section verbatim into
 * the AgentCore prompt so the agent uses the user's own task-creation
 * instructions instead of guessing from its loaded skills.
 *
 * Why this lives in the Lambda (and not "let the agent read it"):
 * the agent's behavior around MEMORY.md is inconsistent — sometimes it
 * reads it, sometimes it falls back to whatever skill is loaded (which
 * was creating Google Tasks for hagelk despite Life OS being the user's
 * configured system). Reading the relevant section here and embedding
 * it in the prompt makes the user's intent inescapable.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const BUCKET = process.env.WORKSPACE_BUCKET ?? "";

let s3Client: S3Client | null = null;
function s3(): S3Client {
  if (!s3Client) s3Client = new S3Client({ region: REGION });
  return s3Client;
}

interface CacheEntry {
  section: string | null;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Heading patterns the user can use to mark the section. Match any of
 * these (case-insensitive) — we want to be tolerant of slight wording
 * differences across users.
 */
const SECTION_HEADERS = [
  /^#{1,4}\s*email\s*triage\s*→\s*(?:life\s*os\s*)?task\s*creation/i,
  /^#{1,4}\s*email\s*triage\s*->.*task\s*creation/i,
  /^#{1,4}\s*email\s*triage\s+task\s+creation/i,
  /^#{1,4}\s*psd-email-triage\s+task\s+request/i,
  /^#{1,4}\s*task\s+creation\s+from\s+email/i,
];

/**
 * Fetch the user's MEMORY.md and return the "Email Triage" section's
 * body (everything from the matching heading until the next heading of
 * equal-or-lower depth, exclusive of headings themselves).
 *
 * Returns null if:
 *   - WORKSPACE_BUCKET env var isn't set (deploy misconfig)
 *   - workspacePrefix is empty
 *   - MEMORY.md doesn't exist
 *   - No matching section heading found
 *
 * Caller treats null as "user hasn't configured task instructions" and
 * surfaces a clear FAILED reason instead of letting the agent guess.
 */
export async function fetchTaskInstructions(
  workspacePrefix: string,
): Promise<string | null> {
  if (!BUCKET || !workspacePrefix) return null;

  const cached = cache.get(workspacePrefix);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.section;
  }

  let body: string;
  try {
    const resp = await s3().send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `${workspacePrefix}/MEMORY.md`,
      }),
    );
    if (!resp.Body) {
      cache.set(workspacePrefix, { section: null, fetchedAt: Date.now() });
      return null;
    }
    body = await resp.Body.transformToString();
  } catch {
    cache.set(workspacePrefix, { section: null, fetchedAt: Date.now() });
    return null;
  }

  const section = extractSection(body);
  cache.set(workspacePrefix, { section, fetchedAt: Date.now() });
  return section;
}

export function extractSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let startIdx = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of SECTION_HEADERS) {
      if (pat.test(line)) {
        startIdx = i + 1;
        startDepth = (line.match(/^#+/) ?? [""])[0].length;
        break;
      }
    }
    if (startIdx >= 0) break;
  }
  if (startIdx < 0) return null;

  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= startDepth) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n").trim() || null;
}
