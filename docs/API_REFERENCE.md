# API Reference

Complete API documentation for AI Studio endpoints and server actions.

## Table of Contents

- [Authentication](#authentication)
- [REST API Endpoints](#rest-api-endpoints)
- [Server Actions](#server-actions)
- [Request/Response Patterns](#requestresponse-patterns)
- [Error Handling](#error-handling)

## Authentication

All protected endpoints require JWT authentication via NextAuth v5 session cookies.

### Session Management

```typescript
// Get current session (server-side)
import { getServerSession } from '@/lib/auth/server-session';

const session = await getServerSession();
if (!session) {
  return new Response('Unauthorized', { status: 401 });
}
```

### Tool Access Control

```typescript
import { hasToolAccess } from '@/utils/roles';

// Check if user has permission for specific tool
const hasAccess = await hasToolAccess('assistant-architect');
if (!hasAccess) {
  return new Response('Forbidden', { status: 403 });
}
```

## REST API Endpoints

### Nexus Chat

#### POST /api/nexus/chat
**Stream a chat conversation with SSE**

**Request:**
```typescript
{
  messages: UIMessage[],
  modelId: string,
  provider: string,
  conversationId?: string,
  systemPrompt?: string,
  temperature?: number,
  maxTokens?: number
}
```

**Response:** Server-Sent Events stream
```
data: {"type":"text-delta","content":"Hello"}
data: {"type":"text-delta","content":" world"}
data: {"type":"finish","usage":{"tokens":50}}
```

**Example:**
```typescript
const response = await fetch('/api/nexus/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Hello!' }],
    modelId: 'gpt-5-turbo',
    provider: 'openai'
  })
});

const reader = response.body.getReader();
// Process SSE stream...
```

#### GET /api/nexus/conversations
**List user's conversations**

**Query Parameters:**
- `limit` (number, default: 50)
- `offset` (number, default: 0)
- `folderId` (uuid, optional)

**Response:**
```typescript
{
  conversations: Array<{
    id: string,
    title: string,
    messageCount: number,
    lastMessageAt: string,
    provider: string,
    modelUsed: string
  }>,
  total: number
}
```

#### GET /api/nexus/conversations/[id]/messages
**Get messages for a conversation**

**Response:**
```typescript
{
  messages: Array<{
    id: string,
    role: 'user' | 'assistant',
    content: string,
    createdAt: string,
    tokenUsage?: TokenUsage
  }>
}
```

### Assistant Architect

#### POST /api/assistant-architect/execute
**Execute a multi-prompt chain with streaming**

**Request:**
```typescript
{
  toolId: number,
  inputs: Record<string, unknown>,
  conversationId?: string
}
```

**Response:** SSE stream
```
data: {"type":"execution_started","executionId":123,"totalPrompts":3}
data: {"type":"prompt_started","promptId":1,"position":1,"name":"Analyze Data"}
data: {"type":"prompt_chunk","promptId":1,"content":"The data shows..."}
data: {"type":"prompt_complete","promptId":1,"output":"...","metadata":{}}
data: {"type":"execution_complete","results":[...]}
```

**Validation:**
- `MAX_INPUT_SIZE_BYTES`: 100KB
- `MAX_INPUT_FIELDS`: 50
- `MAX_DURATION`: 15 minutes

#### GET /api/assistant-architects
**List available assistant architects**

**Response:**
```typescript
{
  tools: Array<{
    id: number,
    name: string,
    description: string,
    status: 'draft' | 'published' | 'archived',
    promptCount: number
  }>
}
```

### Model Compare

#### POST /api/compare
**Compare responses from multiple models**

**Request:**
```typescript
{
  prompt: string,
  model1Id: string,
  model2Id: string,
  systemPrompt?: string
}
```

**Response:**
```typescript
{
  comparisonId: number,
  model1: {
    response: string,
    tokens: number,
    duration: number,
    cost: number
  },
  model2: {
    response: string,
    tokens: number,
    duration: number,
    cost: number
  }
}
```

### Documents & Knowledge

#### POST /api/documents/presigned-url
**Get presigned S3 URL for document upload**

**Request:**
```typescript
{
  fileName: string,
  fileType: string,
  fileSize: number,
  repositoryId: number
}
```

**Response:**
```typescript
{
  presignedUrl: string,
  fileKey: string,
  fields: Record<string, string>
}
```

#### POST /api/documents/confirm-upload
**Confirm document upload and trigger processing**

**Request:**
```typescript
{
  fileKey: string,
  fileName: string,
  fileType: string,
  repositoryId: number
}
```

**Response:**
```typescript
{
  itemId: number,
  status: 'pending'
}
```

### Admin Endpoints

#### GET /api/admin/users
**List all users (admin only)**

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 50)
- `search` (string, optional)

**Response:**
```typescript
{
  users: Array<{
    id: number,
    email: string,
    firstName: string,
    lastName: string,
    roles: Role[],
    createdAt: string,
    lastSignInAt: string
  }>,
  total: number,
  page: number,
  totalPages: number
}
```

#### POST /api/admin/users/[userId]/roles
**Assign role to user**

**Request:**
```typescript
{
  roleId: number
}
```

#### GET /api/admin/models
**List AI models (admin only)**

**Response:**
```typescript
{
  models: Array<{
    id: number,
    name: string,
    provider: string,
    modelId: string,
    capabilities: string[],
    inputCost: number,
    outputCost: number
  }>
}
```

## Server Actions

Server actions return `ActionState<T>` type:

```typescript
type ActionState<T> = {
  isSuccess: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code?: string;
    level?: ErrorLevel;
  };
};
```

### Nexus Chat Actions

**File:** `/actions/nexus/nexus-actions.ts`

#### createConversationAction
```typescript
async function createConversationAction(params: {
  title?: string;
  provider: string;
  modelId: string;
  folderId?: string;
}): Promise<ActionState<{ conversationId: string }>>
```

#### deleteConversationAction
```typescript
async function deleteConversationAction(
  conversationId: string
): Promise<ActionState<void>>
```

#### updateConversationTitleAction
```typescript
async function updateConversationTitleAction(
  conversationId: string,
  title: string
): Promise<ActionState<void>>
```

### Assistant Architect Actions

**File:** `/actions/db/assistant-architect-actions.ts`

#### getAssistantArchitectByIdAction
```typescript
async function getAssistantArchitectByIdAction(
  id: string
): Promise<ActionState<AssistantArchitectWithRelations>>
```

#### createAssistantArchitectAction
```typescript
async function createAssistantArchitectAction(params: {
  name: string;
  description: string;
  prompts: ChainPromptInput[];
  inputFields: ToolInputFieldInput[];
}): Promise<ActionState<{ id: number }>>
```

#### updateAssistantArchitectAction
```typescript
async function updateAssistantArchitectAction(
  id: number,
  updates: Partial<AssistantArchitect>
): Promise<ActionState<void>>
```

### Document Actions

**File:** `/actions/repositories/document-actions.ts`

#### uploadDocumentAction
```typescript
async function uploadDocumentAction(params: {
  fileName: string;
  fileType: string;
  fileSize: number;
  repositoryId: number;
}): Promise<ActionState<{ presignedUrl: string; fileKey: string }>>
```

#### searchDocumentsAction
```typescript
async function searchDocumentsAction(params: {
  query: string;
  repositoryIds: number[];
  limit?: number;
}): Promise<ActionState<{ results: DocumentChunk[] }>>
```

## Request/Response Patterns

### Standard Request Format

```typescript
// Request with authentication
const response = await fetch('/api/endpoint', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  credentials: 'include',  // Include session cookie
  body: JSON.stringify(requestData)
});
```

### Error Handling Pattern

```typescript
// API routes return standard error format
if (!response.ok) {
  const error = await response.json();
  // error = { error: string, message: string, requestId?: string }
  throw new Error(error.message);
}
```

### Server Action Usage

```typescript
import { createConversationAction } from '@/actions/nexus/nexus-actions';

const result = await createConversationAction({
  title: 'New Chat',
  provider: 'openai',
  modelId: 'gpt-5-turbo'
});

if (result.isSuccess) {
  console.log('Created:', result.data.conversationId);
} else {
  console.error('Error:', result.error?.message);
}
```

## Error Handling

### Error Factories

```typescript
import { ErrorFactories } from '@/lib/error-utils';

// Authentication errors
throw ErrorFactories.authNoSession();
throw ErrorFactories.authInsufficientPermissions();

// Validation errors
throw ErrorFactories.validationFailed([
  { field: 'email', message: 'Invalid email format' }
]);

// Not found errors
throw ErrorFactories.notFound('User');

// Database errors
throw ErrorFactories.databaseError(originalError);
```

### Standard Error Response

```typescript
{
  error: string,           // Error type (e.g., "ValidationError")
  message: string,         // Human-readable message
  details?: unknown,       // Additional error details
  requestId?: string,      // Request ID for debugging
  code?: string           // Error code for programmatic handling
}
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request (validation failed)
- `401` - Unauthorized (no session)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `429` - Too Many Requests (rate limited)
- `500` - Internal Server Error
- `503` - Service Unavailable (provider timeout)

## Rate Limiting

```typescript
// Per-user limits (future enhancement)
const limits = {
  nexusChat: {
    requestsPerMinute: 100,
    tokensPerHour: 100000,
    concurrentStreams: 3
  },
  modelCompare: {
    comparisonsPerMinute: 20,
    concurrentExecutions: 2
  },
  assistantArchitect: {
    executionsPerMinute: 10,
    promptsPerHour: 50,
    concurrentExecutions: 1
  },
  documentProcessing: {
    uploadsPerMinute: 10,
    maxFileSize: 10485760,  // 10 MB
    textractPagesPerDay: 100
  }
};
```

## Webhooks & Events

### SSE Event Types

```typescript
// Streaming events
type SSEEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'tool-call'; toolName: string; args: unknown }
  | { type: 'reasoning-delta'; content: string }
  | { type: 'finish'; usage: TokenUsage }
  | { type: 'error'; error: string };

// Assistant Architect events
type ExecutionEvent =
  | { type: 'execution_started'; executionId: number; totalPrompts: number }
  | { type: 'prompt_started'; promptId: number; position: number; name: string }
  | { type: 'prompt_chunk'; promptId: number; content: string }
  | { type: 'prompt_complete'; promptId: number; output: string; metadata: PromptMetadata }
  | { type: 'execution_complete'; results: PromptResult[] };
```

---

**Last Updated**: November 2025
**API Version**: Next.js 15 App Router
**Authentication**: NextAuth v5 JWT sessions
**Total Endpoints**: 70+ REST routes + 10 server action files
**Documentation Status**: Active endpoints only (deprecated endpoints removed)
