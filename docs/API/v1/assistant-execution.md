# Assistant Execution API

Part of Issue #685 - Assistant Execution API (Phase 2)

## Overview

Execute AI Studio assistants (built with Assistant Architect) via REST API. External agents, Claude Code scripts, and automation tools can list, execute, and have multi-turn conversations with assistants.

## Authentication

All endpoints require authentication via:
- **API Key**: `Authorization: Bearer sk-...` (recommended for automation)
- **Session**: Browser session cookie (for logged-in users)

## Required Scopes

| Scope | Description |
|-------|-------------|
| `assistants:list` | List and view assistant details |
| `assistants:execute` | Execute any assistant |
| `assistant:{id}:execute` | Execute a specific assistant only |
| `assistants:*` | All assistant operations |

## Endpoints

### List Assistants

```
GET /api/v1/assistants
```

**Scope**: `assistants:list`

**Query Parameters**:
- `status` — Filter by status (draft, pending_approval, approved, rejected, disabled)
- `search` — Search by name or description (max 100 chars)
- `limit` — Results per page (1-100, default 50)
- `cursor` — Pagination cursor from previous response

**Response**:
```json
{
  "data": [
    {
      "id": 42,
      "name": "Email Summarizer",
      "description": "Summarizes email threads",
      "status": "approved",
      "inputFieldCount": 2,
      "promptCount": 3,
      "createdAt": "2025-01-15T10:00:00Z",
      "updatedAt": "2025-01-15T10:00:00Z"
    }
  ],
  "meta": {
    "requestId": "req-abc123",
    "limit": 50,
    "nextCursor": "42"
  }
}
```

### Get Assistant Details

```
GET /api/v1/assistants/:id
```

**Scope**: `assistants:list`

**Response**:
```json
{
  "data": {
    "id": 42,
    "name": "Email Summarizer",
    "description": "Summarizes email threads",
    "status": "approved",
    "timeoutSeconds": 120,
    "inputFields": [
      {
        "id": 1,
        "name": "email_content",
        "label": "Email Content",
        "fieldType": "long_text",
        "position": 0,
        "options": null
      }
    ],
    "promptCount": 3,
    "createdAt": "2025-01-15T10:00:00Z",
    "updatedAt": "2025-01-15T10:00:00Z"
  },
  "meta": { "requestId": "req-abc123" }
}
```

### Execute Assistant (SSE Streaming)

```
POST /api/v1/assistants/:id/execute
Accept: text/event-stream
```

**Scope**: `assistants:execute` or `assistant:{id}:execute`

**Request Body**:
```json
{
  "inputs": {
    "email_content": "Hi team, regarding the Q4 budget...",
    "style": "bullet_points"
  }
}
```

**Response**: Server-Sent Events stream (AI SDK format)

**Response Headers**:
- `X-Execution-Id` — Execution record ID
- `X-Assistant-Id` — Assistant ID
- `X-Request-Id` — Request correlation ID

### Execute Assistant (Async/Polling)

```
POST /api/v1/assistants/:id/execute
Accept: application/json
```

**Response** (202 Accepted):
```json
{
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "pollUrl": "/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000"
  },
  "meta": { "requestId": "req-abc123" }
}
```

### Poll Job Status

```
GET /api/v1/jobs/:jobId
```

**Response**:
```json
{
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "createdAt": "2025-01-15T10:00:00Z",
    "completedAt": "2025-01-15T10:00:05Z",
    "partialContent": "",
    "responseData": {
      "text": "Here is the summary:\n- Budget approved\n- Timeline Q1 2025",
      "usage": {
        "promptTokens": 150,
        "completionTokens": 45,
        "totalTokens": 195
      },
      "finishReason": "stop"
    },
    "pollingInterval": 1000,
    "shouldContinuePolling": false
  },
  "meta": { "requestId": "req-abc123" }
}
```

### Cancel Job

```
DELETE /api/v1/jobs/:jobId
```

**Response**:
```json
{
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "cancelled",
    "message": "Job cancelled successfully"
  },
  "meta": { "requestId": "req-abc123" }
}
```

### Start Conversation

```
POST /api/v1/assistants/:id/conversations
```

**Scope**: `assistants:execute` or `assistant:{id}:execute`

**Request Body**:
```json
{
  "inputs": {
    "topic": "Quarterly review preparation"
  },
  "title": "Q4 Review Planning"
}
```

**Response**: SSE stream with `X-Conversation-Id` header

### Send Follow-up Message

```
POST /api/v1/assistants/:id/conversations/:cid/messages
```

**Request Body**:
```json
{
  "message": "Can you also include the budget numbers?"
}
```

**Response**: SSE stream

### Get Conversation History

```
GET /api/v1/assistants/:id/conversations/:cid
```

**Scope**: `assistants:list`

**Query Parameters**:
- `limit` — Messages per page (1-100, default 50)
- `offset` — Skip messages (default 0)

**Response**:
```json
{
  "data": {
    "conversation": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Q4 Review Planning",
      "provider": "assistant-architect",
      "messageCount": 4,
      "createdAt": "2025-01-15T10:00:00Z",
      "updatedAt": "2025-01-15T10:05:00Z"
    },
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "content": "topic: Quarterly review preparation",
        "createdAt": "2025-01-15T10:00:00Z"
      },
      {
        "id": "msg-2",
        "role": "assistant",
        "content": "I'll help you prepare for the quarterly review...",
        "createdAt": "2025-01-15T10:00:05Z"
      }
    ]
  },
  "meta": {
    "requestId": "req-abc123",
    "limit": 50,
    "offset": 0
  }
}
```

## Error Responses

All errors follow this format:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [...]
  },
  "requestId": "req-abc123"
}
```

| Status | Code | Description |
|--------|------|-------------|
| 400 | VALIDATION_ERROR | Invalid request parameters |
| 400 | CONTENT_BLOCKED | Content safety guardrails triggered |
| 401 | UNAUTHORIZED | Authentication required |
| 403 | INSUFFICIENT_SCOPE | Missing required scope |
| 404 | NOT_FOUND | Resource not found or access denied |
| 409 | CONFLICT | Job cannot be cancelled |
| 429 | RATE_LIMITED | Rate limit exceeded |
| 500 | INTERNAL_ERROR | Server error |

## Access Control

Assistants are accessible if any of these conditions is met:
1. **Owner** — User created the assistant (any status)
2. **Admin** — User has administrator role (any assistant)
3. **Approved** — Assistant has "approved" status (any authenticated user)

For security, 404 is returned instead of 403 when an assistant exists but the user lacks access.
