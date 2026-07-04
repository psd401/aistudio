# Atrium — Complete Design & Implementation Spec

**An agent-native content workspace and intranet for AI Studio**

> Status: implementation-ready hand-off · Primary audience: Claude Code · Secondary: PSD engineering
> "Atrium" is a working product name (§34). Database/API identifiers (`content_objects`, `/v1/content`, …) are stable regardless of final product name.
> Code in this document is **concrete but illustrative**: it encodes the intended shapes, types, and logic. Claude Code adapts file paths, imports, and conventions to the live `psd401/aistudio` codebase, following the patterns referenced throughout.

---

## Table of contents

**Part I — Design**
1. Summary
2. Scope and non-goals
3. Architecture overview
4. Domain model
5. Key runtime flows

**Part II — Data**
6. Data model overview and storage split
7. Drizzle schema (complete)
8. Migrations
9. Integration with existing tables
10. Seed data

**Part III — Services**
11. Service layer architecture
12. Permissions and visibility
13. Storage adapters
14. Versioning
15. Publishing pipeline
16. Retrieval

**Part IV — Surfaces**
17. Authoring layout
18. Document editor (Proof)
19. Artifact canvas (assistant-ui)
20. Reader views
21. Navigation and IA

**Part V — Agent access**
22. The content API principle
23. REST API v1 (OpenAPI)
24. MCP tools
25. Skills and scheduled runs
26. Agent identity and authorization
27. Audit and events

**Part VI — Cross-cutting**
28. Security and compliance
29. Errors, idempotency, rate limiting, observability
30. Configuration and infrastructure
31. Testing and acceptance

**Part VII — Delivery**
32. Build plan
33. Open decisions to confirm
34. Naming
35. Appendix (file map, env vars, glossary)

---

# Part I — Design

## 1. Summary

Atrium is a content layer on top of AI Studio where **agents and people co-create two kinds of content — documents and interactive artifacts — version them with visible authorship, and publish them at controlled access levels** to a staff intranet, to families, and to external systems (Schoology, Google).

It is built to the agent-native principles AI Studio already leans toward:

- **Parity** — anything a person can do through the UI, an agent can do through tools.
- **Granularity** — tools are atomic primitives (`create`, `update`, `publish`); behaviors are outcomes an agent composes, not bundled workflow code.
- **Composability** — new capabilities arrive as new prompts/skills over the same primitives, not new endpoints.
- **Content as context** — published content is legible to agents and retrievable as grounding, scoped by permission.

**The one non-negotiable architectural commitment:** the **content API is the source of truth for how content is created, versioned, and published. Every surface is a client of it** — the in-app editors beside nexus chat, external agents over MCP, scripts over REST, and scheduled skill runs. There is no UI-only creation path. This is what makes "how do agents outside nexus create content" a non-question: they use the same API the editors use.

## 2. Scope and non-goals

**In scope (v1 + near term)**
- Content object model (documents + artifacts), versioning, two-grain provenance.
- Two authoring surfaces beside nexus chat: a document editor (Proof) and an artifact canvas (assistant-ui).
- A public/private/group permission model and an intranet/IA built on AI Studio's existing navigation.
- A publishing pipeline (intranet + public web in v1; Schoology + Google as later connectors).
- The agent-access surface: content tools over MCP, REST v1, and skills, with delegated and autonomous agent identity.
- Permission-aware retrieval so content becomes scoped context for assistants.

**Non-goals**
- **Do not rebuild AI Studio infrastructure.** Auth, RBAC, S3, document processing, vector search, the MCP server, OAuth2/OIDC, API v1, audit logging, and Guardrails/PII already exist and are reused.
- **Proof is not an HTML editor.** Documents are markdown that *render* rich via templates. Rich, interactive content is an artifact, not a document.
- **Nexus is not a privileged path.** It is one client of the content API.
- v1 does not ship Schoology/Google publishing, multi-tenant theming, or real-time multi-user artifact co-editing (documents get real-time collab via Proof; artifacts are version-based).

## 3. Architecture overview

Four layers. Only the **content layer** is built from scratch; surfaces are borrowed open source; the substrate and destinations already exist.

```
Destinations   Intranet · Public web · Schoology · Google        (publish targets)
Surfaces       Proof SDK (documents) · assistant-ui (artifacts)  (borrow, open source)
Content layer  objects · versions · provenance · permissions · publishing   <-- BUILD
Substrate      AI Studio: identity/RBAC · S3 · doc pipeline · vectors · MCP · OAuth2 · audit
```

### 3.1 Reuse map (existing AI Studio → role in Atrium)

| Existing component | Location / table | Role in Atrium |
|---|---|---|
| Cognito + NextAuth v5, roles, capabilities | `auth.ts`, `roles`, `capabilities`, `role_capabilities` | Identity; feature gating; basis for content visibility |
| User org attributes | `users.building`, `users.department`, `users.gradeLevels` | Group-scoped visibility primitives |
| S3 (StorageStack) | `@aws-sdk/client-s3`, `s3-request-presigner` | Rendered snapshots, artifact code blobs, doc markdown snapshots |
| Document processing | `lib/document-processing.ts`, Textract jobs | Ingests source PDFs/DOCX → text for distillation skills |
| Knowledge repositories + chunks | `knowledge_repositories`, `repository_items`, `repository_item_chunks`, `repository_access` | Retrieval index + access-control pattern to mirror |
| MCP server | `lib/mcp/` (`tool-registry.ts`, `tool-handlers.ts`, `custom-tools/registry.ts`, `jsonrpc-handler.ts`) | Hosts content tools for external agents |
| OAuth2/OIDC provider | `lib/mcp/mcp-oauth-provider.ts`, `app/(protected)/oauth`, `app/.well-known` | Auth for external agents + service identities |
| REST API v1 | `app/api/v1/*` (`sk-` keys, rate limiting, OpenAPI) | Hosts `/v1/content` endpoints |
| Delegated agent auth | `lib/agent-workspace/consent-token.ts`, `app/agent-connect` | On-behalf-of-user agent authorization |
| Navigation | `navigation_items` (`type` enum, `requiresRole`) | Extended to surface content as intranet pages |
| Audit | `nexus_mcp_audit_logs`, OpenTelemetry (`instrumentation.ts`) | Logs every agent create/publish |
| Safety | Bedrock Guardrails, PII tokenization (`lib/safety`) | Applied to agent-generated content paths |
| Assistant Architect + scheduler | `lib/assistant-architect`, `schedules`, `@aws-sdk/client-scheduler` | Scheduled autonomous content production |

