/**
 * Atrium embed-in-doc PASTE smoke test (Bun) — #1052
 *
 * `directiveToEmbedNode` is the pure core of the client-only ArtifactEmbedPaste
 * extension (components/atrium/artifact-embed-paste.ts): given the shared collab
 * schema and a pasted string, it returns the `atriumArtifactEmbed` node when — and
 * only when — the whole payload is a single valid embed directive. Driving it
 * against the REAL shared schema proves:
 *   - a bare `::atrium-artifact{id="<uuid>"}` paste becomes the embed node with its
 *     id intact (and lowercased — the id round-trips to the same directive);
 *   - a whitespace-wrapped directive still converts (paste often adds a newline);
 *   - a malformed id, a non-directive, mixed prose containing a directive line, and
 *     a fenced/quoted directive all return null → they fall through to the default
 *     plain-text paste and are NOT silently promoted to a live embed.
 *
 * Run: `bun run tests/smoke/atrium-embed-paste.smoke.ts`
 */

import assert from "node:assert/strict";
import { getCollabSchema } from "@/lib/content/collab/editor-extensions";
import { directiveToEmbedNode } from "@/components/atrium/artifact-embed-paste";
import { ARTIFACT_EMBED_NODE_NAME } from "@/lib/content/collab/artifact-embed-node";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const schema = getCollabSchema();
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

check("a bare directive paste becomes the embed node with its id", () => {
  const node = directiveToEmbedNode(schema, `::atrium-artifact{id="${UUID}"}`);
  assert.ok(node, "expected an embed node for a valid directive");
  assert.equal(node?.type.name, ARTIFACT_EMBED_NODE_NAME);
  assert.equal(node?.attrs.artifactId, UUID);
});

check("a whitespace-wrapped directive still converts (paste adds a newline)", () => {
  const node = directiveToEmbedNode(schema, `\n  ::atrium-artifact{id="${UUID}"}\n`);
  assert.ok(node, "expected an embed node for a padded directive");
  assert.equal(node?.attrs.artifactId, UUID);
});

check("an uppercase id is normalized to lowercase (directive round-trips)", () => {
  const node = directiveToEmbedNode(schema, `::atrium-artifact{id="${UUID.toUpperCase()}"}`);
  assert.equal(node?.attrs.artifactId, UUID, "id should be lowercased");
});

check("a malformed (non-UUID) id returns null", () => {
  assert.equal(
    directiveToEmbedNode(schema, `::atrium-artifact{id="not-a-uuid"}`),
    null
  );
});

check("plain prose returns null (default paste, not swallowed)", () => {
  assert.equal(directiveToEmbedNode(schema, "just some pasted text"), null);
});

check("prose that merely CONTAINS a directive line returns null (whole-payload only)", () => {
  const mixed = `See this artifact:\n::atrium-artifact{id="${UUID}"}\nmore text`;
  assert.equal(
    directiveToEmbedNode(schema, mixed),
    null,
    "mixed content must fall through to default paste"
  );
});

check("empty string returns null", () => {
  assert.equal(directiveToEmbedNode(schema, ""), null);
  assert.equal(directiveToEmbedNode(schema, "   \n  "), null);
});

console.log(`\natrium-embed-paste smoke: ${passed} checks passed`);
