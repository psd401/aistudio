/**
 * Shared helpers for the psd-workspace OpenClaw skill (#912).
 *
 * Environment contract (set in agent-platform-stack.ts):
 *   AWS_REGION                         — e.g. us-east-1
 *   ENVIRONMENT                        — dev/staging/prod
 */

'use strict';

const fs = require('node:fs');
const APP_BASE_URL = process.env.APP_BASE_URL || '';

// Strict email regex — must stay in sync with lib/agent-workspace/validation.ts.
// The email is interpolated into a Secrets Manager path, so we reject anything
// beyond alphanumeric + common email chars to prevent path manipulation.
const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;

function fail(message, code = 1) {
  process.stderr.write(`psd-workspace: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  if (!SAFE_EMAIL_RE.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}


/**
 * Parse --command into argv-style tokens. Supports single-quoted segments so
 * users can pass flags like `--query 'is:unread'`. Not a full shell parser.
 */
function splitCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return [];
  const tokens = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

// ============================================================================
// Payload files — safe transport for arbitrary text (#1138 follow-up)
// ============================================================================
//
// splitCommand supports quoted segments but has NO escape syntax: a quote
// character inside a same-quoted value terminates the token, so any content
// with an apostrophe, mixed quotes, or newlines (i.e. real document text)
// cannot ride inside --command at all. Observed live 2026-07-06: the agent
// could not write Google Doc content ("no way to pass multi-word text via
// this shim") and the task died. The fix: the model writes the content to a
// file and references it with `--json-file <abs-path>` (JSON payloads) or
// `--body-file <abs-path>` (plain-text bodies, e.g. +draft). The file's
// content is delivered to gws as exactly ONE argv token — quoting rules
// never apply to it.
//
// Ordering contract (see run.js): the resolved JSON is inlined into a
// synthetic command string FIRST so Phase 1 gates (incl. the share-to-caller
// payload validation) and marker injection see the real payload; execution
// then swaps a whitespace-free placeholder token for the payload AFTER
// splitCommand, so tokenization never touches the content.

const PAYLOAD_PLACEHOLDERS = {
  '--json-file': { flag: '--json', placeholder: '@@PSD_PAYLOAD_JSON@@', kind: 'json' },
  '--body-file': { flag: '--body', placeholder: '@@PSD_PAYLOAD_BODY@@', kind: 'text' },
  // chat +send message text. Added after the live 2026-07-07 run: the agent
  // GUESSED `--text-file` while fumbling +send syntax against the clock —
  // it's the natural generalization of the two flags above, so make it real.
  '--text-file': { flag: '--text', placeholder: '@@PSD_PAYLOAD_TEXT@@', kind: 'text' },
};

/**
 * Resolve `--json-file` / `--body-file` references in a --command string.
 *
 * Returns null when neither flag is present. Otherwise returns:
 *   {
 *     execCommand:      command with each file flag replaced by
 *                       `--json @@PSD_PAYLOAD_JSON@@` / `--body @@…@@`,
 *     syntheticCommand: command with each file flag replaced by the REAL
 *                       content inline (gates + markers run against this),
 *     payloads:         { [placeholderToken]: content }
 *   }
 *
 * Fails (exit 1) on: relative path, unreadable file, invalid JSON in a
 * --json-file, duplicate use of the same flag, or --json-file alongside an
 * inline --json (ambiguous — exactly one payload source allowed).
 */
function resolvePayloadFiles(commandString) {
  if (!commandString || typeof commandString !== 'string') return null;
  let execCommand = commandString;
  let syntheticCommand = commandString;
  const payloads = {};

  for (const [fileFlag, spec] of Object.entries(PAYLOAD_PLACEHOLDERS)) {
    const re = new RegExp(`(^|\\s)${fileFlag}\\s+(\\S+)`, 'g');
    const matches = [...commandString.matchAll(re)];
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      fail(`${fileFlag} may appear at most once per command`);
    }
    // Exactly one payload source per flag: reject the file form alongside its
    // inline counterpart (--json + --json-file, --body + --body-file) —
    // otherwise gws would receive two occurrences of the same flag and pick
    // one silently. `--json\s` does not match `--json-file` (hyphen, not
    // whitespace, follows), so the file flag never trips its own check.
    const inlineRe = new RegExp(`(^|\\s)${spec.flag}\\s`);
    if (inlineRe.test(commandString)) {
      fail(`use either ${spec.flag} or ${fileFlag}, not both`);
    }
    let filePath = matches[0][2];
    // Models habitually quote flag values (every SKILL.md example quotes
    // --params). \S+ captures those quotes, so strip one matching
    // surrounding pair before validating — otherwise a valid quoted path
    // fails the absolute-path check with a misleading error.
    if (
      filePath.length >= 2 &&
      ((filePath.startsWith("'") && filePath.endsWith("'")) ||
        (filePath.startsWith('"') && filePath.endsWith('"')))
    ) {
      filePath = filePath.slice(1, -1);
    }
    if (!filePath.startsWith('/')) {
      fail(`${fileFlag} requires an absolute path (got "${filePath}")`);
    }
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      fail(`${fileFlag}: cannot read ${filePath}: ${err.message}`);
    }
    if (spec.kind === 'json') {
      try {
        // Minify so the synthetic inline command is single-line — the
        // marker injector's brace scanner and the gate regexes both operate
        // on it, and a compact form keeps their behavior identical to the
        // inline --json path.
        content = JSON.stringify(JSON.parse(content));
      } catch (err) {
        fail(`${fileFlag}: ${filePath} is not valid JSON: ${err.message}`);
      }
    }
    payloads[spec.placeholder] = content;
    execCommand = execCommand.replace(
      re,
      (m, lead) => `${lead}${spec.flag} ${spec.placeholder}`
    );
    syntheticCommand = syntheticCommand.replace(
      re,
      (m, lead) => `${lead}${spec.flag} ${content}`
    );
  }

  return Object.keys(payloads).length > 0
    ? { execCommand, syntheticCommand, payloads }
    : null;
}

/**
 * Return the value of the `--json` argument from an argv token array — i.e. the
 * exact string gws receives (quotes already stripped by splitCommand). Returns
 * null if there is no `--json` flag with a following value. Security-sensitive
 * consumers (the Phase 1 gate exception) MUST read the payload from here rather
 * than re-scanning the raw command string, so what is inspected is identical to
 * what executes. (The string-based `extractJsonArg` below serves the
 * payload-file flow, which operates on the pre-tokenized command.)
 */
function extractJsonArgFromTokens(tokens) {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === '--json') return tokens[i + 1];
  }
  return null;
}

/**
 * Exec gws with GOOGLE_WORKSPACE_CLI_TOKEN set. Streams stdout; returns exit
 * code. gws ignores GOOGLE_ACCESS_TOKEN — must be GOOGLE_WORKSPACE_CLI_TOKEN
 * per the gws README "Pre-obtained Access Token" section.
 *
 * `payloads` (optional) maps placeholder tokens to payload-file contents
 * (see resolvePayloadFiles). Substitution happens AFTER splitCommand, so the
 * content becomes exactly one argv token regardless of quotes/newlines.
 */

// ============================================================================
// Phase 1 hard gates (#912 Phase 1)
// ============================================================================
//
// These are the operations the skill refuses regardless of how the model
// phrases the gws command. The model cannot bypass them with prompt creativity,
// scope changes, or alternate spellings — the gate is a regex match on the
// argv-tokenized command before exec.
//
// Phase 1 product policy:
//   - No sending mail (drafts only — user must hit send themselves).
//     Note: the OAuth grant on the user_account scope is now gmail.modify
//     (upgraded from gmail.compose) so the agent can archive/label on the
//     user's behalf. gmail.modify ALSO carries send capability at the API
//     level, so the regex below is now the sole barrier against the agent
//     actually putting a message on the wire. Treat this list as load-bearing.
//   - No deleting anything (mail, events, files, tasks)
//   - Archive / label-modify allowed via gmail.users.messages.modify;
//     trashing / permanent delete still blocked below.
//
// Each entry: {pattern: regex, reason: human-readable explanation}.
// `pattern` matches against the SPACE-JOINED argv tokens, lowercased — so
// `gws gmail users messages send` and `gws gmail.users.messages.send` both
// trigger the same rule.
// Operations forbidden ONLY on the user OAuth slot (scope === 'user_account').
//
// Added 2026-07-07 (Hagel, #1138): the agent recreated documents OWNED BY THE
// USER's account to route around the sharing gate ("do not create documents
// as my account, that's a huge hole security-wise"). File creation as the
// user is impersonation — every artifact must be owned by the agent identity
// (auditable, gate-enforced sharing) and shared explicitly via
// isPermittedExplicitShare. Drafts/calendar/tasks on the user slot remain
// allowed: they are marker-stamped, land in review surfaces (Drafts folder,
// own calendar), and were explicitly designed as user-slot writes.
//
// Refined 2026-07-25 (#1305): the user slot now also holds drive.readonly +
// drive.metadata so the agent can READ and ORGANIZE the user's Drive. The
// impersonated-CREATION ban is untouched — with one deliberate exception,
// creating a FOLDER, which is an organizing act and carries no content. See
// isPermittedFolderCreate below.
const USER_SCOPE_FORBIDDEN = [
  // `copy` is unconditional: a copy always produces a content-bearing file.
  { pattern: /\bdrive[\s.]+files[\s.]+copy\b/i,
    reason: 'copying a file into the user\'s Drive — the copy would be owned by the user (create as the agent and share explicitly instead)' },
  // `create` has exactly ONE exception — mimeType application/vnd.google-apps.folder
  // (isPermittedFolderCreate). Everything else still refuses here.
  { pattern: /\bdrive[\s.]+files[\s.]+create\b/i,
    exception: isPermittedFolderCreate,
    reason: 'creating files owned by the user (only folders may be created on this slot; create documents as the agent and share explicitly instead)' },
  // `update` is newly reachable across the user's whole Drive now that
  // drive.metadata is granted, so it needs a gate it never needed under
  // drive.file. Allowed ONLY for metadata-field writes
  // (isMetadataOnlyDriveUpdate): rename, move, star. Content/media uploads and
  // `trashed` are refused. Google also rejects content writes under
  // readonly+metadata+file, so this is belt-and-suspenders — its real value is
  // a comprehensible error instead of an opaque 403.
  { pattern: /\bdrive[\s.]+files[\s.]+update\b/i,
    exception: isMetadataOnlyDriveUpdate,
    reason: 'writing file content or trashing in the user\'s Drive (this slot may only change metadata: rename, move, star, describe)' },
  { pattern: /\bdocs[\s.]+documents[\s.]+create\b/i,
    reason: 'creating a Google Doc owned by the user (create as the agent and share explicitly instead)' },
  { pattern: /\bsheets[\s.]+spreadsheets[\s.]+create\b/i,
    reason: 'creating a Google Sheet owned by the user (create as the agent and share explicitly instead)' },
  { pattern: /\bslides[\s.]+presentations[\s.]+create\b/i,
    reason: 'creating a Google Slides deck owned by the user (create as the agent and share explicitly instead)' },
];

const PROVENANCE_REQUIRED = [
  { pattern: /\bcalendar[\s.]+events[\s.]+(patch|update)\b/i,
    reason: 'calendar updates require server-recorded agent-created provenance' },
  { pattern: /\btasks[\s.]+tasks[\s.]+(patch|update)\b/i,
    reason: 'task updates require server-recorded agent-created provenance' },
  { pattern: /\bdocs[\s.]+documents[\s.]+batchupdate\b/i,
    reason: 'document mutations require server-recorded agent-created provenance' },
  { pattern: /\bsheets[\s.]+spreadsheets[\s.]+batchupdate\b/i,
    reason: 'spreadsheet mutations require server-recorded agent-created provenance' },
  { pattern: /\bslides[\s.]+presentations[\s.]+batchupdate\b/i,
    reason: 'presentation mutations require server-recorded agent-created provenance' },
  { pattern: /\bdrive[\s.]+permissions[\s.]+create\b/i,
    reason: 'permission creation requires server-recorded agent-created provenance' },
];

const PHASE1_FORBIDDEN = [
  // Send mail — any path that puts a message on the wire
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+send\b/i,
    reason: 'sending mail (Phase 1: drafts only)' },
  { pattern: /\bgmail[\s.]+users[\s.]+drafts[\s.]+send\b/i,
    reason: 'sending a draft (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?send\b/i,
    reason: 'sending mail via the +send helper (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?reply\b/i,
    reason: 'replying via the +reply helper (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?reply-all\b/i,
    reason: 'replying-all via the helper (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?forward\b/i,
    reason: 'forwarding via the helper (Phase 1: drafts only)' },

  // Delete mail / events / files
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+delete\b/i,
    reason: 'permanently deleting mail (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+trash\b/i,
    reason: 'trashing mail (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+batchDelete\b/i,
    reason: 'batch-deleting mail (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+drafts[\s.]+delete\b/i,
    reason: 'deleting a draft (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+threads[\s.]+(delete|trash)\b/i,
    reason: 'deleting/trashing a thread (Phase 1: never destructive)' },
  { pattern: /\bcalendar[\s.]+events[\s.]+delete\b/i,
    reason: 'deleting calendar events (Phase 1: never destructive)' },
  { pattern: /\bcalendar[\s.]+calendars[\s.]+delete\b/i,
    reason: 'deleting a calendar (Phase 1: never destructive)' },
  { pattern: /\bdrive[\s.]+files[\s.]+delete\b/i,
    reason: 'deleting Drive files (Phase 1: never destructive)' },
  { pattern: /\bdrive[\s.]+files[\s.]+emptyTrash\b/i,
    reason: 'emptying Drive trash (Phase 1: never destructive)' },
  { pattern: /\btasks[\s.]+tasks[\s.]+delete\b/i,
    reason: 'deleting tasks (Phase 1: never destructive)' },
  { pattern: /\btasks[\s.]+tasklists[\s.]+delete\b/i,
    reason: 'deleting tasklists (Phase 1: never destructive)' },

  // Trashing a Drive file. `files.delete` and `emptyTrash` are blocked above,
  // but trashing travels as a METADATA write — `files update {"trashed":true}`
  // — so it does not match them. Before #1305 the user slot held only
  // drive.file and Google refused this on any file the app had not created;
  // now that drive.metadata is granted it would otherwise become reachable
  // across the user's whole Drive. Blocked on BOTH slots: Phase 1 policy is
  // "never destructive", and `trashed` is also absent from the
  // metadata-update allowlist, so two independent rules have to fail for a
  // trash to get through. This raw-string form is a fast fail only — the
  // authoritative check is detectDriveTrashedWrite on the PARSED payload,
  // which a JSON key escape cannot dodge (codex P1, PR #1346).
  { pattern: /"trashed"\s*:\s*true/i,
    reason: 'trashing a Drive file (Phase 1: never destructive — ask the user to trash it themselves)' },
  { pattern: /\bdrive[\s.]+files[\s.]+untrash\b/i,
    reason: 'untrashing a Drive file (Phase 1: the agent does not manage the trash)' },

  // Sharing externally / changing permissions on user data
  { pattern: /\bdrive[\s.]+permissions[\s.]+(create|update|delete)\b/i,
    reason: 'modifying Drive sharing permissions (Phase 1: no permission changes)' },
];

// ============================================================================
// User-slot Drive: read + organize (#1305)
// ============================================================================
//
// The user slot gained drive.readonly + drive.metadata on 2026-07-25 so the
// agent can read and ORGANIZE the user's Drive. Two narrow exceptions to
// USER_SCOPE_FORBIDDEN implement "organize" without reopening impersonated
// creation:
//
//   isPermittedFolderCreate   — files.create, folder mimeType ONLY
//   isMetadataOnlyDriveUpdate — files.update, metadata fields ONLY
//
// Both are ALLOWLISTS. Anything they cannot positively prove is safe falls
// through to the block, so a payload shape we did not anticipate is refused
// rather than permitted.

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

// Fields on the Drive `files` resource that carry no content and are covered
// by drive.metadata. `trashed` is deliberately absent (see PHASE1_FORBIDDEN),
// and so is anything that could carry bytes.
const DRIVE_METADATA_FIELDS = new Set([
  'name',
  'starred',
  'description',
  'foldercolorrgb',
  'properties',
  'appproperties',
]);

// Flags that would attach a body/media stream to a Drive call. `--json` and
// `--json-file` are the metadata resource and are fine; `--params` carries
// query parameters (fileId, addParents, removeParents, supportsAllDrives) and
// is checked separately for uploadType.
const DRIVE_CONTENT_FLAG = /^--(media|media-file|media-body|upload|upload-file|upload-type|content|content-file|data|data-file|body|body-file|text|text-file|file|source|source-file)$/i;

/**
 * Pull the JSON resource out of a gws command, using the SAME dual extraction
 * as isPermittedExplicitShare: prefer the argv token that actually executes
 * (REV-COR-346 — the gate must see what gws sees), and fall back to the
 * brace-balanced raw-string scan for the payload-file flow, whose synthetic
 * command inlines minified JSON unquoted and so mangles under splitCommand.
 * Returns the parsed object, or null when there is no parseable payload.
 */
function extractDriveResource(commandString, tokens) {
  let payload = null;
  const tokenJson = extractJsonArgFromTokens(tokens);
  if (tokenJson) {
    try { payload = JSON.parse(tokenJson); } catch { payload = null; }
  }
  if (!payload) {
    const rawJson = extractJsonArg(commandString);
    if (!rawJson) return null;
    try { payload = JSON.parse(rawJson); } catch { return null; }
  }
  const resource = payload.resource || payload.requestBody || payload;
  return resource && typeof resource === 'object' && !Array.isArray(resource)
    ? resource
    : null;
}

/** True if any argv token would attach content/media to the call. */
function carriesDriveContent(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (DRIVE_CONTENT_FLAG.test(tokens[i])) return true;
    // `--params '{"uploadType":"media"}'` is a resumable/multipart upload in
    // query-parameter clothing. Checked ONLY in the --params value, not across
    // every token: a file the user asked to rename to "uploadType notes.txt"
    // is a rename, and refusing it would be a false positive.
    if (tokens[i] === '--params' && /uploadtype/i.test(tokens[i + 1] || '')) {
      return true;
    }
  }
  return false;
}

/**
 * ALLOW `drive files create` on the user slot for a FOLDER and nothing else.
 *
 * A folder holds no content, so creating one is an organizing act rather than
 * impersonated authorship — it does not reintroduce the 2026-07-07 hole
 * (#1138: "do not create documents as my account"). It rides the existing
 * drive.file grant, which also means the agent keeps access to the folder it
 * created so it can move files into it afterwards.
 *
 * ALL must hold: the command is files.create; a payload parses; its mimeType
 * is EXACTLY the folder mimeType; and no token attaches content. A create with
 * no parseable payload is refused — absence of proof is not proof of absence.
 */
function isPermittedFolderCreate(commandString, tokens) {
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const createRe = /\bdrive[\s.]+files[\s.]+create\b/i;
  if (!createRe.test(spaceJoined) && !createRe.test(dotJoined)) return false;
  if (carriesDriveContent(tokens)) return false;

  const resource = extractDriveResource(commandString, tokens);
  if (!resource) return false;
  const mimeType = typeof resource.mimeType === 'string'
    ? resource.mimeType.trim().toLowerCase()
    : '';
  return mimeType === DRIVE_FOLDER_MIME;
}

/**
 * ALLOW `drive files update` on the user slot when every field it writes is
 * metadata: rename, move (addParents/removeParents ride --params, not the
 * body), star, describe, recolour.
 *
 * Google enforces this too — neither drive.readonly nor drive.metadata permits
 * a content write, so an upload against a file the agent did not create 403s
 * regardless. The gate exists so the agent gets a comprehensible refusal
 * instead of an opaque 403, and so `trashed` is refused by our own rule as
 * well as by policy.
 *
 * An update with no parseable payload is refused: without a body we cannot
 * prove the call is metadata-only.
 */
function isMetadataOnlyDriveUpdate(commandString, tokens) {
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const updateRe = /\bdrive[\s.]+files[\s.]+update\b/i;
  if (!updateRe.test(spaceJoined) && !updateRe.test(dotJoined)) return false;
  if (carriesDriveContent(tokens)) return false;

  const resource = extractDriveResource(commandString, tokens);
  if (!resource) return false;
  const keys = Object.keys(resource);
  if (keys.length === 0) return false;
  return keys.every((key) => DRIVE_METADATA_FIELDS.has(key.toLowerCase()));
}

/**
 * REFUSE any Drive files write whose PARSED payload carries a `trashed` key.
 *
 * The raw-string PHASE1_FORBIDDEN pattern ('"trashed": true') is kept as a
 * fast fail, but it can be routed around with a JSON string escape in the
 * key — `--json '{"tr\u0061shed":true}'` — which the raw-string regex never
 * matches while gws's JSON.parse decodes it right back to `trashed` and
 * executes the trash (codex P1, PR #1346). The user slot happens to survive
 * that because isMetadataOnlyDriveUpdate judges decoded keys, but the agent
 * slot skips the user-slot allowlists entirely, so the gate must also judge
 * the DECODED resource — same dual extraction the allowlists use.
 *
 * ANY value is refused, not just `true`: `trashed:false` is an untrash, and
 * `files.untrash` is already blocked ("the agent does not manage the trash").
 * Covers update/patch (trash/untrash) and create/copy (pre-trashed spawn).
 * A payload our parse cannot read is not judged here — extractDriveResource
 * uses the same JSON.parse gws does, and the unparseable case dies in gws.
 */
function detectDriveTrashedWrite(commandString, tokens) {
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const driveWriteRe = /\bdrive[\s.]+files[\s.]+(update|patch|create|copy)\b/i;
  if (!driveWriteRe.test(spaceJoined) && !driveWriteRe.test(dotJoined)) return null;
  const resource = extractDriveResource(commandString, tokens);
  if (!resource) return null;
  const hasTrashed = Object.keys(resource).some((k) => k.toLowerCase() === 'trashed');
  return hasTrashed
    ? 'trashing/untrashing a Drive file (Phase 1: never destructive — ask the user to manage the trash themselves)'
    : null;
}

// gws gmail "helper" verbs that put a message on the wire. The `+`-prefixed
// forms are unambiguous (they never appear as a search-query value), so they
// are blocked wherever they appear in the argv. The bare forms (`gmail send`)
// are only blocked in the verb slot immediately after `gmail`, so a legitimate
// `--query 'reply'` search is not falsely refused. (REV-COR-350)
const GMAIL_PLUS_SEND_HELPERS = new Set(['+send', '+reply', '+reply-all', '+forward']);
const GMAIL_BARE_SEND_HELPERS = new Set(['send', 'reply', 'reply-all', 'forward']);
const GMAIL_SEND_HELPER_REASON =
  'sending/replying/forwarding mail via a gmail helper (Phase 1: drafts only)';

/**
 * Detect the gmail send/reply/forward helper forms from argv tokens. These
 * escape the start-anchored PHASE1_FORBIDDEN patterns when the command is
 * prefixed with the `gws` program token or a flag before the verb
 * (`gws gmail +send`, `gmail --to x +send`). Returns a reason string to refuse,
 * or null. Requires a `gmail` token to be present so unrelated commands are
 * unaffected.
 */
function detectGmailSendHelper(tokens) {
  const lower = tokens.map((t) => t.toLowerCase());
  const gmailIdx = lower.indexOf('gmail');
  // `gmail` must be the service name — at index 0, or index 1 after a `gws`
  // program-token prefix. A later occurrence is argument content (e.g. a
  // `--query "gmail send"` value split into bare tokens), not the service
  // selector, and must not be treated as one (gemini-code-assist review).
  if (gmailIdx === -1 || gmailIdx > 1) return null;
  if (lower.some((t) => GMAIL_PLUS_SEND_HELPERS.has(t))) return GMAIL_SEND_HELPER_REASON;
  const verb = lower[gmailIdx + 1];
  if (verb && GMAIL_BARE_SEND_HELPERS.has(verb)) return GMAIL_SEND_HELPER_REASON;
  return null;
}

// District domain for the explicit-share exception. Env-overridable so
// non-prod environments could narrow/redirect it; the default is the only
// domain the platform serves.
const AGENT_SHARE_DOMAIN = (process.env.AGENT_SHARE_DOMAIN || 'psd401.net').toLowerCase();

/**
 * Exception to the `drive.permissions.create` block: the agent may grant
 * EXPLICIT, bounded permissions on files it owns (scope === 'agent_account').
 *
 * Rationale: the agent stores artifacts it creates (reports, generated docs,
 * meeting summaries) on its own agent_account Drive. Originally it could
 * share them only back to the CALLER; product decision 2026-07-07 (Hagel,
 * #1138 — team docs must land in shared Chat spaces) widened this to
 * in-district sharing with explicit grants.
 *
 * Hard constraints (ALL must be true to allow):
 *   - context.scope is 'agent_account'  (sharing FROM the agent's own Drive;
 *     permission changes on user-owned files remain fully blocked)
 *   - create only (update/delete remain blocked)
 *   - EITHER type === 'user' with an @psd401.net emailAddress,
 *     role ∈ {reader, commenter, writer} (writer added 2026-07-08, Hagel:
 *     explicitly NAMED district individuals may edit agent-owned docs —
 *     team collaboration on posted docs)
 *   - OR     type === 'domain' with domain === psd401.net, role === 'reader'
 *     (broad in-district visibility for docs posted to shared spaces;
 *     domain-wide stays read-only — district-wide edit is vandalism surface)
 *   - NEVER: type 'anyone' or 'group', external addresses/domains,
 *     owner transfer.
 *
 * Returns true if the share request fits the explicit in-district shape;
 * false otherwise. False means fall through to the existing block.
 */
function isPermittedExplicitShare(commandString, tokens, context) {
  if (!context || context.scope !== 'agent_account' || !context.ownerEmail) {
    return false;
  }
  // Must be the create variant — update/delete remain blocked. Match against
  // the executed tokenization (REV-COR-346), not the raw string.
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const createRe = /\bdrive[\s.]+permissions[\s.]+create\b/i;
  if (!createRe.test(spaceJoined) && !createRe.test(dotJoined)) {
    return false;
  }

  // Read the --json payload from the argv token that actually executes, so the
  // exception cannot be granted on a benign-looking payload that differs from
  // what gws receives (REV-COR-346). The payload-file flow's synthetic command
  // inlines minified JSON UNQUOTED, which splitCommand's quote handling mangles
  // (the embedded `"` toggle quote state) — for that flow fall back to the
  // brace-balanced raw-string scan. The fallback only fires when the executed
  // token is not itself valid JSON, in which case gws rejects the payload
  // rather than executing a diverging one.
  let payload = null;
  const tokenJson = extractJsonArgFromTokens(tokens);
  if (tokenJson) {
    try {
      payload = JSON.parse(tokenJson);
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    const rawJson = extractJsonArg(commandString);
    if (!rawJson) return false;
    try {
      payload = JSON.parse(rawJson);
    } catch {
      return false;
    }
  }

  // gws drive permissions create wraps the permission under `resource`,
  // `requestBody`, or accepts the fields at top level depending on the
  // invocation style. Look in all three.
  const perm = payload.resource || payload.requestBody || payload;
  if (!perm || typeof perm !== 'object') return false;

  const type = typeof perm.type === 'string' ? perm.type.toLowerCase() : '';
  const role = typeof perm.role === 'string' ? perm.role.toLowerCase() : '';
  const emailAddress = typeof perm.emailAddress === 'string'
    ? perm.emailAddress.toLowerCase()
    : '';
  const domain = typeof perm.domain === 'string' ? perm.domain.toLowerCase() : '';

  if (type === 'user') {
    // Explicit named recipient — must be in-district. Writer allowed for
    // named individuals (2026-07-08); owner transfer never.
    if (role !== 'reader' && role !== 'commenter' && role !== 'writer') {
      return false;
    }
    return emailAddress.endsWith(`@${AGENT_SHARE_DOMAIN}`);
  }
  if (type === 'domain') {
    // Whole-district visibility (docs linked in shared Chat spaces) —
    // read-only, and ONLY our own domain.
    return role === 'reader' && domain === AGENT_SHARE_DOMAIN;
  }
  // 'anyone', 'group', and everything else stay blocked.
  return false;
}

// ============================================================================
// Lazy scope upgrades (#1305)
// ============================================================================
//
// drive.readonly + drive.metadata were added to the user slot on 2026-07-25.
// Existing refresh tokens keep the scope set they were ISSUED with — Google
// does not retroactively widen them — so a user who has not re-consented since
// then has a token that cannot perform the new Drive read/organize calls. There
// is no forced migration; users upgrade lazily on their next consent click.
//
// WHY THIS IS A PRE-FLIGHT CHECK AND NOT 403 PARSING. The issue asked for
// "missing-scope 403 detection". The skill CANNOT observe such a 403: execGws
// spawns gws with stdio ['ignore', 'inherit', 'inherit'], so gws writes its
// output straight to our stdout/stderr and the skill never sees a byte of it.
// Intercepting would mean buffering every gws response, which would also break
// the streaming behaviour the agent relies on. The token refresh response,
// however, carries the GRANTED scope string — so the gap is detectable one step
// earlier, before the call is even attempted. That is strictly better for the
// user: a re-authorize link instead of a failed operation plus a link.
//
// The result is emitted through the SAME consent-link path as revoked-token
// handling (run.js, invalid_grant -> exit 11), just with its own status and
// exit code so a caller can tell "you never authorized me" from "your
// authorization expired" from "you authorized me before this feature existed".

const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata';

// Commands that only work once the user has re-consented. Deliberately narrow:
// only the operations #1305 introduced. Everything the slot could already do
// keeps working on an old token with no prompt.
const SCOPE_REQUIREMENTS = [
  {
    pattern: /\bdrive[\s.]+files[\s.]+(list|get|export)\b/i,
    scope: DRIVE_READ_SCOPE,
    capability: 'read files in your Drive',
  },
  {
    pattern: /\bdrive[\s.]+(about|changes)[\s.]+/i,
    scope: DRIVE_READ_SCOPE,
    capability: 'read files in your Drive',
  },
  {
    pattern: /\bdrive[\s.]+files[\s.]+update\b/i,
    scope: DRIVE_METADATA_SCOPE,
    capability: 'rename and move files in your Drive',
  },
];

/**
 * Given a gws command and the space-separated `scope` string Google returned
 * with the access token, report which newly-required scopes are missing.
 *
 * Returns `null` when the command needs nothing new (the overwhelmingly common
 * case, so the caller pays nothing), otherwise
 * `{ scopes: [...], capability: '<human phrase>' }`.
 *
 * Fail-OPEN on an absent/unparseable scope string: Google always returns
 * `scope` on a refresh, but if it ever did not, refusing every Drive call
 * would be a self-inflicted outage. A genuinely missing scope still fails at
 * Google with a 403 — the pre-flight is an improvement to the error, not the
 * security boundary. The security boundaries are the OAuth grant itself and
 * enforcePhase1Gates.
 */
function missingScopesForCommand(commandString, grantedScopeString) {
  if (!commandString || typeof grantedScopeString !== 'string' || !grantedScopeString.trim()) {
    return null;
  }
  const tokens = splitCommand(commandString);
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const granted = new Set(grantedScopeString.split(/\s+/).filter(Boolean));

  const missing = [];
  let capability = null;
  for (const req of SCOPE_REQUIREMENTS) {
    if (!req.pattern.test(spaceJoined) && !req.pattern.test(dotJoined)) continue;
    if (granted.has(req.scope)) continue;
    if (!missing.includes(req.scope)) missing.push(req.scope);
    if (!capability) capability = req.capability;
  }
  return missing.length ? { scopes: missing, capability } : null;
}

/**
 * Test the gws command against Phase 1 forbidden patterns. Returns
 * `{allowed: true}` if the command can proceed, or
 * `{allowed: false, reason: '<short description>'}` if it must be refused.
 *
 * The check is intentionally permissive on whitespace and dot-vs-space
 * separators so different gws invocation styles all hit the same rules.
 *
 * Optional `context` argument applies account-scope restrictions:
 *   { scope: 'agent_account' | 'user_account', ownerEmail: '<caller@…>' }
 */
function enforcePhase1Gates(commandString, context) {
  if (!commandString || typeof commandString !== 'string') {
    return { allowed: true };
  }
  // SECURITY (REV-COR-346): match against the SAME tokenization that executes.
  // execGws runs splitCommand(commandString), which strips quotes. Matching the
  // raw string let an attacker insert a quote into a forbidden verb
  // (`messages 'send'`) so the regex missed it while splitCommand reassembled
  // the exact blocked argv. We tokenize first and test the space- and
  // dot-joined argv, so the gate sees precisely what gws will receive.
  const tokens = splitCommand(commandString);
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const hits = (pattern) => pattern.test(spaceJoined) || pattern.test(dotJoined);

  for (const { pattern, reason } of PROVENANCE_REQUIRED) {
    if (hits(pattern)) return { allowed: false, reason };
  }

  // Scope-conditional gates: file creation as the USER is impersonation
  // (2026-07-07, see USER_SCOPE_FORBIDDEN). Checked first — these have no
  // exceptions. Fail-closed default: when scope is missing/unknown we still
  // apply the user-slot rules (run.js always passes a resolved scope; only
  // a buggy caller would omit it, and the agent slot is the privileged one).
  if (!context || context.scope !== 'agent_account') {
    for (const { pattern, reason, exception } of USER_SCOPE_FORBIDDEN) {
      if (hits(pattern)) {
        // #1305: `create` and `update` carry narrow allowlisted exceptions
        // (folder-only create, metadata-only update). Every other entry has
        // no `exception` and stays absolute.
        if (exception && exception(commandString, tokens)) {
          continue;
        }
        return { allowed: false, reason };
      }
    }
  }
  for (const { pattern, reason } of PHASE1_FORBIDDEN) {
    if (hits(pattern)) {
      return { allowed: false, reason };
    }
  }

  // Trash travels as a body field, and the raw-string pattern above can be
  // dodged with a JSON escape in the key — judge the DECODED payload too,
  // on BOTH slots (codex P1, PR #1346).
  const trashedReason = detectDriveTrashedWrite(commandString, tokens);
  if (trashedReason) {
    return { allowed: false, reason: trashedReason };
  }

  // Helper-form send/reply/forward (REV-COR-350) — `gws gmail +send`,
  // `gmail --to x +send` escape the start-anchored patterns above.
  const helperReason = detectGmailSendHelper(tokens);
  if (helperReason) {
    return { allowed: false, reason: helperReason };
  }

  return { allowed: true };
}

// ============================================================================
// Marker injection (#912 Phase 1)
// ============================================================================
//
// Every write operation gets an automatic marker so artifacts the agent
// touches are auditable as agent-touched. The model does not have to
// remember to add markers — they're injected here.
//
// Inject points:
//   - Calendar event create/update: prepend description with marker
//   - Gmail draft create: append body with marker + X-PSD-Agent header
//   - Drive file create: filename prefix [Agent] + appProperties marker
//   - Tasks: enforce 'Your Agent' tasklist
//
// These transforms operate on the JSON-encoded params. The skill receives a
// command string like:
//   calendar events insert --json '{"summary":"x","description":"y"}'
// We parse the --json blob, mutate it, re-stringify.

const AGENT_MARKER_TEXT = '🤖 Created by your agent';

function markerWithDate() {
  const today = new Date().toISOString().slice(0, 10);
  return `${AGENT_MARKER_TEXT} on ${today}.`;
}

/**
 * Inject markers into the gws command string. Returns the (possibly
 * modified) command. If the command doesn't match a write-with-markable-
 * payload pattern, returns the input unchanged.
 *
 * Best-effort: if the JSON payload is malformed or the command shape is
 * unexpected, we pass the original through rather than fail. The skill
 * surfaces auth errors and Phase 1 gate violations explicitly; quietly
 * skipping a marker on a malformed command is the lesser harm.
 */
function injectMarkers(commandString) {
  if (!commandString || typeof commandString !== 'string') return commandString;

  // Calendar events insert/update: prepend description with marker.
  if (/\bcalendar[\s.]+events[\s.]+(insert|update|patch)\b/i.test(commandString)) {
    return mutateJsonField(commandString, (obj) => {
      const marker = markerWithDate();
      obj.description = obj.description
        ? `${marker}\n\n${obj.description}`
        : marker;
      return obj;
    });
  }

  // Gmail drafts create: marker the body and add an identifying header.
  if (/\bgmail[\s.]+users[\s.]+drafts[\s.]+create\b/i.test(commandString)) {
    return mutateJsonField(commandString, (obj) => {
      // gws drafts.create wraps the message under .message.raw (base64url).
      // Skip raw mutation here — too brittle. The +draft helper takes
      // body/subject directly and is the recommended path; we marker the
      // body field if present. For raw payloads the marker rule is
      // enforced via SKILL.md prompt guidance instead.
      if (obj.message && typeof obj.message.body === 'string') {
        obj.message.body = `${obj.message.body}\n\n— Drafted by your agent. Review before sending.`;
      }
      return obj;
    });
  }

  // Drive files create: prefix filename + appProperties marker
  if (/\bdrive[\s.]+files[\s.]+create\b/i.test(commandString)) {
    return mutateJsonField(commandString, (obj) => {
      // Mark the FILE RESOURCE, not the envelope. gws accepts the resource at
      // top level or wrapped under `resource` / `requestBody`, and the gate
      // (isPermittedFolderCreate / isMetadataOnlyDriveUpdate, via
      // extractDriveResource) unwraps all three. Marking only the outer object
      // meant a wrapped payload was ALLOWED through the gate but its actual
      // folder/file resource got neither the appProperties marker nor the
      // folder-name handling — the audit trail silently went missing for
      // exactly the shapes the gate accepts. Unwrap identically here so the
      // gate and the marker can never disagree about which object is the file.
      const target =
        (obj.resource && typeof obj.resource === 'object' && !Array.isArray(obj.resource) && obj.resource) ||
        (obj.requestBody && typeof obj.requestBody === 'object' && !Array.isArray(obj.requestBody) && obj.requestBody) ||
        obj;

      // FOLDERS are exempt from the visible `[Agent] ` prefix (#1305). A folder
      // is an organizing container the USER asked for by name — "file these
      // under Budget 2026" must not produce "[Agent] Budget 2026" in their own
      // Drive. The prefix exists to mark agent-AUTHORED artifacts; a folder
      // has no content to author. The invisible appProperties marker below is
      // still applied, so the audit trail is unchanged and the folder remains
      // identifiable as agent-created.
      const isFolder =
        typeof target.mimeType === 'string' &&
        target.mimeType.trim().toLowerCase() === DRIVE_FOLDER_MIME;
      if (target.name && !isFolder && !target.name.startsWith('[Agent] ')) {
        target.name = `[Agent] ${target.name}`;
      }
      target.appProperties = target.appProperties || {};
      target.appProperties.psdAgentCreated = 'true';
      return obj;
    });
  }

  // Tasks: enforce 'Your Agent' tasklist on tasks.insert if not provided
  // (the tasklist must exist; create-on-demand is left to the model so the
  // SKILL.md flow stays explicit). For now, no auto-mutation here — the
  // SKILL.md guidance and Phase 1 absolutes ensure the model uses the
  // right tasklist explicitly.

  return commandString;
}

/**
 * Locate the --json '{...}' argument in a gws command string via a
 * balanced-brace scan. Returns {jsonStart, jsonEnd, openQuote} (end
 * inclusive) or null when there is no parseable --json object. Shared by
 * mutateJsonField (marker injection) and extractJsonArg (payload-file flow).
 */
function findJsonSpan(commandString) {
  // Match --json followed by a single-quoted or double-quoted JSON object.
  // The simple/robust approach: find --json, then balanced-brace scan from
  // the next non-quote character forward.
  const jsonFlagIdx = commandString.search(/--json\s+['"]?\{/);
  if (jsonFlagIdx === -1) return null;

  // Find the start of the JSON object (`{`). Skip the `--json` token,
  // any whitespace, and any opening quote.
  let i = jsonFlagIdx + '--json'.length;
  while (i < commandString.length && /\s/.test(commandString[i])) i++;
  let openQuote = '';
  if (commandString[i] === "'" || commandString[i] === '"') {
    openQuote = commandString[i];
    i++;
  }
  const jsonStart = i;
  if (commandString[jsonStart] !== '{') return null;

  // Brace-balance scan to find the matching close.
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;
  let jsonEnd = -1;
  for (let j = jsonStart; j < commandString.length; j++) {
    const ch = commandString[j];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) {
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { jsonEnd = j; break; }
    }
  }
  if (jsonEnd === -1) return null;
  return { jsonStart, jsonEnd, openQuote };
}

/**
 * Return the raw --json object substring from a command string, or null.
 * Used by the payload-file flow to pull a marker-mutated JSON payload back
 * out of the synthetic inline command before execution.
 */
function extractJsonArg(commandString) {
  if (!commandString || typeof commandString !== 'string') return null;
  const span = findJsonSpan(commandString);
  if (!span) return null;
  return commandString.slice(span.jsonStart, span.jsonEnd + 1);
}

/**
 * Find the --json '{...}' argument in a gws command string and apply
 * `mutator` to the parsed object. Re-encode and splice back.
 *
 * Returns the original string if no --json arg or the JSON parse fails.
 */
function mutateJsonField(commandString, mutator) {
  const span = findJsonSpan(commandString);
  if (!span) return commandString;
  const { jsonStart, jsonEnd, openQuote } = span;

  const jsonStr = commandString.slice(jsonStart, jsonEnd + 1);
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return commandString;
  }

  let mutated;
  try {
    mutated = mutator(obj);
  } catch {
    return commandString;
  }

  const newJson = JSON.stringify(mutated);
  // Preserve the original opening quote style so shell parsing is unchanged.
  const closeQuote = openQuote;
  return (
    commandString.slice(0, jsonStart) +
    newJson +
    (closeQuote ? '' : '') +
    commandString.slice(jsonEnd + 1).replace(/^['"]?/, closeQuote ? closeQuote : '')
  );
}

module.exports = {
  APP_BASE_URL,
  fail,
  emit,
  parseArgs,
  validateUserEmail,
  splitCommand,
  enforcePhase1Gates,
  injectMarkers,
  resolvePayloadFiles,
  extractJsonArg,
  missingScopesForCommand,
  isPermittedFolderCreate,
  isMetadataOnlyDriveUpdate,
  PHASE1_FORBIDDEN,
  PROVENANCE_REQUIRED,
  USER_SCOPE_FORBIDDEN,
  DRIVE_FOLDER_MIME,
  DRIVE_READ_SCOPE,
  DRIVE_METADATA_SCOPE,
};