### 3.2 Stack constraints (build to these)
- **Next.js 16 (App Router) + React 19 Server Components.** Reader views are RSC; editors are client components.
- **Drizzle ORM** over **Aurora Serverless v2 Postgres via a direct connection** — the **`postgres` (postgres.js) driver** over a `DATABASE_URL` (the repo migrated off the RDS Data API in Epic #526; `@aws-sdk/client-rds-data` is a leftover dependency and is **not** used). New schema files go in `lib/db/schema/tables/` and are exported from `lib/db/schema`.
- **Data-access conventions (apply to all illustrative `db.*` code below):** every query and mutation runs through the repo's wrappers `executeQuery(async (db) => …, "label")` and `executeTransaction(async (tx) => …, "label")` from `lib/db/drizzle-client.ts` — never a bare `db` handle. Migrations are generated with `drizzle-kit generate` and run via `scripts/drizzle-helpers/`. **JSONB inserts must use the postgres.js pattern** `sql\`${safeJsonbStringify(value)}::jsonb\`` (from `lib/db/json-utils.ts`) for jsonb columns such as `source_ref` and retrieval `metadata`; timestamps serialize via `pgTimestampAsText` (`lib/db/drizzle-helpers.ts`). The code blocks in this spec are written against a plain `db`/`tx` for readability — read every one as wrapped in `executeQuery`/`executeTransaction`.
- **AI SDK v6** (`ai@~6`) and **assistant-ui** (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`, `@assistant-ui/react-markdown`) are already installed.
- **AWS CDK (TypeScript)** for new infra (an S3 prefix, an SNS topic / EventBridge bus, the artifact sandbox origin). Follow `infra/` conventions.
- Server mutations follow the existing **server-actions** pattern (`actions/db/*`) and return the repo's `ActionState<T>`; external access goes through **API v1** and **MCP**, never server actions.
- New runtime dependencies to add: `@codemirror/*` (artifact code editor) and the Proof SDK packages. No new agent framework (stay on AI SDK v6); no Yjs unless Proof requires it (§33).

## 4. Domain model

- **Content object** — the unit. `kind`: `document` or `artifact`. Carries identity, ownership, placement (collection), visibility, provenance origin, current version, lifecycle status.
- **Actor** — every creation/edit is attributed to a `human` or an `agent`. Agents carry an identity (a user they act for, or a service identity).
- **Version** — an immutable snapshot of a body, with its author actor. History is the version list; the object points at the current one.
- **Collection** — a section of the intranet. Simultaneously the navigation grouping, the default visibility, and the retrieval scope.
- **Publication** — a record that a specific version of an object is live at a destination with a visibility.
- **Visibility** — who may consume an object: `private`, `group` (role / building / department / grade / user), `internal` (all authenticated), or `public` (anonymous).
- **Provenance** — who authored what, at two grains: per-character for documents (Proof), per-version for artifacts.

## 5. Key runtime flows

These describe how the layers wire at runtime; later sections give the code.

**Flow A — External agent (delegated) drafts and publishes a document**
1. Agent authenticates via `agent-connect`, obtaining a consent token bound to user *U* with content scopes.
2. Agent calls MCP `create_document(title, collection, markdown)`.
3. `jsonrpc-handler` → tool handler → `contentService.create({kind:'document', ownerUserId:U, createdByActor:'agent', body})`.
4. Service inserts `content_objects` (owner *U*, `created_by_actor='agent'`), creates `content_versions` v1 (`author_actor='agent'`), registers a Proof doc via the doc-store adapter, snapshots markdown + rendered HTML to S3.
5. Agent calls `publish_content(id, 'intranet')` → `publishService.publish` checks visibility/scope, writes `content_publications`, runs the intranet adapter, emits a `content.published` event.
6. Event → retrieval indexer registers/refreshes chunks; the object is now a reader page and scoped context.
7. All tool calls recorded in `nexus_mcp_audit_logs`.

**Flow B — Human edits an agent-drafted document in nexus**
1. User opens the object in the side-panel Proof editor next to chat.
2. Edits stream through Proof's collaborative model; each character is human-authored (green on the rail).
3. On debounce/idle and on publish, the doc-store adapter snapshots a new `content_versions` row (`author_actor='human'`) + S3 markdown/HTML.
4. The agent may continue editing concurrently via `agent-bridge` (violet), with Proof reconciling.

**Flow C — Autonomous scheduled run produces a screen-time report (artifact)**
1. EventBridge Scheduler triggers an Assistant Architect run under a **service identity** holding `content:create` + `content:publish_internal`.
2. The run generates artifact code, calls `create_artifact(...)` then `publish_content(id,'intranet')`.
3. Because the identity lacks `content:publish_public`, it can publish to staff but not to families; a public push would require a human approver.
4. `content.published` event fans out (re-index, notify a Slack/Teams channel).

**Flow D — A scoped assistant answers using published content**
1. An Assistant Architect assistant is configured with retrieval scope = collection "HS · staff guides".
2. On a query, `retrievalService.search(query, requester)` runs semantic search over indexed chunks **filtered by `canView(requester, object)`** and the scope.
3. Staff-only content is returned to a staff user; the same query from a student-facing assistant returns nothing staff-only.

**Flow E — Publish to a public page**
1. User (or agent) requests `publish_content(id, 'public_web')` with `visibility='public'`.
2. The public-publish gate (§26.4) requires a human-held `content:publish_public` scope or an approval step; autonomous agents are blocked here.
3. On approval, the public_web adapter renders/export the version to the public route; `external_ref` stores the public URL.

---

# Part II — Data

## 6. Data model overview and storage split

New tables: `content_objects` (spine), `content_versions` (history), `content_collections` (sections), `content_visibility_grants` (normalized group access), `content_publications` (where live), `agent_identities` (autonomous agents), `content_index_links` (object ↔ retrieval item). Plus enum additions and a `navigation_items` extension.

### 6.1 Storage split — what lives where

| Data | Store | Why |
|---|---|---|
| Object envelope, version index, grants, publications | **Postgres** | Powers listing, nav, permission checks, search filtering |
| Document **live** state (collaborative CRDT, per-char authorship) | **Proof doc-store adapter** (Postgres-backed) | Proof owns its document model; not a flat blob |
| Document canonical markdown + rendered HTML snapshot | **S3** (on save/publish) | Agent-legible source + fast reader render |
| Artifact code (per version) | **S3** (>4 KB) or `body_inline` (small) | Static text blob; no CRDT |
| Artifact rendered preview | client-side sandboxed iframe | Code runs in the browser sandbox, never stored as render |
| Retrieval chunks/embeddings | existing `repository_item_chunks` | Reuse vector search |

**S3 key convention** (single bucket, `atrium/` prefix):
```
atrium/objects/{objectId}/v{n}/source.md          # document markdown
atrium/objects/{objectId}/v{n}/render.html        # document rendered HTML
atrium/objects/{objectId}/v{n}/artifact.{html|jsx}# artifact code
atrium/objects/{objectId}/assets/{assetId}        # embedded images, uploads
```

## 7. Drizzle schema (complete)

> Files live in `lib/db/schema/tables/` and are re-exported from `lib/db/schema/index.ts`. Enums go in `lib/db/schema/enums.ts`. Relations in `lib/db/schema/relations.ts` (if the repo uses Drizzle relations) or inline.

### 7.1 Enums — `lib/db/schema/enums.ts` (additions)

```ts
import { pgEnum } from "drizzle-orm/pg-core";

export const contentKindEnum       = pgEnum("content_kind", ["document", "artifact"]);
export const contentStatusEnum     = pgEnum("content_status", ["draft", "published", "archived"]);
export const actorKindEnum         = pgEnum("actor_kind", ["human", "agent"]);
export const visibilityLevelEnum   = pgEnum("visibility_level", ["private", "group", "internal", "public"]);
export const grantKindEnum         = pgEnum("grant_kind", ["role", "building", "department", "grade", "user"]);
export const bodyFormatEnum        = pgEnum("body_format", ["markdown", "html", "jsx"]);
export const publishDestEnum       = pgEnum("publish_destination", ["intranet", "public_web", "schoology", "google"]);
export const publicationStatusEnum = pgEnum("publication_status", ["live", "scheduled", "unpublished", "failed"]);
export const agentIdentityKindEnum = pgEnum("agent_identity_kind", ["service", "skill"]);

// Extend the EXISTING navigation type enum with a "content" value.
// (If navigationTypeEnum is defined here, add "content" to its value list:
//   pgEnum("navigation_type", ["link", "page", "section", "content"]) )
```

### 7.2 `content_objects` — `lib/db/schema/tables/content-objects.ts`

```ts
import {
  pgTable, uuid, varchar, integer, jsonb, text, timestamp, index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { contentCollections } from "./content-collections";
import {
  contentKindEnum, contentStatusEnum, actorKindEnum, visibilityLevelEnum,
} from "../enums";

export type SourceRef =
  | { type: "upload"; uploadId: string; filename: string }
  | { type: "object"; objectId: string }        // derived from another content object
  | { type: "chat";   conversationId: string }   // produced in a nexus conversation
  | { type: "none" };

export const contentObjects = pgTable("content_objects", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: contentKindEnum("kind").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  ownerUserId: integer("owner_user_id").references(() => users.id).notNull(),
  createdByActor: actorKindEnum("created_by_actor").notNull(),
  createdByAgentId: uuid("created_by_agent_id"),                 // -> agent_identities (autonomous) | null
  collectionId: uuid("collection_id").references(() => contentCollections.id),
  visibilityLevel: visibilityLevelEnum("visibility_level").default("private").notNull(),
  currentVersionId: uuid("current_version_id"),                  // -> content_versions (set after first save)
  sourceRef: jsonb("source_ref").$type<SourceRef>(),
  tags: text("tags").array(),
  status: contentStatusEnum("status").default("draft").notNull(),
  indexedAt: timestamp("indexed_at"),                            // last retrieval-index sync
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("idx_content_owner").on(t.ownerUserId),
  index("idx_content_collection").on(t.collectionId),
  index("idx_content_status_kind").on(t.status, t.kind),
  index("idx_content_visibility").on(t.visibilityLevel),
]);
```

### 7.3 `content_versions` — `lib/db/schema/tables/content-versions.ts`

```ts
import {
  pgTable, uuid, integer, text, varchar, timestamp, unique, index,
} from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { users } from "./users";
import { actorKindEnum, bodyFormatEnum } from "../enums";

export const contentVersions = pgTable("content_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  objectId: uuid("object_id")
    .references(() => contentObjects.id, { onDelete: "cascade" }).notNull(),
  versionNumber: integer("version_number").notNull(),
  authorActor: actorKindEnum("author_actor").notNull(),         // <- artifact provenance grain
  authorUserId: integer("author_user_id").references(() => users.id),
  authorAgentId: uuid("author_agent_id"),
  bodyFormat: bodyFormatEnum("body_format").notNull(),
  bodyLocation: text("body_location").notNull(),                // s3://... | "proof" | "inline"
  bodyInline: text("body_inline"),                              // small artifact code, when location="inline"
  renderLocation: text("render_location"),                      // s3://... rendered HTML (documents)
  proofDocRef: varchar("proof_doc_ref", { length: 255 }),       // documents only: Proof doc id/slug
  summary: text("summary"),                                     // short change note
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("uq_version_object_number").on(t.objectId, t.versionNumber),
  index("idx_version_object").on(t.objectId),
]);
```

### 7.4 `content_collections` — `lib/db/schema/tables/content-collections.ts`

```ts
import { pgTable, uuid, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";
import { navigationItems } from "./navigation-items";
import { visibilityLevelEnum } from "../enums";

export const contentCollections = pgTable("content_collections", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  parentId: uuid("parent_id"),                                  // self-ref tree (FK added in migration)
  defaultVisibilityLevel: visibilityLevelEnum("default_visibility_level").default("internal").notNull(),
  navItemId: integer("nav_item_id").references(() => navigationItems.id),
  position: integer("position").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [index("idx_collection_parent").on(t.parentId)]);
```

### 7.5 `content_visibility_grants` — `lib/db/schema/tables/content-visibility-grants.ts`

```ts
import { pgTable, serial, uuid, varchar, index } from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { grantKindEnum } from "../enums";

// Normalized so permission filtering is indexable (LIST + retrieval need this).
export const contentVisibilityGrants = pgTable("content_visibility_grants", {
  id: serial("id").primaryKey(),
  objectId: uuid("object_id")
    .references(() => contentObjects.id, { onDelete: "cascade" }).notNull(),
  grantKind: grantKindEnum("grant_kind").notNull(),             // role|building|department|grade|user
  grantValue: varchar("grant_value", { length: 255 }).notNull(),
}, (t) => [
  index("idx_cvg_object").on(t.objectId),
  index("idx_cvg_lookup").on(t.grantKind, t.grantValue),
]);
```

### 7.6 `content_publications` — `lib/db/schema/tables/content-publications.ts`

```ts
import { pgTable, uuid, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { contentVersions } from "./content-versions";
import { users } from "./users";
import { publishDestEnum, publicationStatusEnum } from "../enums";

export const contentPublications = pgTable("content_publications", {
  id: uuid("id").defaultRandom().primaryKey(),
  objectId: uuid("object_id")
    .references(() => contentObjects.id, { onDelete: "cascade" }).notNull(),
  destination: publishDestEnum("destination").notNull(),
  publishedVersionId: uuid("published_version_id")
    .references(() => contentVersions.id).notNull(),
  externalRef: text("external_ref"),                            // Schoology/Google id, public URL
  status: publicationStatusEnum("status").default("live").notNull(),
  publishedBy: integer("published_by").references(() => users.id),
  publishedAt: timestamp("published_at").defaultNow().notNull(),
}, (t) => [unique("uq_pub_object_destination").on(t.objectId, t.destination)]);
```

### 7.7 `agent_identities` — `lib/db/schema/tables/agent-identities.ts`

```ts
import { pgTable, uuid, varchar, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { agentIdentityKindEnum } from "../enums";

// Autonomous (non-delegated) agents: service accounts and system skills.
export const agentIdentities = pgTable("agent_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),            // "ship-reporter", "screentime-bot"
  kind: agentIdentityKindEnum("kind").notNull(),               // service | skill
  roleId: integer("role_id").references(() => roles.id),       // its role for content visibility
  scopes: text("scopes").array().notNull(),                    // e.g. ["content:create","content:publish_internal"]
  oauthClientId: varchar("oauth_client_id", { length: 255 }),  // OIDC client-credentials client
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### 7.8 `content_index_links` — `lib/db/schema/tables/content-index-links.ts`

```ts
import { pgTable, serial, uuid, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { repositoryItems } from "./repository-items";

// Maps a content object/version to its retrieval repository_item (reuse existing vector pipeline).
export const contentIndexLinks = pgTable("content_index_links", {
  id: serial("id").primaryKey(),
  objectId: uuid("object_id")
    .references(() => contentObjects.id, { onDelete: "cascade" }).notNull(),
  repositoryItemId: integer("repository_item_id")
    .references(() => repositoryItems.id, { onDelete: "cascade" }).notNull(),
  indexedVersionId: uuid("indexed_version_id"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [unique("uq_index_object").on(t.objectId)]);
```

### 7.9 Re-exports — `lib/db/schema/index.ts`
```ts
export * from "./tables/content-objects";
export * from "./tables/content-versions";
export * from "./tables/content-collections";
export * from "./tables/content-visibility-grants";
export * from "./tables/content-publications";
export * from "./tables/agent-identities";
export * from "./tables/content-index-links";
```

## 8. Migrations

Generate with `drizzle-kit generate` after adding the schema; the representative SQL is below (apply via the repo's migration runner against Aurora).

```sql
-- enums
CREATE TYPE content_kind        AS ENUM ('document','artifact');
CREATE TYPE content_status      AS ENUM ('draft','published','archived');
CREATE TYPE actor_kind          AS ENUM ('human','agent');
CREATE TYPE visibility_level    AS ENUM ('private','group','internal','public');
CREATE TYPE grant_kind          AS ENUM ('role','building','department','grade','user');
CREATE TYPE body_format         AS ENUM ('markdown','html','jsx');
CREATE TYPE publish_destination AS ENUM ('intranet','public_web','schoology','google');
CREATE TYPE publication_status  AS ENUM ('live','scheduled','unpublished','failed');
CREATE TYPE agent_identity_kind AS ENUM ('service','skill');

-- extend existing navigation_type enum
ALTER TYPE navigation_type ADD VALUE IF NOT EXISTS 'content';

-- collections (created first; objects FK to it)
CREATE TABLE content_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  slug varchar(200) NOT NULL UNIQUE,
  parent_id uuid REFERENCES content_collections(id),
  default_visibility_level visibility_level NOT NULL DEFAULT 'internal',
  nav_item_id integer REFERENCES navigation_items(id),
  position integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_collection_parent ON content_collections(parent_id);

CREATE TABLE content_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind content_kind NOT NULL,
  title varchar(500) NOT NULL,
  slug varchar(200) NOT NULL UNIQUE,
  owner_user_id integer NOT NULL REFERENCES users(id),
  created_by_actor actor_kind NOT NULL,
  created_by_agent_id uuid,
  collection_id uuid REFERENCES content_collections(id),
  visibility_level visibility_level NOT NULL DEFAULT 'private',
  current_version_id uuid,
  source_ref jsonb,
  tags text[],
  status content_status NOT NULL DEFAULT 'draft',
  indexed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_content_owner       ON content_objects(owner_user_id);
CREATE INDEX idx_content_collection  ON content_objects(collection_id);
CREATE INDEX idx_content_status_kind ON content_objects(status, kind);
CREATE INDEX idx_content_visibility  ON content_objects(visibility_level);

CREATE TABLE content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  author_actor actor_kind NOT NULL,
  author_user_id integer REFERENCES users(id),
  author_agent_id uuid,
  body_format body_format NOT NULL,
  body_location text NOT NULL,
  body_inline text,
  render_location text,
  proof_doc_ref varchar(255),
  summary text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_version_object_number UNIQUE (object_id, version_number)
);
CREATE INDEX idx_version_object ON content_versions(object_id);

-- deferred FK: objects.current_version_id -> versions.id
ALTER TABLE content_objects
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id) REFERENCES content_versions(id);

CREATE TABLE content_visibility_grants (
  id serial PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  grant_kind grant_kind NOT NULL,
  grant_value varchar(255) NOT NULL
);
CREATE INDEX idx_cvg_object ON content_visibility_grants(object_id);
CREATE INDEX idx_cvg_lookup ON content_visibility_grants(grant_kind, grant_value);

CREATE TABLE content_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  destination publish_destination NOT NULL,
  published_version_id uuid NOT NULL REFERENCES content_versions(id),
  external_ref text,
  status publication_status NOT NULL DEFAULT 'live',
  published_by integer REFERENCES users(id),
  published_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_pub_object_destination UNIQUE (object_id, destination)
);

CREATE TABLE agent_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  kind agent_identity_kind NOT NULL,
  role_id integer REFERENCES roles(id),
  scopes text[] NOT NULL,
  oauth_client_id varchar(255),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE content_index_links (
  id serial PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  repository_item_id integer NOT NULL REFERENCES repository_items(id) ON DELETE CASCADE,
  indexed_version_id uuid,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_index_object UNIQUE (object_id)
);

-- navigation_items: point a nav item at a content object
ALTER TABLE navigation_items ADD COLUMN content_object_id uuid REFERENCES content_objects(id);
```

> Note: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in Postgres; run the enum extension in its own migration step.

## 9. Integration with existing tables

- **users** — `owner_user_id` / `author_user_id` FKs; `building` / `department` / `gradeLevels` feed `group` grants and `canView`.
- **roles** — `grant_kind='role'` stores `roles.id` (as text) in `grant_value`; `agent_identities.role_id` gives autonomous agents a role.
- **navigation_items** — new `content` enum value + `content_object_id`; collections link via `content_collections.nav_item_id`. The existing `requires_role` stays for non-content nav; content pages derive access from object visibility (§12).
- **knowledge_repositories / repository_items / repository_item_chunks / repository_access** — retrieval index (§16) via `content_index_links`; mirror `repository_access` semantics through `content_visibility_grants`.
- **nexus_mcp_audit_logs** — agent content tool calls append here (§27).

## 10. Seed data

Idempotent seed (a migration or `scripts/seed-atrium.ts`):

```ts
// 1. Root collections that mirror the org. (slugs are stable; names editable.)
const seedCollections = [
  { name: "District handbook",  slug: "district-handbook",  defaultVisibilityLevel: "internal" },
  { name: "High School",        slug: "high-school",        defaultVisibilityLevel: "group" },   // grants: building=High School
  { name: "Special Education",  slug: "special-education",  defaultVisibilityLevel: "group" },   // grants: department=Special Education
  { name: "Assessment & data",  slug: "assessment-data",    defaultVisibilityLevel: "group" },
  { name: "Public site",        slug: "public-site",        defaultVisibilityLevel: "public" },
];

// 2. A nav item per collection (type='content' container / section), linked via nav_item_id.

// 3. Autonomous agent identities with conservative scopes.
const seedAgents = [
  { name: "ship-reporter",     kind: "service", scopes: ["content:create","content:publish_internal"] },
  { name: "screentime-bot",    kind: "service", scopes: ["content:create","content:publish_internal"] },
  { name: "tutorial-publisher",kind: "skill",   scopes: ["content:create","content:update"] }, // draft-only
];
// NOTE: none seed with content:publish_public.

// 4. A system knowledge_repository per collection for retrieval scoping (or one shared, filtered by metadata).
```

---

# Part III — Services

The service layer (`lib/content/`) is the **single implementation** every surface calls — server actions, REST handlers, and MCP tool handlers are thin wrappers over it. This is the spine from §1.

```
lib/content/
  content-service.ts      # create / get / list / update objects
  version-service.ts      # snapshot versions, rollback
  visibility-service.ts   # canView, grants, query filters
  publish-service.ts      # publish/unpublish, adapters, gate
  retrieval-service.ts    # index on publish, permission-aware search
  storage/
    s3-store.ts           # S3 read/write for bodies + renders
    proof-store.ts        # Proof doc-store adapter (Postgres-backed)
  render/
    markdown-render.ts    # markdown -> sanitized styled HTML
  publish-adapters/
    intranet.ts  public-web.ts  schoology.ts  google.ts
  events.ts               # emit content.* events (SNS/EventBridge)
  types.ts
```

## 11. Service layer architecture

### 11.1 Caller context
Every service call takes a `Requester` so identity/permission is uniform across surfaces.

```ts
// lib/content/types.ts
export type Requester =
  | { kind: "user"; userId: number; roles: string[]; building?: string;
      department?: string; gradeLevels?: string[]; isAdmin: boolean }
  | { kind: "agent-delegated"; actingForUserId: number; roles: string[]; building?: string;
      department?: string; gradeLevels?: string[]; scopes: string[]; agentLabel: string }
  | { kind: "agent-autonomous"; agentId: string; roleId?: number; roles: string[];
      scopes: string[]; agentLabel: string };

export interface CreateObjectInput {
  kind: "document" | "artifact";
  title: string;
  collectionId?: string;
  body?: string;                       // markdown (doc) | code (artifact)
  bodyFormat?: "markdown" | "html" | "jsx";
  visibility?: VisibilityInput;        // defaults to collection default
  tags?: string[];
  sourceRef?: SourceRef;
}
export interface VisibilityInput {
  level: "private" | "group" | "internal" | "public";
  grants?: { kind: "role"|"building"|"department"|"grade"|"user"; value: string }[];
}
```

### 11.2 content-service (create/get/list/update)

```ts
// lib/content/content-service.ts  (abridged; runs through executeQuery/executeTransaction)
export const contentService = {
  async create(req: Requester, input: CreateObjectInput): Promise<ContentObject> {
    assertCanCreate(req);                                   // §26.3 scope check
    const ownerUserId = ownerFor(req);                      // delegated -> actingForUserId; autonomous -> system owner
    const slug = await uniqueSlug(input.title);
    const actor = actorKindOf(req);                         // "human" | "agent"

    return executeTransaction(async (tx) => {
      const [obj] = await tx.insert(contentObjects).values({
        kind: input.kind, title: input.title, slug, ownerUserId,
        createdByActor: actor,
        createdByAgentId: req.kind === "agent-autonomous" ? req.agentId : null,
        collectionId: input.collectionId,
        visibilityLevel: input.visibility?.level
          ?? (await collectionDefault(input.collectionId)) ?? "private",
        status: "draft",
        sourceRef: input.sourceRef ?? { type: "none" },
        tags: input.tags ?? [],
      }).returning();

      await visibilityService.applyGrants(tx, obj.id, input.visibility?.grants ?? []);

      if (input.body !== undefined) {
        const v = await versionService.snapshot(tx, req, obj, {
          body: input.body,
          bodyFormat: input.bodyFormat ?? (input.kind === "document" ? "markdown" : "html"),
        });
        await tx.update(contentObjects)
          .set({ currentVersionId: v.id }).where(eq(contentObjects.id, obj.id));
      }
      return obj;
    }, "content.create");
  },

  async get(req: Requester, idOrSlug: string): Promise<ContentObjectWithVersion> {
    const obj = await loadByIdOrSlug(idOrSlug);
    if (!await visibilityService.canView(req, obj)) throw new ForbiddenError();
    const version = await versionService.current(obj);
    return { ...obj, version };
  },

  async list(req: Requester, filter: ListFilter): Promise<ContentObject[]> {
    // Permission filtering is pushed into SQL (see §12.3) so we never load then drop.
    return visibilityService.listVisible(req, filter);
  },

  async update(req: Requester, id: string, patch: UpdatePatch): Promise<ContentObject> {
    const obj = await loadById(id);
    assertCanEdit(req, obj);                                // owner, admin, or delegated owner
    // metadata-only patch (title, tags, collection, status). Body changes go through versionService.snapshot.
    const [updated] = await db.update(contentObjects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(contentObjects.id, id)).returning();
    return updated;
  },
};
```

## 12. Permissions and visibility

### 12.1 The model
Two orthogonal axes: **visibility** (who may consume) and **destination** (where surfaced, §15). Visibility = `level` ∈ {private, group, internal, public}; for `group`, specific grants in `content_visibility_grants` keyed by role / building / department / grade / user.

### 12.2 `canView` (the predicate, enforced everywhere)

```ts
// lib/content/visibility-service.ts
export const visibilityService = {
  async canView(req: Requester, obj: ContentObject): Promise<boolean> {
    if (obj.visibilityLevel === "public") return true;
    if (req.kind === "agent-autonomous" && !req.roles?.length && obj.visibilityLevel !== "public") {
      // autonomous agents see only what their role grants; fall through to grant checks
    }
    const principal = principalOf(req);                     // {userId?, roles, building, department, gradeLevels}
    if (!principal) return false;                           // unauthenticated
    if (obj.visibilityLevel === "internal") return true;    // any authenticated principal
    if (principal.isAdmin) return true;
    if (principal.userId && principal.userId === obj.ownerUserId) return true;

    if (obj.visibilityLevel === "private") {
      return await hasUserGrant(obj.id, principal.userId);  // explicit per-user grant
    }
    // group:
    const grants = await grantsFor(obj.id);
    return grants.some((g) =>
      (g.grantKind === "role"       && principal.roles.includes(g.grantValue)) ||
      (g.grantKind === "building"   && principal.building === g.grantValue) ||
      (g.grantKind === "department" && principal.department === g.grantValue) ||
      (g.grantKind === "grade"      && (principal.gradeLevels ?? []).includes(g.grantValue)) ||
      (g.grantKind === "user"       && String(principal.userId) === g.grantValue)
    );
  },

  async applyGrants(tx, objectId, grants) { /* delete + insert content_visibility_grants */ },
};
```

### 12.3 Permission-pushed `list` (no load-then-drop)
The same predicate expressed in SQL, so listing and retrieval scale and never leak:

```sql
-- listVisible(principal, filter): visible objects for a user principal
SELECT o.* FROM content_objects o
WHERE o.status <> 'archived'
  AND (
    o.visibility_level = 'public'
    OR o.visibility_level = 'internal'
    OR o.owner_user_id = :userId
    OR (o.visibility_level = 'group' AND EXISTS (
        SELECT 1 FROM content_visibility_grants g
        WHERE g.object_id = o.id AND (
             (g.grant_kind='role'       AND g.grant_value = ANY(:roleIds))
          OR (g.grant_kind='building'   AND g.grant_value = :building)
          OR (g.grant_kind='department' AND g.grant_value = :department)
          OR (g.grant_kind='grade'      AND g.grant_value = ANY(:gradeLevels))
          OR (g.grant_kind='user'       AND g.grant_value = :userIdText)
        )))
    OR EXISTS (SELECT 1 FROM content_visibility_grants g2
               WHERE g2.object_id=o.id AND g2.grant_kind='user' AND g2.grant_value=:userIdText)
  )
  -- + optional filters: collection_id, kind, tag = ANY(tags), status
