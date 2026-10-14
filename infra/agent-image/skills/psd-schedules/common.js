/**
 * Shared helpers for the owner-bound psd-schedules skill.
 *
 * The model runtime does not receive schedule-table, EventBridge Scheduler, or
 * iam:PassRole authority. It sends schedule specifications to the trusted web
 * broker, which derives owner and destination from signed server-side context.
 */

"use strict";

const { requestAgentBroker } = require("../_shared/agent-broker");
const DEFAULT_TIMEZONE = "America/Los_Angeles";

function fail(message, code = 1) {
  process.stderr.write(`psd-schedules: ${message}\n`);
  process.exit(code);
}

function validateEnv() {
  return true;
}

function rejectLegacyAuthorityArgs(args) {
  const forbidden = [
    "user",
    "owner-email",
    "google-identity",
    "dm-space-name",
    "workspace-prefix",
  ];
  const supplied = forbidden.find((field) =>
    Object.prototype.hasOwnProperty.call(args, field),
  );
  if (supplied) {
    fail(
      `--${supplied} is not accepted. Schedule identity is derived ` +
        "from the signed invocation context.",
    );
  }
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    fail(
      `Invalid timezone "${timezone}". Must be a valid IANA timezone ` +
        "(e.g. America/Los_Angeles, Asia/Tokyo, UTC).",
    );
  }
}

/**
 * Is this cron field a YEAR — `*`, a 4-digit year, or a list/range/step of
 * them? Mirrors `isYearField` in lib/agent-schedules/validation.ts.
 *
 * A parser rather than one regex: the equivalent pattern nests quantifiers
 * inside an alternation, which is a ReDoS shape on model-supplied input.
 */
function isYearField(field) {
  if (field === "*") return true;
  return field.split(",").every((segment) => {
    const pieces = segment.split("/");
    if (pieces.length > 2) return false;
    if (pieces.length === 2 && !/^\d{1,3}$/.test(pieces[1])) return false;
    if (pieces[0] === "*") return true;
    const bounds = pieces[0].split("-");
    return bounds.length <= 2 && bounds.every((token) => /^\d{4}$/.test(token));
  });
}

/**
 * Reject an unwrapped 6-field cron whose sixth field is not a year.
 *
 * Mirrors `rejectMisreadSixFieldCron` in lib/agent-schedules/validation.ts —
 * caught here too so the agent learns before spending a broker round trip.
 *
 * The 6-field unwrapped path assumes EventBridge shape, where field 6 is the
 * year. A seconds-first expression also has six fields, so it was accepted and
 * then rewritten into a different schedule: `0 15 18 * * *` ("6:15pm daily")
 * became `cron(0 15 18 * ? *)` — 3:00pm on the 18th of every month. Nothing
 * downstream caught it, because this function sets `?` itself before the
 * server's `?` guard ever sees the fields.
 */
function rejectMisreadSixFieldCron(parts) {
  if (!isYearField(parts[5])) {
    fail(
      "the 6th cron field must be a 4-digit year or *. EventBridge takes " +
        "minute hour day-of-month month day-of-week year (no seconds " +
        "field). Prefer the 5-field form — e.g. `45 6 * * MON-FRI` for " +
        "6:45am on weekdays — and let the skill expand it.",
    );
  }
  const hourLike = /^\d{1,2}$/.test(parts[2])
    ? Number.parseInt(parts[2], 10)
    : null;
  // Narrowed to "neither day field is ?" so a real EventBridge expression such
  // as `0 0 1 * ? *` (midnight on the 1st) stays accepted.
  if (
    parts[0] === "0" &&
    hourLike !== null &&
    hourLike <= 23 &&
    parts[2] !== "?" &&
    parts[4] !== "?"
  ) {
    fail(
      "this looks like a seconds-first cron, which EventBridge does not " +
        "accept — it would be read as day-of-month " +
        `${hourLike}, not ${hourLike}:00. EventBridge takes minute hour ` +
        "day-of-month month day-of-week year. For 6:15pm daily use the " +
        "5-field form `15 18 * * *`.",
    );
  }
}

