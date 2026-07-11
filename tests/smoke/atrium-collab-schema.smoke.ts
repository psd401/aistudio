/**
 * Atrium collab SCHEMA-PARITY smoke test (Bun) — Epic #1059, §18.1
 *
 * The comments/track-changes marks must be in the ONE shared schema so the client
 * editor and the server transformer (y-prosemirror seeding + agent bridge) build the
 * IDENTICAL ProseMirror schema — a divergence corrupts the Yjs document. This smoke
 * is the direct client==server assertion that did not exist before, plus a Yjs
 * round-trip proving the new marks + their attributes survive the CRDT mapping.
 *
 * Run: `bun run tests/smoke/atrium-collab-schema.smoke.ts`
 */

import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import {
  getSchemaExtensions,
  getCollabSchema,
} from "@/lib/content/collab/editor-extensions";
import { AUTHORED_MARK } from "@/lib/content/collab/provenance";
import { ATRIUM_COMMENT_MARK } from "@/lib/content/collab/comment-mark";
import {
  ATRIUM_SUGGESTION_INSERT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
} from "@/lib/content/collab/suggestion-marks";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const EXPECTED_MARKS = [
  AUTHORED_MARK,
  ATRIUM_COMMENT_MARK,
  ATRIUM_SUGGESTION_INSERT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
  // Meridian floating-toolbar mark (slice C): TextStyle+Color add `textStyle`.
  "textStyle",
];

// Meridian floating-toolbar NODES (slice C): TableKit adds these. They must be in
// the ONE shared schema so a table typed in the client editor maps identically on
// the server transformer / collab bundle. Underline is a MARK from StarterKit v3
// (already covered by the mark parity check) — no separate node here.
const EXPECTED_TABLE_NODES = ["table", "tableRow", "tableHeader", "tableCell"];

// Meridian embedded-artifact NODE (slice D): AtriumArtifactEmbed adds this block
// ATOM. It must be in the ONE shared schema so an embed inserted in the client
// editor maps identically on the server transformer / collab bundle (the live
// React NodeView is attached client-side only and does not affect the schema).
const EXPECTED_EMBED_NODE = "atriumArtifactEmbed";

check("server schema (getCollabSchema) exposes all Atrium marks", () => {
  const schema = getCollabSchema();
  for (const mark of EXPECTED_MARKS) {
    assert.ok(schema.marks[mark], `server schema missing mark: ${mark}`);
  }
});

check("server schema exposes the Meridian table nodes", () => {
  const schema = getCollabSchema();
  for (const node of EXPECTED_TABLE_NODES) {
    assert.ok(schema.nodes[node], `server schema missing node: ${node}`);
  }
});

check("server schema exposes the Meridian embedded-artifact node", () => {
  const schema = getCollabSchema();
  assert.ok(
    schema.nodes[EXPECTED_EMBED_NODE],
    `server schema missing node: ${EXPECTED_EMBED_NODE}`
  );
});

check("client schema (getSchema(getSchemaExtensions)) == server schema mark set", () => {
  const client = getSchema(getSchemaExtensions());
  const server = getCollabSchema();
  const clientMarks = Object.keys(client.marks).sort();
  const serverMarks = Object.keys(server.marks).sort();
  assert.deepEqual(
    clientMarks,
    serverMarks,
    `client/server mark sets diverge:\n  client=${clientMarks}\n  server=${serverMarks}`
  );
});

check("client schema == server schema NODE set (table nodes stay in lockstep)", () => {
  const client = getSchema(getSchemaExtensions());
  const server = getCollabSchema();
  const clientNodes = Object.keys(client.nodes).sort();
  const serverNodes = Object.keys(server.nodes).sort();
  assert.deepEqual(
    clientNodes,
    serverNodes,
    `client/server node sets diverge:\n  client=${clientNodes}\n  server=${serverNodes}`
  );
});