ORDER BY o.updated_at DESC;
```

### 12.4 Enforcement points (all required)
`canView` (or its SQL form) gates: reader render, list/nav/search results, **retrieval results** (§16 — the safety boundary), and publish-widening. `assertCanEdit` gates body/metadata writes. The public-publish scope gate is §26.4.

### 12.5 Relation to existing RBAC
`capabilities`/`role_capabilities` gate **features** (who sees the editor/admin). Content visibility gates **content**. They stay separate; visibility consumes roles + user attributes. Atrium ships without waiting on the in-progress capability refactor.

## 13. Storage adapters

### 13.1 S3 store
```ts
// lib/content/storage/s3-store.ts
export const s3Store = {
  key(objectId: string, version: number, file: string) {
    return `atrium/objects/${objectId}/v${version}/${file}`;
  },
  async putText(key: string, body: string, contentType: string) { /* PutObject */ },
  async getText(key: string): Promise<string> { /* GetObject */ },
  async signedReadUrl(key: string, ttl = 300): Promise<string> { /* presign */ },
};
```

### 13.2 Proof doc-store adapter
Proof persists collaborative document state through a pluggable store; replace `doc-store-sqlite` with this. **Confirm the exact interface against `proof-sdk` (§33).** Intended shape:

```ts
// lib/content/storage/proof-store.ts
// Implements Proof's DocStore so Proof's CRDT/document state lives in Postgres,
// keyed by the Atrium content object. One Proof doc per document content object.
export class AtriumProofStore /* implements ProofDocStore */ {
  async load(docId: string): Promise<ProofDocState | null> { /* read CRDT snapshot blob from proof_doc_state */ }
  async save(docId: string, state: ProofDocState): Promise<void> { /* upsert CRDT snapshot */ }
  // on debounce/idle and on publish, also snapshot canonical markdown+HTML:
  async snapshotCanonical(objectId: string): Promise<void> {
    const md = await this.exportMarkdown(objectId);         // Proof -> markdown
    const v  = await versionService.snapshotFromProof(objectId, md);
    const html = renderMarkdown(md);                        // §18 pipeline
    await s3Store.putText(s3Store.key(objectId, v.versionNumber, "source.md"), md, "text/markdown");
    await s3Store.putText(s3Store.key(objectId, v.versionNumber, "render.html"), html, "text/html");
  }
}
```
Add a small `proof_doc_state` table (or reuse S3) for the CRDT snapshot; decision in §33. Snapshot cadence: debounced idle + on publish, **never per keystroke**.

## 14. Versioning

```ts
// lib/content/version-service.ts
export const versionService = {
  async snapshot(tx, req, obj, { body, bodyFormat }): Promise<ContentVersion> {
    const next = (await maxVersion(tx, obj.id)) + 1;
    const inline = obj.kind === "artifact" && body.length <= 4096;
    const loc = obj.kind === "document" ? "proof"
              : inline ? "inline"
              : await putArtifact(obj.id, next, body, bodyFormat);    // s3://...
    const [v] = await tx.insert(contentVersions).values({
      objectId: obj.id, versionNumber: next,
      authorActor: actorKindOf(req),
      authorUserId: userIdOf(req), authorAgentId: agentIdOf(req),
      bodyFormat, bodyLocation: loc,
      bodyInline: inline ? body : null,
      renderLocation: obj.kind === "document" ? await putRender(obj.id, next, body) : null,
      summary: undefined,
    }).returning();
    await tx.update(contentObjects)
      .set({ currentVersionId: v.id, updatedAt: new Date() })
      .where(eq(contentObjects.id, obj.id));
    return v;
  },

  async rollback(req, objectId, toVersionId) {
    const obj = await loadById(objectId); assertCanEdit(req, obj);
    await db.update(contentObjects).set({ currentVersionId: toVersionId }).where(eq(contentObjects.id, objectId));
    // optionally re-publish current destinations with the rolled-back version
  },

  async current(obj): Promise<ContentVersion> { /* load currentVersionId */ },
};
```
Versions are immutable; `currentVersionId` is the working head, `content_publications.published_version_id` is what's live (may lag head). The "travel back" UI lists versions with author + summary.

## 15. Publishing pipeline

### 15.1 Adapter interface
```ts
// lib/content/publish-adapters/types.ts
export interface PublishAdapter {
  destination: "intranet" | "public_web" | "schoology" | "google";
  publish(ctx: PublishContext): Promise<{ externalRef?: string }>;
  unpublish(ctx: PublishContext): Promise<void>;
}
export interface PublishContext {
  object: ContentObject; version: ContentVersion; visibility: VisibilityInput; req: Requester;
}
```

### 15.2 v1 adapters
```ts
// intranet.ts — content already lives in the store; "publish" makes the version live at its reader route.
export const intranetAdapter: PublishAdapter = {
  destination: "intranet",
  async publish({ object, version }) {
    // ensure a nav item of type 'content' points at the object (auto-create under its collection)
    await ensureNavItem(object);
    return {}; // reader route renders published_version_id
  },
  async unpublish({ object }) { await hideNavItem(object); },
};

