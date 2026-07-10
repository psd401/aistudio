/**
 * Atrium content MCP tool definitions (Issue #1055, Phase 5 §24)
 *
 * The atomic content primitives exposed to MCP clients, registered into
 * `MCP_TOOLS` alongside the existing first-party tools (scope enforcement lives
 * in the unified tool catalog — `lib/tools/catalog/manifest.ts` — which a unit
 * test keeps in sync with `CONTENT_TOOL_SCOPE_MAP` below). They
 * are deliberately atomic — there is NO `generate_and_publish`; an agent calls
 * `create_*` then `publish_content` as separate, individually-scoped steps.
 *
 * `McpToolProperty` is intentionally flat (no nested object schemas), so the
 * `visibility`/`grants` shapes are described in prose here; the real validation
 * is the Zod schema in `./content-tool-handlers`.
 */

import type { McpToolDefinition } from "./types";
import type { ApiScope } from "@/lib/api-keys/scopes";

const VISIBILITY_DESC =
  "Visibility object: { level: 'private'|'group'|'internal'|'public', grants?: [{ kind: 'role'|'building'|'department'|'grade'|'user', value: string }] }";
const GRANTS_DESC =
  "Group grants: [{ kind: 'role'|'building'|'department'|'grade'|'user', value: string }]";

export const CONTENT_TOOL_SCOPE_MAP: Record<string, ApiScope> = {
  create_document: "content:create",
  create_artifact: "content:create",
  get_content: "content:read",
  list_content: "content:read",
  update_content: "content:update",
  create_version: "content:update",
  set_visibility: "content:update",
  // Internal publish is the baseline scope; the public-publish gate (§26.4) is
  // enforced in publishService, which raises approval_required without the
  // human-held content:publish_public.
  publish_content: "content:publish_internal",
  // Unpublish shares publish's authority model: internal scope is the baseline,
  // and taking down a PUBLIC destination is gated inside publishService.unpublish
  // (§26.4 — the same authority needed to put it up).
  unpublish_content: "content:publish_internal",
  // OKF interoperability (Phase 8, §36.4). Export is a read/serialization
  // (content:read); a `public` audience additionally needs content:publish_public
  // (the §26.4 gate is enforced in okfExportService). Import creates content.
  export_okf: "content:read",
  import_okf: "content:create",
};

