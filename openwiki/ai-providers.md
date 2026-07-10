# AI Providers & Streaming

AI Studio integrates multiple LLM providers through a unified factory pattern with streaming support via Server-Sent Events (SSE). The platform supports OpenAI, Amazon Bedrock (Claude/Llama), Google Gemini, and Azure OpenAI.

## Provider Architecture

### Central Factory Pattern

Single entry point for all providers via `createProviderModel()`:

```typescript
// lib/ai/provider-factory.ts
createProviderModel(provider: string, modelId: string): Promise<LanguageModel>
```

- Switch-based routing with normalized lowercase provider names
- API keys fetched via Settings for secure credential access
- Consistent interface regardless of underlying provider

### Supported Providers

| Provider | Identifier | Models |
|----------|------------|--------|
| OpenAI | `openai` | GPT-5, GPT-4o, o3, o4 |
| Amazon Bedrock | `amazon-bedrock` | Claude, Llama |
| Google | `google` | Gemini Pro, Gemini Flash |
| Azure | `azure` | Azure OpenAI deployments |

**Source**: `/lib/streaming/provider-adapters/index.ts`

### Provider Adapter Interface

```typescript
interface ProviderAdapter {
  getCapabilities(modelId: string): ProviderCapabilities;
  createModel(modelId: string, options?: ProviderOptions): Promise<LanguageModel>;
  createTools(toolNames: string[]): Promise<Record<string, CoreTool>>;
  getProviderOptions(modelId: string, options?: ProviderOptions): Record<string, any>;
}
```

Each provider implements this interface with provider-specific handling.

## Streaming Architecture

### Unified Streaming Service

Central orchestrator for all AI streaming:

```typescript
// lib/streaming/unified-streaming-service.ts
unifiedStreamingService.stream(request: StreamRequest): Promise<Response>
```

Key features:
- PII tokenization/detokenization inline during streaming
- Circuit breaker pattern for reliability
- Cost caps for agentic loops (`costCapCents`)
- Multi-step tool use (`maxSteps`)

### Stream Request Interface

```typescript
interface StreamRequest {
  messages: UIMessage[];
  modelId: string;
  provider: string;
  tools?: ToolSet;
  enabledTools?: string[];
  enabledConnectors?: string[];  // MCP connector IDs
  maxSteps?: number;             // Multi-step tool use
  costCapCents?: number | null;  // Cost control
  contentSafety?: { ... };       // K-12 content filtering
}
```

### SSE Event Types

Strongly-typed SSE events for consistent client handling:

```typescript
// lib/streaming/sse-event-types.ts
type SSEEventType =
  | 'text-start' | 'text-delta' | 'text-end'
  | 'reasoning-start' | 'reasoning-delta' | 'reasoning-end'
  | 'tool-call' | 'tool-call-delta' | 'tool-input-start'
  | 'error' | 'done';
```

**Key Field**: Use `delta` (NOT `textDelta`) for text deltas.

### Circuit Breaker Pattern

Prevents cascading failures when providers are unhealthy:

```typescript
// lib/streaming/circuit-breaker.ts
```

States: CLOSED → OPEN → HALF_OPEN → CLOSED

## Tool Integration

### Provider-Native Tools

```typescript
// lib/tools/provider-native-tools.ts
createProviderNativeTools(provider, modelId, enabledTools)
```

**Universal Tools** (always available):
- `show_chart` - Chart rendering

**Provider-Specific Tools**:
- OpenAI: `web_search_preview`, `code_interpreter`
- Models vary in tool support (GPT-5 has most)

### OpenAI Tools

- Uses OpenAI Responses API for all models
- Supports reasoning effort, background mode
- Merges universal tools with provider-native tools

**Source**: `/lib/streaming/provider-adapters/openai-adapter.ts`

## Model Context Protocol (MCP)

MCP enables external tool servers to connect to AI Studio chat.

### MCP Connector Service

```typescript
// lib/mcp/connector-service.ts
createMCPClient(connectorId: string): Promise<MCPClient>
```

- Uses `@ai-sdk/mcp` for external tool servers
- OAuth token management with encryption
- Per-user connection status and token refresh

### MCP Content Tools

Tools for Atrium content operations exposed via MCP:

```typescript
// lib/mcp/content-tools.ts
const CONTENT_TOOL_SCOPE_MAP = {
  create_document: "content:create",
  create_artifact: "content:create",
  get_content: "content:read",
  publish_content: "content:publish_internal",
  // ...more tools
};
```

### Workspace Chat Tools

Server-side tools for editing workspace documents in Nexus chat:

```typescript
// lib/nexus/workspace-chat-tools.ts
buildReadTool(workspaceId)      // Read current content
buildDocumentEditTool(workspaceId) // Live Yjs doc editing
```

Security: Tools built from resolved `workspaceId`, never client input.

## Nexus Chat Architecture

### Tech Stack

- @assistant-ui/react v0.11.37+ (UI framework)
- @assistant-ui/react-ai-sdk (AI SDK integration)
- AI SDK v6 (Vercel's streaming SDK)
- Next.js 16 with React 19

### Component Hierarchy

```
NexusPage → NexusPageContent → NexusShell → ConversationInitializer 
  → ConversationRuntimeProvider → Thread
```

### Conversation ID Pattern

Three-state pattern to prevent race conditions:

1. `conversationId` (React state) - URL/UI updates
2. `stableConversationId` (immutable) - Prevents remount
3. `conversationIdRef` (ref) - Callback access without dependency issues

**Source**: `/docs/features/nexus-conversation-architecture.md`

### History Adapter

Converts DB messages to assistant-ui's `ThreadMessage` format:

```typescript
// lib/nexus/history-adapter.ts
```

- Handles tool-call parts with proper `state` field
- Uses tool-call format for AI SDK v6 compatibility

### Polling Adapter

For long-running operations (Assistant Architect, etc.):

```typescript
// lib/nexus/nexus-polling-adapter.ts
```

Job status flow: pending → processing → streaming → completed

## Dual-Stream Model Compare

```typescript
// lib/compare/dual-stream-merger.ts
mergeStreamsWithIdentifiers(stream1, stream2)
```

- Runs two models in parallel using `Promise.allSettled`
- One failure doesn't block the other
- Emits `DualStreamEvent` with `modelId: 'model1' | 'model2'` discriminator

## Source References

| Feature | Primary Files |
|---------|---------------|
| Provider Factory | `/lib/ai/provider-factory.ts` |
| Provider Adapters | `/lib/streaming/provider-adapters/*.ts` |
| Unified Streaming | `/lib/streaming/unified-streaming-service.ts` |
| SSE Types | `/lib/streaming/sse-event-types.ts` |
| Stream Request | `/lib/streaming/types.ts` |
| Model Compare | `/lib/compare/dual-stream-merger.ts` |
| History Adapter | `/lib/nexus/history-adapter.ts` |
| Polling Adapter | `/lib/nexus/nexus-polling-adapter.ts` |
| Workspace Tools | `/lib/nexus/workspace-chat-tools.ts` |
| MCP Connector | `/lib/mcp/connector-service.ts` |
| MCP Content Tools | `/lib/mcp/content-tools.ts` |
| Provider-Native Tools | `/lib/tools/provider-native-tools.ts` |
| AI Helpers | `/lib/ai-helpers.ts` |