// public-web.ts — render the version to a public (anonymous) route / static export.
export const publicWebAdapter: PublishAdapter = {
  destination: "public_web",
  async publish({ object, version }) {
    const html = object.kind === "document"
      ? await s3Store.getText(s3Store.key(object.id, version.versionNumber, "render.html"))
      : await wrapArtifactForPublic(object, version);          // sandboxed standalone page
    const url = await publishPublicRoute(object.slug, html);   // e.g. CloudFront/S3 public prefix
    return { externalRef: url };
  },
  async unpublish({ object }) { await removePublicRoute(object.slug); },
};
```
`schoology.ts` / `google.ts` are stubs in v1, implemented later over `lib/mcp/connector-service.ts` + the existing OAuth connectors.

### 15.3 publish-service (the atomic action + gate + event)
```ts
// lib/content/publish-service.ts
const adapters: Record<string, PublishAdapter> = {
  intranet: intranetAdapter, public_web: publicWebAdapter,
  schoology: schoologyAdapter, google: googleAdapter,
};

export const publishService = {
  async publish(req: Requester, objectId: string, destination: PublishDest, visibility?: VisibilityInput) {
    const obj = await loadById(objectId);
    assertCanEdit(req, obj);
    const vis = visibility ?? { level: obj.visibilityLevel };

    // PUBLIC-PUBLISH GATE (§26.4)
    if (isPublicFacing(destination, vis) && !canPublishPublic(req)) {
      throw new ApprovalRequiredError("Public publishing requires a human approver / content:publish_public");
    }
    if (visibility) await visibilityService.setLevel(obj.id, vis); // update object visibility if widening/narrowing

    const version = await versionService.current(obj);
    const { externalRef } = await adapters[destination].publish({ object: obj, version, visibility: vis, req });

    await db.insert(contentPublications).values({
      objectId: obj.id, destination, publishedVersionId: version.id,
      externalRef, status: "live", publishedBy: userIdOf(req),
    }).onConflictDoUpdate({
      target: [contentPublications.objectId, contentPublications.destination],
      set: { publishedVersionId: version.id, externalRef, status: "live", publishedAt: new Date(), publishedBy: userIdOf(req) },
    });
    await db.update(contentObjects).set({ status: "published" }).where(eq(contentObjects.id, obj.id));

    await events.emit("content.published", { objectId: obj.id, destination, versionId: version.id });
    return { destination, externalRef };
  },

  async unpublish(req, objectId, destination) { /* adapter.unpublish + mark publication unpublished + event */ },
};
```

## 16. Retrieval — content as scoped context

### 16.1 Index on publish / new version
Reuse the existing repository pipeline. On `content.published` (and on new published version), register/refresh a `repository_item` and chunk it; link via `content_index_links`.

```ts
// lib/content/retrieval-service.ts
export const retrievalService = {
  async indexObject(objectId: string) {
    const obj = await loadById(objectId);
    if (obj.status !== "published") return;
    const v = await versionService.current(obj);
    const text = obj.kind === "document"
      ? await s3Store.getText(s3Store.key(obj.id, v.versionNumber, "source.md"))
      : await extractArtifactText(obj, v);                 // strip code -> visible text/labels for search
    const item = await upsertRepositoryItem({
      objectId: obj.id, name: obj.title, source: `atrium:${obj.slug}`,
      metadata: {                                          // <-- filterable retrieval metadata
        objectId: obj.id, kind: obj.kind, collectionId: obj.collectionId,
        visibilityLevel: obj.visibilityLevel, tags: obj.tags,
        grants: await grantsFor(obj.id),                   // mirror for fast filtering
      },
    });
    await chunkAndEmbed(item.id, text);                    // existing repository_item_chunks pipeline
    await linkIndex(obj.id, item.id, v.id);
    await db.update(contentObjects).set({ indexedAt: new Date() }).where(eq(contentObjects.id, obj.id));
  },

  // 16.2 Permission-aware search (the safety boundary)
  async search(req: Requester, query: string, scope?: { collectionId?: string; tags?: string[] }) {
    const hits = await semanticSearch(query, scope);       // existing vector search
    const visible: Hit[] = [];
    for (const h of hits) {
      const obj = await loadById(h.metadata.objectId);
      if (await visibilityService.canView(req, obj)) visible.push(h);  // never return what the requester can't see
    }
    return visible;
  },
};
```

### 16.3 Two retrieval modes
- **Semantic chunks (RAG)** — `retrievalService.search`, returns ranked chunks for "answer from this content."
- **Whole-object injection** — `getContextDocument(objectId)` returns full markdown/text verbatim (the `context.md` pattern) for "use this exact playbook/one-pager."

### 16.4 Assistant scoping
An Assistant Architect assistant stores a retrieval scope (`collectionId` and/or `tags`, and an optional max visibility tier). At query time, scope narrows candidates and `canView` enforces per-requester access — so the same content store safely serves staff and student assistants.

---

# Part IV — Surfaces

Two authoring surfaces render in a **side panel beside nexus chat** (the Claude-on-web layout); the object's `kind` selects the panel. Reader views are separate, read-only RSC routes. All write paths call the §11–§15 services through server actions — there is no UI-only logic.

## 17. Authoring layout

```
app/(protected)/nexus/[conversationId]/page.tsx
  <NexusLayout>
    <ChatPane/>                 # existing assistant-ui Thread + composer
    <WorkspacePanel objectId>   # NEW: opens when a content object is active
       kind === "document" ? <DocumentEditor/> : <ArtifactCanvas/>