function normalizeUnwrappedCron(expr) {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    fail(
      `Invalid cron "${expr}". Expected 5 or 6 fields (got ${parts.length}).`,
    );
  }
  if (parts.length === 6) rejectMisreadSixFieldCron(parts);
  const expanded = parts.length === 6 ? [...parts] : [...parts, "*"];
  const minute = expanded[0];
  if (minute === "*" || minute === "*/1") {
    fail("Every-minute cron is not allowed. Minimum interval is 5 minutes.");
  }
  const domSpecified = expanded[2] !== "*" && expanded[2] !== "?";
  const dowSpecified = expanded[4] !== "*" && expanded[4] !== "?";
  if (domSpecified && dowSpecified) {
    fail("Cannot specify both day-of-month and day-of-week.");
  }
  // Caught client-side as well as server-side so the agent learns before
  // spending a round trip. Same helper the wrapped path uses.
  assertNamedDayOfWeek(expanded[4]);
  if (dowSpecified) expanded[2] = "?";
  else expanded[4] = "?";
  return `cron(${expanded.join(" ")})`;
}

function toSchedulerExpression(raw) {
  const expr = String(raw || "").trim();
  if (!expr) fail("--cron is required");
  if (
    expr.startsWith("cron(") ||
    expr.startsWith("rate(") ||
    expr.startsWith("at(")
  ) {
    return validateWrappedExpression(expr);
  }
  return normalizeUnwrappedCron(expr);
}

/**
 * Day-of-week must be named in either entry path.
 *
 * EventBridge counts 1=SUN, ordinary cron counts 0=SUN, so a numeric range runs
 * a day off without failing anywhere (agent_failures 8157). Shared by the
 * wrapped and unwrapped paths — the check originally lived only in
 * normalizeUnwrappedCron, so an agent submitting an already-wrapped `cron(...)`
 * skipped it entirely and learned only from the server.
 */
function assertNamedDayOfWeek(field) {
  if (field === "*" || field === "?" || !/\d/.test(field)) return;
  fail(
    "cron day-of-week must use names (SUN,MON,TUE,WED,THU,FRI,SAT), not " +
      "numbers. EventBridge counts 1=SUN while ordinary cron counts 0=SUN, " +
      "so a numeric range runs a day off without failing. Weekdays are " +
      "MON-FRI.",
  );
}

function validateWrappedExpression(expr) {
  const cronMatch = expr.match(/^cron\((.+)\)$/);
  if (cronMatch) {
    const fields = cronMatch[1].trim().split(/\s+/);
    if (fields.length !== 6) fail("cron() must have exactly 6 fields");
    if (fields[0] === "*" || fields[0] === "*/1") {
      fail("Every-minute cron is not allowed. Minimum interval is 5 minutes.");
    }
    assertNamedDayOfWeek(fields[4]);
    // Same year rule the unwrapped path enforces, so a hand-wrapped
    // `cron(...)` cannot smuggle a day name or a seconds field into field 6.
    if (!isYearField(fields[5])) {
      fail(
        "the 6th cron field must be a 4-digit year or *. EventBridge takes " +
          "minute hour day-of-month month day-of-week year (no seconds " +
          "field).",
      );
    }
    return expr;
  }
  const rateMatch = expr.match(
    /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/,
  );
  if (rateMatch) {
    const count = Number.parseInt(rateMatch[1], 10);
    if (
      (rateMatch[2] === "minute" || rateMatch[2] === "minutes") &&
      count < 5
    ) {
      fail("Minimum rate interval is 5 minutes.");
    }
    return expr;
  }
  if (/^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/.test(expr)) {
    return expr;
  }
  fail(`Invalid expression "${expr}".`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) fail(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function requestScheduleOperation(payload) {
  validateEnv();
  return requestAgentBroker("/api/agent/schedules", payload);
}

module.exports = {
  DEFAULT_TIMEZONE,
  fail,
  validateEnv,
  rejectLegacyAuthorityArgs,
  validateTimezone,
  toSchedulerExpression,
  parseArgs,
  emit,
  requestScheduleOperation,
};
