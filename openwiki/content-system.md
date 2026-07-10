# Content System (Atrium)

Atrium is an agent-native content workspace where agents and people co-create documents and interactive artifacts, version them with visible authorship, and publish them at controlled access levels.

## Core Concepts

### Content Types

- **Documents**: Rich text documents edited with Proof editor (Yjs-based collaborative editing)
- **Artifacts**: Interactive code snippets, visualizations, and embeddable content

### Core Principle

> The content API is the source of truth for how content is created, versioned, and published. Every surface is a client of it — the in-app editors, external agents over MCP, scripts over REST, and scheduled skill runs. There is no UI-only creation path.

## Content Object Model

### Database Schema

```typescript
// content_objects table
{
  id: string;           // UUID
  kind: 'document' | 'artifact';
  slug: string;         // URL-friendly identifier (unique)
  title: string;
  ownerId: string;      // Creator user ID
  visibility: 'private' | 'group' | 'internal' | 'public';
 status: 'draft' | 'published' | 'archived';
  currentVersionId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Versioning System

- **Immutable Versions**: Each edit creates a new `content_versions` entry
- **Sequential Version Numbers**: 1, 2, 3... per object
- **Two-Grain Provenance**: Each version tracks `human` or `agent` actor
- **S3 Snapshots**: Document markdown/HTML stored in S3 for durability

### Versioning Flow

1. Transaction allocates next version number
2. DB insert with unique constraint guard
3. Post-commit S3 writes (prevents orphaned blobs on rollback)
4. Documents: Proof doc-store + markdown/HTML snapshots to S3
5. Artifacts: Inline storage (<4KB) or S3 (>4KB)

**Sources**: 
- `/lib/db/schema/tables/content-objects.ts`
- `/lib/db/schema/tables/content-versions.ts`
- `/lib/content/version-service.ts`

## Content Services

### Content Service (Single Write Path)

```typescript
// lib/content/content-service.ts
class ContentService {
  create(requester, input): Promise<ContentObject>
  update(requester, objectId, updates): Promise<ContentObject>
  get(requester, objectId): Promise<ContentObject>
  list(requester, filters): Promise<ContentObject[]>
}
```

All content operations flow through this service — UI, REST API, MCP, and scheduled runs.

### Requester Types

```typescript
type Requester = 
  | { type: 'user'; userId: string; role: string }
  | { type: 'agent-delegated'; agentId: string; delegatedFor: string }
  | { type: 'agent-autonomous'; agentId: string };
```

**Source**: `/lib/content/types.ts`

### Visibility Service

Permission-pushed filtering at the SQL level:

```typescript
// lib/content/visibility-service.ts
```

Visibility levels: `private` → `group` → `internal` → `public`

Grant types: role, building, department, grade, user

## Publishing Pipeline

### Publish Destinations

```typescript
PUBLISH_DESTINATIONS = ["intranet", "public_web", "schoology", "google", "okf"]
PUBLIC_DESTINATIONS = ["public_web", "schoology", "google"] // Require approval gate
```

### Publish Flow

1. Load object's owner/visibility/current version/slug
2. `canView` gate (404 on not found, never 403 to avoid leaking existence)
3. `assertCanEdit` permission check
4. Public destination gate (requires `content:publish_public` scope)
5. Transaction: Apply visibility grants → mark `published` → upsert publication row
6. Post-commit: Call destination adapter for external side effects

**Source**: `/lib/content/publish-service.ts`

### Publish Adapters

```typescript
// lib/content/publish-adapters/
```

| Adapter | Purpose |
|---------|---------|
| `intranet` | Reader-backed, no external side effects |
| `public_web` | Public reader route |
| `schoology` | Connector stub (not yet implemented) |
| `google` | Connector stub (not yet implemented) |
| `okf` | OKF bundle export |

### Approval Gate

Public destinations require:
- Explicit approval request OR
- `content:publish_public` scope

Autonomous agents always routed through approval. Version pinning ensures approval replay publishes reviewed version.

**Source**: `/lib/content/publish-adapters/types.ts`

## Retrieval System

### System Repository

"Atrium Content Index" - system-owned knowledge repository:
- Content objects mirrored as `repository_items`
- Permission-aware: `canView()` check per hit
- Indexed on publish, refreshed on version updates

### Permission-Aware Search

```typescript
// lib/content/retrieval-service.ts
```

- Vector search via pgvector
- Permission-pushed SQL filtering
- Results filtered by user's visibility grants

**Source**: `/lib/content/retrieval-service.ts`

## Knowledge Repositories

### Three-Tier Structure

```
knowledge_repositories (owner, visibility, metadata)
  └── repository_items (name, content, metadata)
      └── repository_item_chunks (content, embedding vector, metadata)
```

### Access Control

- **Owner-based**: `owner_id` matches user
- **Role-based**: `repository_access` table joins roles
- **User-based**: Explicit user grants
- **Public**: `is_public = true`
- **System-managed**: Flag prevents direct access to Atrium index

### Vector Search

- pgvector extension for cosine similarity
- Hybrid search: Vector (80% weight) + keyword (20%)
- Default threshold: 0.7 similarity

**Source**: `/lib/repositories/search-service.ts`

### Assistant Architect Integration

```typescript
// lib/assistant-architect/knowledge-retrieval.ts
```

- Repository access verification
- Permission-scoped retrieval
- Token counting with `js-tiktoken`
- Max chunks/tokens limiting (default: 10 chunks, 4000 tokens)

## Document Processing

### Supported Formats

- PDF: `pdf-parse` library
- DOCX: `mammoth` library
- TXT: Direct UTF-8 decode

### Processing Pipeline

1. Upload to S3
2. Lambda triggers text extraction
3. Amazon Textract for OCR (PDFs)
4. Chunking: Paragraph → sentence → word splitting
5. Embedding generation
6. Storage in `repository_item_chunks`

**Source**: `/lib/document-processing.ts`

## REST API v1

### Content Endpoints

```
POST   /api/v1/content              # Create content
GET    /api/v1/content/:id          # Get content
PATCH  /api/v1/content/:id          # Update content
POST   /api/v1/content/:id/publish  # Publish content
GET    /api/v1/content/:id/versions # List versions
```

**Source**: `/docs/API/v1/context-graph.md`

### MCP Tools

```typescript
// lib/mcp/content-tools.ts
const CONTENT_TOOLS = [
  'create_document',
  'create_artifact',
  'get_content',
  'list_content',
  'publish_content',
  'unpublish_content',
  // ...more
];
```

## Events & Audit

### Content Events

- `content.created` → New object
- `content.updated` → Version created
- `content.published` → Publication event
- `content.archived` → Archived

### Audit Trail

`content_audit_logs` table records all operations with:
- Actor (user/agent)
- Operation type
- Timestamp
- Previous/new values

**Source**: `/lib/content/audit.ts`

## Source References

| Component | Primary Files |
|-----------|---------------|
| Content Service | `/lib/content/content-service.ts` |
| Version Service | `/lib/content/version-service.ts` |
| Visibility Service | `/lib/content/visibility-service.ts` |
| Publish Service | `/lib/content/publish-service.ts` |
| Retrieval Service | `/lib/content/retrieval-service.ts` |
| MCP Content Tools | `/lib/mcp/content-tools.ts` |
| Database Schema | `/lib/db/schema/tables/content-*.ts` |
| Design Spec | `/docs/features/atrium-design-spec.md` |