export const CONTENT_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "create_document",
    description:
      "Create a document (markdown) content object. Does not publish. Returns the object id, slug, and reader link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title" },
        collection: { type: "string", description: "Collection slug or id (optional)" },
        markdown: { type: "string", description: "Initial body; markdown only" },
        visibility: { type: "object", description: VISIBILITY_DESC },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["title"],
    },
  },
  {
    name: "create_artifact",
    description:
      "Create an interactive artifact (HTML/JS or JSX) content object. Does not publish. Returns the object id, slug, and reader link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Artifact title" },
        collection: { type: "string", description: "Collection slug or id (optional)" },
        code: { type: "string", description: "Artifact source (HTML/JS or JSX)" },
        bodyFormat: { type: "string", enum: ["html", "jsx"], description: "Body format" },
        visibility: { type: "object", description: VISIBILITY_DESC },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["title", "code", "bodyFormat"],
    },
  },
  {
    name: "get_content",
    description:
      "Fetch a content object and its current version by id or slug. Permission-checked (404 when not viewable).",
    inputSchema: {
      type: "object",
      properties: {
        idOrSlug: { type: "string", description: "Object id (uuid) or slug" },
      },
      required: ["idOrSlug"],
    },
  },
  {
    name: "list_content",
    description:
      "List content the caller may view. Filterable by kind, collection, tag, status, and title text.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["document", "artifact"], description: "Filter by kind" },
        collection: { type: "string", description: "Collection slug or id" },
        tag: { type: "string", description: "Filter by tag" },
        status: {
          type: "string",
          enum: ["draft", "published", "archived"],
          description: "Filter by status",
        },
        query: {
          type: "string",
          description: "Case-insensitive title search (max 200 characters)",
        },
      },
    },
  },
  {
    name: "update_content",
    description:
      "Update object metadata (title, tags, collection, status). Body changes use create_version.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Object id" },
        title: { type: "string", description: "New title" },
        tags: { type: "array", items: { type: "string" }, description: "Replacement tags" },
        collection: { type: "string", description: "Collection slug or id (or null to clear)" },
        status: {
          type: "string",
          enum: ["draft", "published", "archived"],
          description: "New status",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_version",
    description:
      "Add a new version with new body content and an optional change summary.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Object id" },
        body: { type: "string", description: "New body (markdown for docs, code for artifacts)" },
        bodyFormat: {
          type: "string",
          enum: ["markdown", "html", "jsx"],
          description: "Body format",
        },
        summary: { type: "string", description: "Optional change summary" },
      },
      required: ["id", "body"],
    },
  },
  {
    name: "set_visibility",
    description: "Set who can view the object (level + group grants).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Object id" },
        level: {
          type: "string",
          enum: ["private", "group", "internal", "public"],
          description: "Visibility level",
        },
        grants: { type: "array", items: { type: "object" }, description: GRANTS_DESC },
      },
      required: ["id", "level"],
    },
  },
  {
    name: "publish_content",
    description:
      "Publish a content object to a destination. Public destinations require the human-held content:publish_public; without it the call returns a structured approval_required signal. 'okf' serializes the single object to a portable Open Knowledge Format concept bundle in S3 (internal-publish authority).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Object id" },
        destination: {
          type: "string",
          enum: ["intranet", "public_web", "schoology", "google", "okf"],
          description: "Publish destination",
        },
      },
      required: ["id", "destination"],
    },
  },
  {
    name: "unpublish_content",
    description:
      "Unpublish (take down) a content object from a destination. Idempotent: unpublishing an object that is not live there returns unpublished: false rather than erroring. Taking down a public-facing destination requires the human-held content:publish_public; without it the call returns a structured approval_required signal — the same §26.4 authority needed to publish it. Mirrors DELETE /api/v1/content/{id}/publish/{destination} (no okf: an okf publication is a serialized S3 bundle with no live surface to take down).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Object id" },
        destination: {
          type: "string",
          enum: ["intranet", "public_web", "schoology", "google"],
          description: "Destination to unpublish from",
        },
      },
      required: ["id", "destination"],
    },
  },
  {
    name: "export_okf",
    description:
      "Export a collection subtree as a portable Open Knowledge Format (OKF v0.1) bundle: one markdown-with-frontmatter concept file per content object, an index.md per collection, and a log.md change history. Every object is filtered by the caller's view permission. A 'public' audience produces an anonymous-safe (public-visibility-only) bundle and requires content:publish_public — without it the call returns a structured approval_required signal. Returns the bundle files inline plus its S3 location.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description: "Root collection slug or id to export",
        },
        audience: {
          type: "string",
          enum: ["internal", "public"],
          description:
            "'internal' (default) scopes the bundle to what you can view; 'public' produces an anonymous-safe bundle (public content only) and needs content:publish_public",
        },
      },
      required: ["collectionId"],
    },
  },
  {
    name: "import_okf",
    description:
      "Import an Open Knowledge Format bundle (the { files: [{ path, content }] } shape export_okf returns) into Atrium content. Reconstructs the collection tree from the bundle directories and creates one content object per concept file. Imported objects are agent-authored (actor_kind='agent') and created private + draft. Returns the created object + collection ids.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "object" },
          description: "Bundle files: [{ path: string, content: string }]",
        },
        targetCollectionId: {
          type: "string",
          description:
            "Existing collection slug or id to import the bundle root INTO (optional; a fresh root collection is created when omitted)",
        },
      },
      required: ["files"],
    },
  },
];
