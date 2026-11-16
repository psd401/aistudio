'use strict';

/**
 * Where an agent-made file goes: PRIVATE by default, public only on an explicit,
 * user-confirmed opt-in (#2034).
 *
 * WHY. The district rule is that anything an agent produces is private to the
 * person who asked, whatever it contains, until that person deliberately widens
 * it. Several skills used to deliver ONLY to the unsigned, public-by-link
 * `public-images/` prefix — morning-brief podcasts narrating someone's inbox and
 * calendar sat on open URLs. A content scan cannot be the safeguard: a brief
 * about meetings and colleagues never matches a phone or student-number
 * pattern. So visibility is never decided from content. It is decided here,
 * from two flags, and the default is private.
 *
 * THE TWO FLAGS.
 *   --to drive | public     drive (the default) creates the file in the agent
 *                           account's Drive and shares it with the caller
 *                           alone. public is an unsigned link anyone can open.
 *   --public-confirmed      required alongside --to public. It records that the
 *                           agent ASKED the user — naming the file and saying
 *                           anyone with the link can open it, no sign-in — and
 *                           the user said yes. Without it the skill refuses
 *                           with `public_needs_confirmation` and uploads
 *                           nothing.
 *
 * The confirmation flag is friction, not proof: the skill cannot see the chat.
 * It exists so a public link can never be the result of a default, a habit, or
 * a single flag copied from an old example — the agent has to deliberately add
 * a second flag whose name says what it is asserting.
 */

const PUBLIC_CONFIRMED_FLAG = '--public-confirmed';

const PUBLIC_NEEDS_CONFIRMATION_MESSAGE =
  'Public links are opt-in and need the user\'s explicit yes. Nothing was ' +
  'uploaded. Deliver privately instead (omit --to public: the file goes to ' +
  'your Drive, shared with the requester only). Use a public link ONLY if the ' +
  'user asked for one: ask them first, in plain words, "This will be a public ' +
  'link — anyone who gets it can open it without signing in, for 30 days. OK?" ' +
  'If, and only if, they say yes, run the same command again with --to public ' +
  `${PUBLIC_CONFIRMED_FLAG}.`;

class DeliveryChoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryChoiceError';
    this.code = code;
  }
}

/**
 * Resolve the destination from parsed args (`parseArgs` style: `--to x` →
 * `args.to`, `--public-confirmed` → `args.public_confirmed === true`).
 *
 * @param {{to?: string|boolean, public_confirmed?: string|boolean}} args
 * @param {{allowed?: string[]}} [options] destinations this skill offers
 * @returns {'drive'|'public'|string}
 * @throws {DeliveryChoiceError} code `bad_args` or `public_needs_confirmation`
 */
function resolveDelivery(args, options = {}) {
  const allowed = options.allowed || ['drive', 'public'];
  const requested = args.to;
  if (requested === undefined) return allowed[0];
  const name = requested === true ? '' : String(requested).trim().toLowerCase();
  if (!allowed.includes(name)) {
    throw new DeliveryChoiceError(
      'bad_args',
      `--to ${name || '(no value)'} is not a destination. Use ` +
        allowed.map((d) => `--to ${d}`).join(' or ') +
        ` (${allowed[0]} is the default and is private).`
    );
  }
  if (args.public_confirmed !== undefined && args.public_confirmed !== true) {
    throw new DeliveryChoiceError(
      'bad_args',
      `${PUBLIC_CONFIRMED_FLAG} is a flag and takes no value.`
    );
  }
  if (name === 'public' && args.public_confirmed !== true) {
    throw new DeliveryChoiceError(
      'public_needs_confirmation',
      PUBLIC_NEEDS_CONFIRMATION_MESSAGE
    );
  }
  return name;
}

// The broker's SAFE_PUBLIC_ARTIFACT_NAME rule (storage-broker.ts) for a Drive
// delivery file name. Anything else is collapsed to a space rather than
// refused, so "Board recap: Nov 11" still delivers.
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._@+= -]+/g;
const MAX_NAME_CHARS = 120;

/**
 * A broker-safe Drive file name: `name` cleaned, or `<fallback> <date time>`,
 * always ending in `extension`.
 *
 * @param {string|undefined|true} name the `--name` flag
 * @param {string} extension e.g. '.png'
 * @param {string} fallback e.g. 'Image'
 * @param {Date} [now]
 */
function driveFileName(name, extension, fallback, now = new Date()) {
  let base = typeof name === 'string' ? name : '';
  base = base.replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ');
  base = base.slice(0, MAX_NAME_CHARS).replace(/^[ .]+|[ .]+$/g, '');
  if (base.toLowerCase().endsWith(extension)) {
    base = base.slice(0, -extension.length).replace(/[ .]+$/g, '');
  }
  if (!base) {
    const pad = (n) => String(n).padStart(2, '0');
    base =
      `${fallback} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-` +
      `${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  }
  return `${base}${extension}`;
}

module.exports = {
  DeliveryChoiceError,
  driveFileName,
  PUBLIC_CONFIRMED_FLAG,
  PUBLIC_NEEDS_CONFIRMATION_MESSAGE,
  resolveDelivery,
};
