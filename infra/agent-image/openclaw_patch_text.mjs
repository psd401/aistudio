/**
 * Side-effect-free text surgery shared by the image-build patches.
 *
 * Lives apart from openclaw_runtime_patch.mjs because that script reads and
 * rewrites /app/dist the moment it is imported, so tests cannot import a
 * helper from it. Build-only: the Dockerfile deletes it after patching.
 */

export function fail(message) {
  throw new Error(`OpenClaw runtime patch failed: ${message}`);
}

/**
 * Replace exactly one occurrence of `before`. Throws when the anchor is
 * missing or repeated, so a host bump fails the build instead of shipping an
 * unpatched (or doubly patched) bundle.
 */
export function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) {
    fail(`${label}: expected anchor was not found`);
  }
  if (source.includes(before, first + before.length)) {
    fail(`${label}: expected anchor occurred more than once`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}