check("a table + color-marked span survive a Yjs round-trip", () => {
  const schema = getCollabSchema();
  const docJSON = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "tinted",
            marks: [{ type: "textStyle", attrs: { color: "#6d4fc2" } }],
          },
        ],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }],
              },
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }],
              },
            ],
          },
        ],
      },
    ],
  };

  const ydoc = prosemirrorJSONToYDoc(schema, docJSON, "default");
  const back = yDocToProsemirrorJSON(ydoc, "default") as {
    content: Array<{ type: string; content?: unknown[] }>;
  };
  const types = back.content.map((n) => n.type);
  assert.ok(types.includes("table"), "table node lost in Yjs round-trip");
  const para = back.content[0] as {
    content: Array<{ text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }>;
  };
  const tinted = para.content.find((s) => s.text === "tinted");
  const style = tinted?.marks?.find((m) => m.type === "textStyle");
  assert.equal(style?.attrs?.color, "#6d4fc2", "textStyle color lost in Yjs round-trip");
});

check("an embedded-artifact node survives a Yjs round-trip with its id intact", () => {
  const schema = getCollabSchema();
  const artifactId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const docJSON = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "atriumArtifactEmbed", attrs: { artifactId, title: "Metrics" } },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ],
  };
  const ydoc = prosemirrorJSONToYDoc(schema, docJSON, "default");
  const back = yDocToProsemirrorJSON(ydoc, "default") as {
    content: Array<{ type: string; attrs?: Record<string, unknown> }>;
  };
  const embed = back.content.find((n) => n.type === "atriumArtifactEmbed");
  assert.ok(embed, "embedded-artifact node lost in Yjs round-trip");
  assert.equal(
    embed?.attrs?.artifactId,
    artifactId,
    "embed artifactId lost in Yjs round-trip"
  );
});

check("comment + suggestion marks survive a Yjs round-trip with attrs intact", () => {
  const schema = getCollabSchema();
  // A doc: "hello world" where "hello" carries a comment, "wor" a pending insert,
  // "ld" a pending delete.
  const docJSON = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "hello",
            marks: [{ type: ATRIUM_COMMENT_MARK, attrs: { threadId: "t-1", resolved: false } }],
          },
          { type: "text", text: " " },
          {
            type: "text",
            text: "wor",
            marks: [
              { type: ATRIUM_SUGGESTION_INSERT_MARK, attrs: { suggestionId: "s-1", by: "human:7", at: "2026-07-06" } },
            ],
          },
          {
            type: "text",
            text: "ld",
            marks: [
              { type: ATRIUM_SUGGESTION_DELETE_MARK, attrs: { suggestionId: "s-2", by: "ai:bot", at: "2026-07-06" } },
            ],
          },
        ],
      },
    ],
  };

  const ydoc = prosemirrorJSONToYDoc(schema, docJSON, "default");
  const back = yDocToProsemirrorJSON(ydoc, "default") as {
    content: Array<{ content: Array<{ text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }> }>;
  };
  const spans = back.content[0].content;
  const byText = (t: string) => spans.find((s) => s.text === t);

  const comment = byText("hello")?.marks?.find((m) => m.type === ATRIUM_COMMENT_MARK);
  assert.equal(comment?.attrs?.threadId, "t-1", "comment threadId lost in Yjs round-trip");

  const ins = byText("wor")?.marks?.find((m) => m.type === ATRIUM_SUGGESTION_INSERT_MARK);
  assert.equal(ins?.attrs?.suggestionId, "s-1", "insert suggestionId lost in Yjs round-trip");

  const del = byText("ld")?.marks?.find((m) => m.type === ATRIUM_SUGGESTION_DELETE_MARK);
  assert.equal(del?.attrs?.suggestionId, "s-2", "delete suggestionId lost in Yjs round-trip");
  assert.equal(del?.attrs?.by, "ai:bot", "delete author lost in Yjs round-trip");
});

console.log(`\natrium-collab-schema smoke: ${passed} checks passed`);