```

- The panel opens when chat creates or references an object (the agent's `create_*` tool result includes the object id/slug), or when the user opens one from the content library.
- Shared chrome at the top of the panel (both kinds): `title`, version control, a **VisibilityChip** (opens the visibility editor — level picker + group-grant builder, §12), and one **Publish** button (opens a destination picker; public-facing choices show the approval note).
- The panel is resizable/collapsible; on mobile it stacks below chat.

```tsx
// components/atrium/WorkspacePanel.tsx (client)
export function WorkspacePanel({ objectId }: { objectId: string }) {
  const { object } = useContentObject(objectId);          // SWR over GET /v1/content/{id} (server action variant)
  if (!object) return <PanelSkeleton/>;
  return (
    <div className="atrium-panel">
      <PanelHeader object={object}/>                       {/* title, VersionMenu, VisibilityChip, PublishButton */}
      {object.kind === "document"
        ? <DocumentEditor object={object}/>
        : <ArtifactCanvas object={object}/>}
    </div>
  );
}
```

## 18. Document editor (Proof)

### 18.1 Integration
- Mount Proof's `doc-editor` bound to the object's Proof doc (`proof_doc_ref`), backed by the `AtriumProofStore` (§13.2). Proof provides the rich editor, comments, track changes, collaborative cursors, and the **per-character provenance rail** (green = human, violet = agent).
- Agent edits arrive through Proof's `agent-bridge` HTTP interface; wire its `X-Agent-Id` presence to the Atrium agent label so agent edits render violet.
- Authors edit **markdown/WYSIWYG only** — never raw HTML.

```tsx
// components/atrium/DocumentEditor.tsx (client)
export function DocumentEditor({ object }: { object: ContentObject }) {
  // ProofEditor handles realtime state; onIdle triggers the canonical snapshot (server action).
  return (
    <ProofEditor
      docId={object.proofDocRef}
      store={atriumProofClient}
      agentBridgeUrl={`/api/content/${object.id}/agent-bridge`}
      onIdle={() => snapshotDocumentAction(object.id)}     // debounced -> versionService + S3
      provenanceRail
      comments
    />
  );
}
```

### 18.2 Markdown → styled HTML render pipeline
Richness comes from the renderer, not hand-written HTML. Use `remark`/`rehype` with a **strict sanitizer** and a curated component/CSS set; the same pipeline feeds reader views and `public_web`.

```ts
// lib/content/render/markdown-render.ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

const SCHEMA = {                                            // allowlist; no <script>, no inline event handlers
  tagNames: ["h1","h2","h3","h4","p","ul","ol","li","strong","em","a","blockquote",
             "table","thead","tbody","tr","th","td","code","pre","img","hr",
             "div","span"],                                 // div/span limited to known callout classes
  attributes: { a: ["href","title"], img: ["src","alt"], "*": ["className"] },
  protocols: { href: ["http","https","mailto"], src: ["https"] },
  className: ["callout","callout-warn","callout-info","badge"],  // district components via markdown directives
};

export function renderMarkdown(md: string): string {
  return unified()
    .use(remarkParse).use(remarkGfm)
    .use(remarkDirectives)                                  // :::callout ... ::: -> <div class="callout">
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeStringify)
    .processSync(md).toString();
}
```
District styling is a single stylesheet (`styles/atrium-content.css`) applied wherever rendered HTML appears — headings, callouts, tables, badges, logo lockups. A small set of **markdown directives** (`:::callout`, `:::warn`) gives authors and agents rich blocks without HTML.

## 19. Artifact canvas (assistant-ui)

### 19.1 Components
Build on assistant-ui's open-source Claude-Artifacts pattern: a `Preview | Code` toggle, a version dropdown, live render in a sandboxed iframe, and re-prompt via the adjacent chat.

```tsx
// components/atrium/ArtifactCanvas.tsx (client)
export function ArtifactCanvas({ object }: { object: ContentObject }) {
  const [tab, setTab] = useState<"preview"|"code">("preview");
  const { version, setVersion, versions } = useVersions(object.id);
  const code = useArtifactCode(object.id, version.id);     // from S3 or inline

  return (
    <>
      <CanvasToolbar tab={tab} onTab={setTab} versions={versions} active={version} onVersion={setVersion}/>
      {tab === "preview"
        ? <ArtifactSandbox code={code}/>                    {/* §19.2 */}
        : <CodeEditor value={code}                          {/* CodeMirror 6 */}
            onSave={(next) => createVersionAction(object.id, { body: next, bodyFormat: object.bodyFormat })}/>}
      <CanvasTip>Tweak by asking in chat — or edit code directly.</CanvasTip>
    </>
  );
}
```
- **Code editor:** CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-html`, `@codemirror/lang-javascript`). Direct edits call `createVersion` (human-authored version).
- **Re-prompt path:** chat messages that modify the artifact call `create_version` (agent-authored). This is the primary tweak path for most users (§foregrounded).

### 19.2 Sandbox (security-critical, see §28)
Artifact code is **untrusted** and renders only in a cross-origin sandboxed iframe with a strict CSP and no access to the AI Studio session.

```tsx
// components/atrium/ArtifactSandbox.tsx
export function ArtifactSandbox({ code }: { code: string }) {
  // Served from a SEPARATE origin (e.g. artifacts.psd-domain) so it shares nothing with the app origin.
  const src = `${ARTIFACT_SANDBOX_ORIGIN}/render`;          // posts code via postMessage after load
  return (
    <iframe
      title="Artifact preview"
      src={src}
      sandbox="allow-scripts"                                {/* NO allow-same-origin */}
      referrerPolicy="no-referrer"
      onLoad={(e) => e.currentTarget.contentWindow?.postMessage({ type: "render", code }, ARTIFACT_SANDBOX_ORIGIN)}
    />
  );
}
```
The sandbox origin serves a minimal host page with CSP `default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; img-src https: data:` (tune the allowlist for libraries you permit). The host injects the posted `code` into the document body. Because there is no `allow-same-origin`, the iframe cannot read app cookies, localStorage, or call first-party APIs.

## 20. Reader views

Published content is consumed through read-only RSC routes — no editor, no rail, with a provenance footer.

```
app/(protected)/c/[slug]/page.tsx        # internal reader (authenticated, visibility-checked)
app/(public)/p/[slug]/page.tsx           # public reader (anonymous; only visibility='public')
```

```tsx
// app/(protected)/c/[slug]/page.tsx  (RSC)
export default async function ContentPage({ params }: { params: { slug: string } }) {
  const req = await requesterFromSession();                 // user principal
  const obj = await contentService.getBySlug(req, params.slug); // throws Forbidden if !canView
  const v = await versionService.published(obj, "intranet") ?? await versionService.current(obj);

  return (
    <ReaderShell collection={obj.collectionId}>
      {obj.kind === "document"
        ? <RenderedHtml src={await s3Store.getText(s3Store.key(obj.id, v.versionNumber, "render.html"))}/>
        : <ArtifactSandbox code={await loadArtifactCode(obj, v)}/>}
      <ProvenanceFooter object={obj}/>
    </ReaderShell>
  );
}
```

```tsx
// components/atrium/ProvenanceFooter.tsx
// "AI-assisted draft · reviewed & published by J. Rivera · Apr 2026"
// derived from created_by_actor + the publishing human (content_publications.published_by)
```

## 21. Navigation and information architecture

- **Extend `navigation_items`** (done in §8): a `content` type + `content_object_id`. A nav item can point at a content object (a page) or, with `content_collections.nav_item_id`, represent a section.
- **Collection tree = intranet section tree.** Reader sidebar renders the collection tree filtered by `canView` over each collection's default visibility (and the user's grants), so users only see sections they can enter.
- **Auto-nav on publish to intranet:** `ensureNavItem(object)` (called by the intranet adapter) creates/updates a `content` nav item under the object's collection.
- **Vocabulary:** user-facing units are **docs** and **artifacts**; sections are **collections**. `page` (tool-grid hub) and `agent-workspace` (credential consent) keep their existing meanings.
- **Library view:** `app/(protected)/atrium/page.tsx` — a permission-filtered library of the user's and visible objects (search, filter by kind/collection/tag, "new doc / new artifact" which call `contentService.create`).

---

# Part V — Agent access

## 22. The content API principle

The §11–§15 service layer is the **source of truth**. Three channels expose it; each is a thin wrapper that builds a `Requester` and calls the same services:

- **MCP tools** — for Claude Code, Cowork, Codex, any MCP client (§24).
- **REST API v1** — for scripts and non-MCP apps (§23).
- **Skills + scheduled Assistant Architect runs** — the autonomous automation path (§25).

The in-app editors (Part IV) call the same services via server actions. There is no fourth, privileged path.

## 23. REST API v1 — OpenAPI

Routes live under `app/api/v1/content/*`, follow the existing v1 conventions (`sk-` API keys or OIDC bearer, rate limiting, audit), and mirror the MCP tools 1:1.

```yaml
openapi: 3.1.0
info: { title: Atrium Content API, version: "1.0" }
servers: [{ url: https://{host}/api/v1 }]
security: [{ apiKey: [] }, { oauth: [content] }]
components:
  securitySchemes:
    apiKey: { type: apiKey, in: header, name: Authorization }   # "Bearer sk-..."
    oauth:  { type: oauth2, flows: { clientCredentials: { tokenUrl: /oauth/token, scopes: {
              "content:create": "create content", "content:update": "update content",
              "content:publish_internal": "publish internally", "content:publish_public": "publish publicly" } } } }
  schemas:
    Visibility:
      type: object
      required: [level]
      properties:
        level: { type: string, enum: [private, group, internal, public] }
        grants:
          type: array
          items:
            type: object
            required: [kind, value]
            properties:
              kind:  { type: string, enum: [role, building, department, grade, user] }
              value: { type: string }
    ContentObject:
      type: object
      properties:
        id: { type: string, format: uuid }
        kind: { type: string, enum: [document, artifact] }
        title: { type: string }
        slug: { type: string }
        collectionId: { type: string, format: uuid, nullable: true }
        visibility: { $ref: "#/components/schemas/Visibility" }
        status: { type: string, enum: [draft, published, archived] }
        createdByActor: { type: string, enum: [human, agent] }
        currentVersion: { $ref: "#/components/schemas/Version" }
        tags: { type: array, items: { type: string } }
    Version:
      type: object
      properties:
        id: { type: string, format: uuid }
        versionNumber: { type: integer }
        authorActor: { type: string, enum: [human, agent] }
        bodyFormat: { type: string, enum: [markdown, html, jsx] }
        summary: { type: string, nullable: true }
paths:
  /content:
    get:
      summary: List visible content (permission-filtered)
      parameters:
        - { name: kind,       in: query, schema: { type: string, enum: [document, artifact] } }
        - { name: collection, in: query, schema: { type: string } }
        - { name: tag,        in: query, schema: { type: string } }
        - { name: status,     in: query, schema: { type: string } }
        - { name: q,          in: query, schema: { type: string }, description: "text search" }
      responses: { "200": { description: OK, content: { application/json: { schema:
        { type: array, items: { $ref: "#/components/schemas/ContentObject" } } } } } }
    post:
      summary: Create a content object
      requestBody:
        required: true
        content: { application/json: { schema:
          { type: object, required: [kind, title], properties: {
            kind: { type: string, enum: [document, artifact] },
            title: { type: string },
            collectionId: { type: string },
            body: { type: string, description: "markdown for document, code for artifact" },
            bodyFormat: { type: string, enum: [markdown, html, jsx] },
            visibility: { $ref: "#/components/schemas/Visibility" },
            tags: { type: array, items: { type: string } } } } } }
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/ContentObject" } } } }
        "403": { description: Missing content:create scope }
  /content/{id}:
    get:    { summary: Get object + current version, responses: { "200": { description: OK }, "403": { description: Not visible } } }
    patch:  { summary: Update metadata (title, tags, collection, status), responses: { "200": { description: OK } } }
  /content/{id}/versions:
    get:  { summary: List versions }
    post:
      summary: Create a new version (body + summary)
      requestBody: { required: true, content: { application/json: { schema:
        { type: object, required: [body], properties: {
          body: { type: string }, bodyFormat: { type: string }, summary: { type: string } } } } } }
      responses: { "201": { description: Version created } }
  /content/{id}/visibility:
    patch:
      summary: Set visibility level and grants
      requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/Visibility" } } } }
      responses: { "200": { description: Updated } }
  /content/{id}/publish:
    post:
      summary: Publish to a destination
      requestBody: { required: true, content: { application/json: { schema:
        { type: object, required: [destination], properties: {
          destination: { type: string, enum: [intranet, public_web, schoology, google] },
          visibility: { $ref: "#/components/schemas/Visibility" } } } } }
      responses:
        "200": { description: Published, content: { application/json: { schema:
          { type: object, properties: { destination: { type: string }, externalRef: { type: string } } } } } }
        "202": { description: Approval required (public publishing), content: { application/json: { schema:
          { type: object, properties: { status: { const: approval_required } } } } } }
        "403": { description: Missing publish scope }
  /content/{id}/publish/{destination}:
    delete: { summary: Unpublish from a destination, responses: { "200": { description: Unpublished } } }
```

## 24. MCP tools

Register in `lib/mcp/custom-tools/registry.ts` (alongside the existing five tools), handled by `lib/mcp/tool-handlers.ts`. Each tool builds a `Requester` from the MCP session (delegated user or autonomous identity, §26) and calls the §11–§15 services. **Tools are atomic — there is no `generate_and_publish`.**

```jsonc
// Tool input schemas (MCP JSON Schema). Names are stable.
[
  {
    "name": "create_document",
    "description": "Create a document (markdown) content object. Does not publish.",
    "inputSchema": {
      "type": "object",
      "required": ["title"],
      "properties": {
        "title": { "type": "string" },
        "collection": { "type": "string", "description": "collection slug or id" },
        "markdown": { "type": "string", "description": "initial body; markdown only" },
        "visibility": {
          "type": "object",
          "properties": {
            "level": { "type": "string", "enum": ["private","group","internal","public"] },
            "grants": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "kind": { "type": "string", "enum": ["role","building","department","grade","user"] },
                "value": { "type": "string" } } } } }
        },
        "tags": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  {
    "name": "create_artifact",
    "description": "Create an interactive artifact (HTML/JS or JSX) content object. Does not publish.",
    "inputSchema": {
      "type": "object",
      "required": ["title","code","bodyFormat"],
      "properties": {
        "title": { "type": "string" },
        "collection": { "type": "string" },
        "code": { "type": "string" },
        "bodyFormat": { "type": "string", "enum": ["html","jsx"] },
        "visibility": { "$ref": "#/$defs/visibility" },
        "tags": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  {
    "name": "get_content",
    "description": "Fetch a content object and its current version by id or slug. Permission-checked.",
    "inputSchema": { "type": "object", "required": ["idOrSlug"],
      "properties": { "idOrSlug": { "type": "string" } } }
  },
  {
    "name": "list_content",
    "description": "List content the caller may view. Filterable by kind, collection, tag, status, text.",
    "inputSchema": { "type": "object", "properties": {
      "kind": { "type": "string", "enum": ["document","artifact"] },
      "collection": { "type": "string" }, "tag": { "type": "string" },
      "status": { "type": "string", "enum": ["draft","published","archived"] },
      "query": { "type": "string" } } }
  },
  {
    "name": "update_content",
    "description": "Update object metadata (title, tags, collection, status). Body changes use create_version.",
    "inputSchema": { "type": "object", "required": ["id"], "properties": {
      "id": { "type": "string" }, "title": { "type": "string" },
      "tags": { "type": "array", "items": { "type": "string" } },
      "collection": { "type": "string" },
      "status": { "type": "string", "enum": ["draft","published","archived"] } } }
  },
  {
    "name": "create_version",
    "description": "Add a new version with new body content and an optional change summary.",
    "inputSchema": { "type": "object", "required": ["id","body"], "properties": {
      "id": { "type": "string" }, "body": { "type": "string" },
      "bodyFormat": { "type": "string", "enum": ["markdown","html","jsx"] },
      "summary": { "type": "string" } } }
  },
  {
    "name": "set_visibility",
    "description": "Set who can view the object (level + group grants).",
    "inputSchema": { "type": "object", "required": ["id","level"], "properties": {
      "id": { "type": "string" },
      "level": { "type": "string", "enum": ["private","group","internal","public"] },
      "grants": { "type": "array", "items": { "$ref": "#/$defs/grant" } } } }
  },
  {
    "name": "publish_content",
    "description": "Publish a content object to a destination. Public destinations require a human-held scope.",
    "inputSchema": { "type": "object", "required": ["id","destination"], "properties": {
      "id": { "type": "string" },
      "destination": { "type": "string", "enum": ["intranet","public_web","schoology","google"] } } }
  }
]
```
Tool results return the object id, slug, and a deep link to the panel/reader; `publish_content` returns `external_ref` or an `approval_required` signal. On a missing scope (e.g. autonomous agent attempting `public_web`), the handler returns a structured error the agent can relay, not a silent failure.

## 25. Skills and scheduled runs

The same tools are callable inside skills and **scheduled Assistant Architect runs** — the autonomous production path. A scheduled run produces content and ends by publishing internally.

```jsonc
// Example: weekly SHIP-cycle update (Assistant Architect scheduled run, service identity "ship-reporter")
{
  "schedule": "cron(0 7 ? * MON *)",
  "identity": "ship-reporter",                      // scopes: content:create, content:publish_internal
  "steps": [
    "Summarize this week's SHIP cycle from {{sources}} into a one-page update.",
    "Call create_document(title, collection='district-handbook/ship', markdown=<result>, visibility={level:'internal'}).",
    "Call publish_content(id, 'intranet')."
  ]
}
```
Because `ship-reporter` lacks `content:publish_public`, the update reaches all staff but cannot be pushed to families/public without a human. Screen-time reports, recurring briefs, and "publish my AI-book notes as tutorials" follow the same pattern (the tutorial skill is draft-only — a human publishes).

## 26. Agent identity and authorization

### 26.1 Two identity modes
- **Delegated (on behalf of a person):** the agent authenticates through the existing `agent-connect` / `consent-token` flow and receives a `Requester` of kind `agent-delegated` bound to user *U*. It **inherits exactly U's permissions**; created content is owned by U and shareable only as far as U can share. (My-agent-drafts-my-brief.)
- **Autonomous (service identity):** a row in `agent_identities` with its own `role_id` and `scopes`, authenticated via **OAuth client-credentials** on the existing OIDC provider (`oauthClientId`). Produces a `Requester` of kind `agent-autonomous`.

### 26.2 Scopes
```
content:create            create objects + versions
content:update            edit metadata, add versions
content:publish_internal  publish to intranet (internal/group visibility)
content:publish_public    publish to public_web / family-facing destinations   <-- withheld by default
```

### 26.3 Authorization checks (where scopes bite)
```ts
function assertCanCreate(req: Requester) {
  if (req.kind === "user") return;                          // UI users gated by feature capability
  if (!req.scopes.includes("content:create")) throw new ForbiddenError("content:create required");
}
function canPublishPublic(req: Requester): boolean {
  if (req.kind === "user") return req.isAdmin || hasCapability(req, "content.publish_public");
  if (req.kind === "agent-delegated") return req.scopes.includes("content:publish_public"); // only if the human granted it
  return false;                                             // autonomous agents never hold it
}
```

### 26.4 The public-publish gate
Publishing to a public-facing destination/visibility requires `content:publish_public`, which **autonomous agents do not hold**. When an autonomous run requests it, `publishService` throws `ApprovalRequiredError`; the object enters a review queue (or notifies an approver via the publish event). This closes the failure mode of an unattended agent placing unreviewed content in front of families. Internal publishing stays fluid.

### 26.5 Ownership for autonomous content
Autonomous objects are owned by a designated **system user** (configurable) and stamped `created_by_actor='agent'`, `created_by_agent_id=<identity>`. They read violet on the rail; a human review before any public publish is the green step.

## 27. Audit and events

- **Audit:** every MCP/REST content mutation appends to `nexus_mcp_audit_logs` (already capturing MCP calls) with actor, tool, object id, and outcome — a complete external-creation/publish trail a district will want.
- **Events** (`lib/content/events.ts`): emit on an SNS topic / EventBridge bus.
  - `content.published` → re-index for retrieval; run connector pushes; notify a channel.
  - `content.version_created`, `content.unpublished`, `content.public_publish_requested` (drives the approval queue).
- Downstream automations subscribe to events instead of polling. The publish path emits exactly once per successful publish.

---

# Part VI — Cross-cutting

## 28. Security and compliance

### 28.1 Untrusted artifact execution (the highest-risk surface)
Artifact code (agent- or human-authored) is **untrusted** and executes only under containment:
- Rendered in a **cross-origin** sandboxed iframe (`sandbox="allow-scripts"`, **no** `allow-same-origin`), served from a dedicated origin (`ARTIFACT_SANDBOX_ORIGIN`) that shares no cookies/storage with the app.
- Strict CSP on the sandbox host: `default-src 'none'; script-src 'unsafe-inline' <allowlisted CDNs>; style-src 'unsafe-inline'; img-src https: data:; connect-src 'none'`. Widen `connect-src`/`script-src` only for explicitly permitted libraries.
- Code is delivered via `postMessage`, never by embedding app-origin data. The iframe cannot read app session, tokens, localStorage, or call first-party APIs.
- Public artifacts (`public_web`) are wrapped in the same sandbox on the public route.

### 28.2 Permission-aware retrieval
`retrievalService.search` applies `canView` per requester before returning any chunk (§16.2). A student-facing assistant is **structurally** unable to retrieve staff-only content. This is enforced server-side, never by UI filtering.

### 28.3 Reuse existing safety
Run agent content-generation through the existing **Bedrock Guardrails** and **PII tokenization** (`lib/safety`) exactly as nexus does, before persisting a version. Apply on `create_*` and `create_version` when the author is an agent.

### 28.4 Provenance and audit as governance
Two-grain provenance + `nexus_mcp_audit_logs` + the public-publish human gate give FERPA/COPPA/CIPA-relevant traceability: who authored content, who approved public exposure, and a queryable trail. Reader provenance footers make AI authorship visible to consumers.

### 28.5 Threat model (summary)

| Threat | Mitigation |
|---|---|
| Artifact JS exfiltrates session/data | Cross-origin sandbox, no same-origin, strict CSP, postMessage delivery |
| Agent over-shares (publishes too widely) | Visibility defaults from collection; autonomous agents lack `content:publish_public`; approval gate |
| Assistant leaks restricted content via RAG | Permission-aware retrieval (`canView` on every hit) |
| Privilege escalation by delegated agent | Inherits user permissions only; cannot exceed the human's grants |
| Prompt-injected instructions in source docs | Source content is data; tools require explicit caller scope; no auto-publish-from-content |
| Stale published content after edits | `published_version_id` tracked separately; re-publish is explicit; events re-index |
| PII in generated content | Guardrails + PII tokenization on agent write paths |

## 29. Errors, idempotency, rate limiting, observability

- **Error types** (`lib/content/errors.ts`): `ForbiddenError` (403), `NotFoundError` (404), `ValidationError` (400), `ApprovalRequiredError` (202 / structured), `ConflictError` (409, slug/version race). Server actions return the repo's `ActionState<T>`; REST/MCP map to status/structured errors.
- **Idempotency:** `publish` upserts on `(object_id, destination)`; `create` accepts an optional `Idempotency-Key` header (REST) to dedupe agent retries; version numbers are allocated under a transaction with the `uq_version_object_number` constraint guarding races.
- **Rate limiting:** reuse v1's existing limiter on `/v1/content`; MCP tool calls inherit MCP session limits. Indexing/publish events are processed async with retry + DLQ.
- **Observability:** wrap service methods in the existing OpenTelemetry instrumentation; emit spans for `content.create`, `content.publish`, `retrieval.search` with `objectId`, `kind`, actor, destination attributes. Reasoning/tool traces for agent runs already flow through the platform's tracing.

## 30. Configuration and infrastructure

### 30.1 Environment variables (additions)
```
ATRIUM_S3_BUCKET=                # reuse StorageStack bucket; "atrium/" prefix
ATRIUM_SANDBOX_ORIGIN=           # e.g. https://artifacts.<district-domain>  (separate origin!)
ATRIUM_PUBLIC_BASE_URL=          # base for public reader routes / CDN
ATRIUM_EVENTS_TOPIC_ARN=         # SNS topic (or EventBridge bus name)
ATRIUM_SYSTEM_USER_ID=           # owner for autonomous-agent content
ATRIUM_ALLOWED_ARTIFACT_CDNS=    # comma list for sandbox CSP (e.g. https://cdnjs.cloudflare.com)
PROOF_DOC_STORE_MODE=            # "postgres" (default) | "s3"
```

### 30.2 CDK additions (`infra/`)
- **S3:** an `atrium/` prefix on the existing content bucket; a separate public prefix/distribution (CloudFront) for `public_web`.
- **Sandbox origin:** a distinct subdomain/distribution serving the static artifact host page with the locked CSP (no app cookies in scope).
- **Events:** an SNS topic (`atrium-content-events`) or EventBridge bus; subscriptions for the retrieval indexer (Lambda or in-app worker) and notifiers; a DLQ.
- **IAM:** the app task role gets `s3:GetObject/PutObject` on the `atrium/*` prefix and `sns:Publish` on the topic. No new public bucket ACLs — serve public via CloudFront OAC.
- **OIDC client-credentials:** register clients for autonomous agent identities on the existing provider.

### 30.3 Dependencies to add
`@codemirror/{view,state,lang-html,lang-javascript}`, the Proof SDK packages (`doc-core`, `doc-editor`, `doc-server`, `agent-bridge`, and the custom store), `remark`/`rehype` stack (`remark-parse`, `remark-gfm`, `remark-directive`, `remark-rehype`, `rehype-sanitize`, `rehype-stringify`). No new AI framework; assistant-ui and AI SDK v6 already present.

## 31. Testing and acceptance

### 31.1 Test layers
- **Unit:** `canView` truth table (every level × grant kind × principal), slug uniqueness, version allocation, render sanitizer (asserts `<script>`/event handlers are stripped), scope checks.
- **Integration:** create→version→publish→read round trip per kind; permission-pushed `list` returns exactly the visible set; retrieval `search` excludes non-visible objects.
- **Security:** sandbox iframe cannot reach app origin (attempt cookie/localStorage/fetch from artifact code → blocked); autonomous identity cannot `publish_content(public_web)`; delegated agent cannot exceed user grants.
- **E2E:** the SOP→one-pager loop (below) and the scheduled-report loop.

### 31.2 Acceptance criteria (per phase, see §32)
| Phase | Done when |
|---|---|
| 0 Content API | create/get/list/version work via service + server action; bodies persist to S3; nothing UI-only |
| 1 Documents | Proof editor edits an agent-drafted doc; rail shows human/agent; publish renders an intranet reader page; **SOP→one-pager loop passes E2E** |
| 2 Artifacts | agent generates an artifact; preview renders sandboxed; code edit creates a human version; publish renders a reader page |
| 3 Permissions | `canView` enforced on read/list/render/publish; group grants by building/department/grade/role honored |
| 4 Nav/IA | published content appears in the collection tree; sidebar filtered by visibility; library view works |
| 5 Agent access | MCP tools + `/v1/content` create & publish; delegated and autonomous identities work; audit rows written; events emitted |
| 6 Retrieval | published content indexed; permission-aware `search` excludes restricted content for the wrong requester |
| 7 Connectors | `public_web` live; Schoology/Google publish behind the public gate |

### 31.3 The reference E2E (must pass early)
Upload Board Procedure 4040 (PDF) → agent distills to a one-page document → a human edits two lines (green appears on the rail) → publish to visibility `group` (building = High School) on `intranet` → confirm: (a) the reader page renders for a High School staff user, (b) it 403s for an out-of-building user, (c) a staff-scoped assistant retrieves it and a student-scoped assistant does not, (d) the provenance footer shows AI-drafted/human-reviewed.

---

# Part VII — Delivery

## 32. Build plan

Phases can overlap, but **prove the document loop end to end before breadth** (§31.3). Each phase lists its deliverables; acceptance is §31.2.

**Phase 0 — Content API + data model**
Schema + migrations (§7–§9), seed (§10), `lib/content/` service layer (`content-service`, `version-service`, `visibility-service` core, `s3-store`), server actions for create/get/list/version. Outcome: content can be created and versioned programmatically; nothing UI-only.

**Phase 1 — Document path (prove the loop)**
Proof integration + `AtriumProofStore` (§13.2), markdown→HTML render pipeline (§18.2), the side-panel `DocumentEditor`, internal reader route (§20), the intranet publish adapter (§15.2). Wire the existing document-processing pipeline as the SOP source. Ship the §31.3 E2E.

**Phase 2 — Artifact path**
`ArtifactCanvas` on assistant-ui, CodeMirror editor, the cross-origin sandbox + host page (§19.2, §28.1), per-version provenance, artifact reader rendering.

**Phase 3 — Permissions/visibility**
Full `canView` + permission-pushed `list` (§12), the visibility editor UI + `VisibilityChip`, group grants by role/building/department/grade/user, enforcement on every read/list/render/publish path.

**Phase 4 — Navigation & IA**
`navigation_items` extension wiring, collection tree + filtered sidebar, `ensureNavItem` on publish, the library view (§21).

**Phase 5 — Agent access**
MCP content tools (§24) + `/v1/content` (§23) + skill/scheduled-run wiring (§25); `agent_identities` + OIDC client-credentials; delegated + autonomous `Requester` construction; scopes + the public-publish gate (§26); audit + events (§27).

**Phase 6 — Retrieval**
Index-on-publish via the repository pipeline (§16.1), permission-aware `search` (§16.2), whole-object injection, assistant retrieval scoping (§16.4).

**Phase 7 — Publishing connectors**
`public_web` (CloudFront/S3 public route + sandbox), then `schoology` and `google` adapters over `connector-service` and existing OAuth connectors, all behind the public-publish gate.

**Phase 8 — OKF interoperability** *(post-spec addendum, §36)*
`okf` export adapter (§36.2) + OKF import service (§36.3) + MCP/REST parity (§36.4). Boundary serialization only — no change to the content model. Sequence **last**: depends on Phase 6 (`getContextDocument` whole-object bodies) and Phase 7 (publish-adapter breadth). Export enforces `canView` per object and routes public/anonymous bundles through the §26.4 gate.

## 33. Open decisions to confirm during build

1. **Proof `doc-store` interface** — confirm the exact `DocStore` contract against `proof-sdk`; decide whether `doc-server` runs in-process or as a sidecar, and whether the CRDT snapshot lives in a `proof_doc_state` table or S3 (`PROOF_DOC_STORE_MODE`). No Yjs/CRDT is in the tree today; Proof supplies its own.
2. **Snapshot cadence** — debounced idle interval + on publish (recommended); confirm thresholds.
3. **Code editor** — CodeMirror 6 (recommended) vs Monaco.
4. **Retrieval index** — reuse `knowledge_repositories`/`repository_item_chunks` with a system repository per collection (recommended) vs a dedicated content index; confirm how `repository_access` vs `content_visibility_grants` are reconciled (this spec filters by `canView` at query time regardless).
5. **Service identity mechanism** — OIDC client-credentials + `agent_identities` (recommended) vs Cognito app clients.
6. **Artifact JSX rendering** — whether to support `jsx` artifacts (needs an in-sandbox transform/runtime) in v1 or start HTML/JS-only and add JSX later. Recommended: HTML/JS first.
7. **Public hosting** — CloudFront + S3 static export vs an authenticated-but-anonymous Next public route for `public_web`.
8. **Naming** — §34.

## 34. Naming

`page` (tool-grid hub) and `agent-workspace` (credential consent) are taken in the codebase, so the product needs its own name. Working proposal: **Atrium** — the open, shared gathering space in a school building; reads as a place content gathers and is shared; no collision. Alternatives: *Commons*, *Press*, *Marquee*. Whatever the product name, keep the database/API identifiers (`content_objects`, `content_versions`, `content_collections`, `content_publications`, `content_visibility_grants`, `/v1/content`) — descriptive and stable. User-facing vocabulary: **docs** and **artifacts** (the two kinds), **collections** (sections).

## 35. Appendix

### 35.1 New file map
```
lib/db/schema/tables/
  content-objects.ts  content-versions.ts  content-collections.ts
  content-visibility-grants.ts  content-publications.ts
  agent-identities.ts  content-index-links.ts
lib/db/schema/enums.ts                      # + content_* enums; extend navigation_type
lib/content/
  content-service.ts  version-service.ts  visibility-service.ts
  publish-service.ts  retrieval-service.ts  events.ts  errors.ts  types.ts
  storage/        s3-store.ts  proof-store.ts
  render/         markdown-render.ts
  publish-adapters/  types.ts  intranet.ts  public-web.ts  schoology.ts  google.ts  okf.ts   # §36 export
  okf/            export.ts  import.ts  frontmatter.ts   # §36 OKF (de)serialization
actions/db/atrium/                           # server actions wrapping the services
  create-content.ts  snapshot-document.ts  create-version.ts  publish.ts  set-visibility.ts
app/api/v1/content/
  route.ts  [id]/route.ts  [id]/versions/route.ts
  [id]/visibility/route.ts  [id]/publish/route.ts  [id]/publish/[destination]/route.ts
app/api/content/[id]/agent-bridge/route.ts   # Proof agent-bridge proxy
lib/mcp/custom-tools/                         # register content tools here
app/(protected)/atrium/page.tsx              # library view
app/(protected)/c/[slug]/page.tsx            # internal reader
app/(public)/p/[slug]/page.tsx               # public reader
components/atrium/
  WorkspacePanel.tsx  PanelHeader.tsx  VisibilityChip.tsx  PublishButton.tsx
  DocumentEditor.tsx  ArtifactCanvas.tsx  ArtifactSandbox.tsx  CodeEditor.tsx
  ReaderShell.tsx  RenderedHtml.tsx  ProvenanceFooter.tsx  CollectionTree.tsx
styles/atrium-content.css                     # district render stylesheet
infra/                                        # S3 prefix, sandbox origin, SNS topic, IAM, OIDC clients
```

### 35.2 Enum reference
`content_kind`(document|artifact) · `content_status`(draft|published|archived) · `actor_kind`(human|agent) · `visibility_level`(private|group|internal|public) · `grant_kind`(role|building|department|grade|user) · `body_format`(markdown|html|jsx) · `publish_destination`(intranet|public_web|schoology|google|**okf** — §36) · `publication_status`(live|scheduled|unpublished|failed) · `agent_identity_kind`(service|skill) · `navigation_type` += content

### 35.3 Scope reference
`content:create` · `content:update` · `content:publish_internal` · `content:publish_public` (human-held; withheld from autonomous agents)

### 35.4 Glossary
- **Content object** — a document or artifact; the addressable unit.
- **Document** — markdown content edited in Proof, rendered rich via templates; per-character provenance.
- **Artifact** — interactive HTML/JS(/JSX) edited in the canvas, rendered in a sandbox; per-version provenance.
- **Collection** — an intranet section; also a default-visibility and retrieval scope.
- **Visibility** — who may consume (private/group/internal/public).
- **Destination** — where content is surfaced (intranet/public_web/schoology/google).
- **Delegated agent** — acts on behalf of a user, inheriting their permissions.
- **Autonomous agent** — a service/skill identity with its own role and scopes; cannot publish publicly.
- **Provenance** — recorded human/agent authorship; the green/violet rail (docs) or per-version author (artifacts).

---

## 36. OKF interoperability (Phase 8)

> **Post-spec addendum.** Added after §§0–35 were written; tracked as Epic #1059 Phase 8 (issue #1103). Depends on Phase 6 (§16.3 whole-object bodies) and Phase 7 (publish-adapter breadth); ships last.

[Open Knowledge Format (OKF)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) is a portable serialization for agent context: a directory of markdown files with YAML frontmatter, where each file is a *concept*, markdown links form the graph, and two reserved filenames carry structure — `index.md` (navigation) and `log.md` (change history). Its stance is **"format, not platform"** — no SDK, no runtime, no accounts — so any producer's knowledge is consumable by any agent without translation.

Atrium already **stores everything OKF serializes.** OKF is therefore a *boundary serialization* — a read/write shape at the edge, not a change to the `lib/content/` model (§4 remains the source of truth). This phase adds **export** (a collection → an OKF bundle) and **import** (an OKF bundle → content objects), nothing more.

### 36.1 Model mapping

A content object maps to one OKF concept file. The `type` frontmatter field is required by OKF; every other field is optional and emitted only when present. Fields verified against the schema (§7–§9):

| OKF frontmatter | Atrium source |
|---|---|
| `type` *(required)* | `content_objects.kind` (`document` \| `artifact`) |
| `title` | `content_objects.title` |
| `description` | `content_versions.summary` (head version) |
| `resource` | `content_publications.external_ref` (a prior publication URL, if the object is already published elsewhere) |
| `tags` | `content_objects.tags` (`text[]`) |
| `timestamp` | `content_objects.updated_at` |
| *body markdown* | head version body — documents via §16.3 `getContextDocument` (the `context.md` whole-object read); artifacts emit their code in a fenced block |

Structure maps to the filesystem:
- The `content_collections` subtree (self-referential tree, §8) → a directory tree.
- One `index.md` per collection — an OKF navigation file linking its child concepts (mirrors the intranet collection view, §21).
- `content_versions` history for an object → its `log.md` (version number, author actor, summary, timestamp) — the immutable version list is already the change log.

Round-trip preserves object **metadata + body**, not editor-internal state: OKF's flat concept model cannot carry per-character document provenance or live artifact sandbox state. That loss is expected and documented, not a defect.

### 36.2 Export — an `okf` publish destination

Export is modeled as a new `publish_destination = 'okf'` adapter (`lib/content/publish-adapters/okf.ts`) implementing the §15.1 `PublishAdapter` interface (`destination` + `publish()` + `unpublish()`), so it inherits the §15.3 publish-service pipeline, the `content_publications` row, and — critically — the §26.4 public-publish gate. The adapter's `publish()` serializes the collection subtree (via `lib/content/okf/export.ts` + `frontmatter.ts`) to a bundle and returns its location as `external_ref` (an S3 key / URL, §36.5).

**Permission boundary (the one security-critical surface).** A bundle is portable files that escape `canView` the moment they are written. Therefore export MUST:
1. Filter **every** object in the subtree through `visibilityService.canView(req, obj)` (§12) — the same predicate that gates reads. An object the requester cannot view is omitted from the bundle entirely; a bundle requested by a student identity contains no staff-only concepts.
2. Route any bundle whose scope is `public`/anonymous through the §26.4 gate: only a caller holding `content:publish_public` (human or delegated) may produce a public bundle; autonomous agents are structurally blocked and receive `approval_required`.

Export writes a `content_audit_logs` row (§27) recording requester, collection, object count, and visibility tier.

### 36.3 Import — a content service, not a destination

Import (`lib/content/okf/import.ts`) parses a bundle (frontmatter + body + the `index.md` tree + `log.md`) and creates/updates content through `contentService`/`versionService`/`collectionService` — the same API every other surface uses (§22). It reconstructs the collection tree from the directory layout and `index.md`, then writes each concept as a content object + head version. Imported content is **agent-authored**: versions carry `actor_kind = agent` provenance (§11), never fabricated human authorship. Import writes a `content_audit_logs` row per run.

Import is *not* a `publish_destination` — it is inbound, so it has no adapter; it is a plain service invoked by the MCP tool / REST endpoint.

### 36.4 Surfaces (MCP + REST parity)

Per §22 (parity), both directions are exposed at both surfaces, gated by content scopes (§26.2):
- **MCP** (§24): `export_okf` (collection → bundle) and `import_okf` (bundle → collection).
- **REST v1** (§23): `POST /v1/content/export/okf` and `POST /v1/content/import/okf`; update `docs/API/v1/openapi.yaml` + `context-graph.md`.

Export requires a read scope + (for public bundles) `content:publish_public`; import requires `content:create`.

### 36.5 Enum, migration, transport

- Add `okf` to `publish_destination` (`lib/db/schema/enums.ts`) via a `010+` migration: `ALTER TYPE publish_destination ADD VALUE 'okf'`. The enum is master-owned (created in a `085+` Atrium migration, not an immutable 001–005 type owned by `postgres`), so `ADD VALUE` succeeds under the migration role.
- **Bundle transport (open decision, §33):** a bundle is a directory of files. Persist/return it as (a) a `.zip`/tar at an S3 key with a presigned URL in `external_ref` *(recommended)*, or (b) an unpacked S3 prefix. Confirm during build; the model layer is transport-agnostic.

### 36.6 Acceptance (Phase 8)

- [ ] `export_okf` produces a v0.1-valid bundle: one `.md`/object with `type` frontmatter, collection tree → directories, an `index.md` per collection, version history → `log.md`; frontmatter maps per §36.1.
- [ ] Export enforces `canView`: a student-identity bundle excludes staff-only objects (integration test).
- [ ] Public/anonymous export is blocked without `content:publish_public` (autonomous agent → `approval_required`).
- [ ] Round-trip: export → `import_okf` into a fresh collection → object metadata + body preserved; imported objects carry `actor_kind = agent` provenance.
- [ ] MCP + REST parity for export **and** import; a `content_audit_logs` row per run.
- [ ] `bun run lint` + `bun run typecheck` pass.

### 36.7 Non-goals (Phase 8)

- Rewriting the content model to be OKF-native — OKF stays a boundary serialization.
- Auto-generating bundles from non-Atrium sources (the BigQuery enrichment-agent equivalent).
- Resolving OKF `resource` links to live external systems.
- OKF over the Schoology/Google destinations — this is a standalone bundle format, not a connector target.

---

*End of spec. Implementation details (exact imports, migration ordering, component breakdowns) are for Claude Code to finalize against the live `psd401/aistudio` codebase, following the conventions and file map above. Prove the §31.3 document loop before expanding scope.*
