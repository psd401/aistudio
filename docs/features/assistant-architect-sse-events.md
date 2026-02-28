# Assistant Architect SSE Progress Events

**Status:** ✅ Implemented (Database Storage) | 🚧 Pending (Real-Time Streaming)
**Issue:** #336
**PR:** #360

## Overview

The Assistant Architect now emits detailed Server-Sent Events (SSE) for fine-grained progress tracking during execution. Events are stored in the database for audit trails and debugging, with infrastructure in place for future real-time streaming.

## Event Types

### Execution Lifecycle

#### `execution-start`
Emitted when an assistant architect execution begins.

```typescript
{
  executionId: number;
  totalPrompts: number;
  toolName: string;
  timestamp: string;
  eventId: string;
}
```

#### `execution-complete`
Emitted when execution completes successfully.

```typescript
{
  executionId: number;
  totalTokens: number;
  duration: number; // milliseconds
  success: true;
  timestamp: string;
  eventId: string;
}
```

#### `execution-error`
Emitted when execution fails.

```typescript
{
  executionId: number;
  error: string;
  promptId?: number; // Which prompt failed, if applicable
  recoverable: boolean;
  details?: string; // Stack trace or additional info
  timestamp: string;
  eventId: string;
}
```

### Prompt-Level Events

#### `prompt-start`
Emitted before each prompt executes.

```typescript
{
  promptId: number;
  promptName: string;
  position: number; // 1-indexed position in chain
  totalPrompts: number;
  modelId: string;
  hasKnowledge: boolean; // Has repository context
  hasTools: boolean; // Has enabled tools
  timestamp: string;
  eventId: string;
}
```

#### `prompt-complete`
Emitted after prompt completes.

```typescript
{
  promptId: number;
  outputTokens: number;
  duration: number; // milliseconds
  cached: boolean; // Whether response was cached
  timestamp: string;
  eventId: string;
}
```

### Knowledge Retrieval

#### `knowledge-retrieval-start`
Emitted when starting repository knowledge search.

```typescript
{
  promptId: number;
  repositories: number[]; // Repository IDs
  searchType: 'vector' | 'keyword' | 'hybrid';
  timestamp: string;
  eventId: string;
}
```

#### `knowledge-retrieved`
Emitted when knowledge retrieval completes.

```typescript
{
  promptId: number;
  documentsFound: number;
  relevanceScore: number; // Average relevance (0-1)
  tokens: number; // Total tokens in retrieved context
  timestamp: string;
  eventId: string;
}
```

### Variable & Context

#### `variable-substitution`
Emitted when variables are substituted in a prompt.

```typescript
{
  promptId: number;
  variables: Record<string, string>; // Substituted variables
  sourcePrompts: number[]; // Prompt IDs that provided values
  timestamp: string;
  eventId: string;
}
```

### Tool Execution (Placeholder)

These events are defined but not yet emitted (for future tool execution tracking):

```typescript
// tool-execution-start
{
  promptId: number;
  toolName: string;
  parameters?: Record<string, unknown>;
  timestamp: string;
  eventId: string;
}

// tool-execution-complete
{
  promptId: number;
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
  timestamp: string;
  eventId: string;
}
```

### Progress (Placeholder)

General progress tracking (not yet implemented):

```typescript
{
  currentStep: number;
  totalSteps: number;
  percentage: number;
  message: string;
  timestamp: string;
  eventId: string;
}
```

## Usage

### Retrieving Events

```typescript
import {
  getExecutionEvents,
  getExecutionEventsByType
} from '@/lib/assistant-architect/event-storage';

// Get all events for an execution (chronological order)
const allEvents = await getExecutionEvents(executionId);

// Get specific event type
const promptStarts = await getExecutionEventsByType(
  executionId,
  'prompt-start'
);

// Example: Calculate execution timeline
const startEvent = await getExecutionEventsByType(executionId, 'execution-start');
const completeEvent = await getExecutionEventsByType(executionId, 'execution-complete');

if (startEvent[0] && completeEvent[0]) {
  const start = new Date(startEvent[0].eventData.timestamp);
  const end = new Date(completeEvent[0].eventData.timestamp);
  const duration = end.getTime() - start.getTime();
  console.log(`Execution took ${duration}ms`);
}
```

### Event Data Structure

All events are stored in the `assistant_architect_events` table:

```sql
SELECT
  id,
  execution_id,
  event_type,
  event_data,
  created_at
FROM assistant_architect_events
WHERE execution_id = :executionId
ORDER BY created_at ASC;
```

Event data is stored as JSONB for flexible querying:

```sql
-- Find all prompts that used knowledge retrieval
SELECT event_data->>'promptId' as prompt_id,
       event_data->>'documentsFound' as docs_found
FROM assistant_architect_events
WHERE event_type = 'knowledge-retrieved'::assistant_event_type
  AND execution_id = :executionId;

-- Calculate average prompt duration
SELECT AVG((event_data->>'duration')::integer) as avg_duration_ms
FROM assistant_architect_events
WHERE event_type = 'prompt-complete'::assistant_event_type
  AND execution_id = :executionId;
```

## Architecture

### Current Implementation: Database Storage

Events are stored asynchronously during execution:

```
User triggers execution
  ↓
Execution starts → emit execution-start
  ↓
For each prompt:
  ↓
  Emit prompt-start
  ↓
  [Knowledge retrieval] → emit knowledge-retrieval-start/retrieved
  ↓
  [Variable substitution] → emit variable-substitution
  ↓
  [AI Streaming] → (existing AI SDK stream)
  ↓
  Emit prompt-complete
  ↓
Emit execution-complete
  ↓
Events stored in database
```

**Benefits:**
- Complete audit trail
- No impact on streaming performance
- Queryable for analytics
- Foundation for real-time streaming

### Future: Real-Time SSE Endpoint

A separate endpoint will stream events in real-time:

```
Client subscribes to /api/assistant-architect/events/:executionId
  ↓
Server creates SSE stream
  ↓
Events emitted during execution are sent to:
  1. Database (audit trail)
  2. SSE stream (real-time)
  ↓
Client receives events as they occur
```

**Implementation approach:**
```typescript
// Future endpoint: /app/api/assistant-architect/events/[executionId]/route.ts
export async function GET(
  req: Request,
  { params }: { params: { executionId: string } }
) {
  const { response, emitEvent } = createSSEStream();

  // Subscribe to execution events
  // Emit as they occur

  return response;
}
```

## Client Integration (Future)

### EventSource API

```typescript
// Subscribe to execution events
const eventSource = new EventSource(
  `/api/assistant-architect/events/${executionId}`
);

// Listen for specific events
eventSource.addEventListener('prompt-start', (e) => {
  const data = JSON.parse(e.data);
  updatePromptStatus(data.promptId, 'running');
  showProgressIndicator(data.position, data.totalPrompts);
});

eventSource.addEventListener('knowledge-retrieved', (e) => {
  const data = JSON.parse(e.data);
  showKnowledgeIndicator(data.documentsFound);
});

eventSource.addEventListener('execution-complete', (e) => {
  const data = JSON.parse(e.data);
  hideProgressIndicator();
  showCompletionMessage(data.duration);
  eventSource.close();
});

eventSource.addEventListener('execution-error', (e) => {
  const data = JSON.parse(e.data);
  showErrorMessage(data.error);
  eventSource.close();
});
```

### React Hook (Future)

```typescript
function useExecutionEvents(executionId: number) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');

  useEffect(() => {
    const eventSource = new EventSource(`/api/assistant-architect/events/${executionId}`);

    eventSource.addEventListener('execution-start', (e) => {
      setStatus('running');
      setEvents(prev => [...prev, JSON.parse(e.data)]);
    });

    eventSource.addEventListener('execution-complete', (e) => {
      setStatus('complete');
      setEvents(prev => [...prev, JSON.parse(e.data)]);
      eventSource.close();
    });

    eventSource.addEventListener('execution-error', (e) => {
      setStatus('error');
      setEvents(prev => [...prev, JSON.parse(e.data)]);
      eventSource.close();
    });

    // Add other event listeners...

    return () => eventSource.close();
  }, [executionId]);

  return { events, status };
}
```

## Performance Considerations

### Database Storage
- Events stored asynchronously (non-blocking)
- Errors logged but don't break execution
- JSONB column for flexible querying
- Indexes on `execution_id` and `event_type` for fast retrieval

### Future Real-Time Streaming
- Use batching for high-frequency events
- Immediate transmission for critical events (errors, start/complete)
- HTTP/2 for efficient SSE connections
- Connection timeout and reconnection handling

## Testing

### Unit Tests (TODO)

```typescript
describe('SSE Event Emission', () => {
  it('should emit execution-start event', async () => {
    const events = await getExecutionEventsByType(executionId, 'execution-start');
    expect(events).toHaveLength(1);
    expect(events[0].eventData.totalPrompts).toBe(3);
  });

  it('should emit prompt events in order', async () => {
    const events = await getExecutionEvents(executionId);
    const promptEvents = events.filter(e =>
      e.eventType === 'prompt-start' || e.eventType === 'prompt-complete'
    );
    expect(promptEvents[0].eventType).toBe('prompt-start');
    expect(promptEvents[1].eventType).toBe('prompt-complete');
  });
});
```

### E2E Tests (TODO)

```typescript
test('should track multi-prompt execution', async ({ page }) => {
  await page.goto('/assistant-architect/1');
  await page.fill('[name="input"]', 'test input');
  await page.click('button[type="submit"]');

  // Wait for execution to complete
  await page.waitForSelector('.execution-complete');

  // Check events were recorded
  const events = await getExecutionEvents(executionId);
  expect(events).toContainEventType('execution-start');
  expect(events).toContainEventType('prompt-start');
  expect(events).toContainEventType('execution-complete');
});
```

## Migration Guide

### Applying the Schema

The migration is automatically applied on deployment:

```bash
# Local development (if needed)
cd infra
bunx cdk deploy AIStudio-FrontendStack-Dev
```

### Rollback (if needed)

```sql
DROP TABLE IF EXISTS assistant_architect_events;
DROP TYPE IF EXISTS assistant_event_type;
```

## Monitoring & Analytics

### Execution Analytics

```sql
-- Average execution time by tool
SELECT
  start_event.event_data->>'toolName' as tool_name,
  AVG(
    EXTRACT(EPOCH FROM (complete_event.created_at - start_event.created_at)) * 1000
  ) as avg_duration_ms
FROM assistant_architect_events start_event
JOIN assistant_architect_events complete_event
  ON start_event.execution_id = complete_event.execution_id
WHERE start_event.event_type = 'execution-start'::assistant_event_type
  AND complete_event.event_type = 'execution-complete'::assistant_event_type
GROUP BY tool_name;

-- Most used repositories
SELECT
  jsonb_array_elements_text(event_data->'repositories') as repository_id,
  COUNT(*) as usage_count
FROM assistant_architect_events
WHERE event_type = 'knowledge-retrieval-start'::assistant_event_type
GROUP BY repository_id
ORDER BY usage_count DESC;

-- Error rate by tool
SELECT
  start_event.event_data->>'toolName' as tool_name,
  COUNT(error_event.id)::float / COUNT(start_event.id) as error_rate
FROM assistant_architect_events start_event
LEFT JOIN assistant_architect_events error_event
  ON start_event.execution_id = error_event.execution_id
  AND error_event.event_type = 'execution-error'::assistant_event_type
WHERE start_event.event_type = 'execution-start'::assistant_event_type
GROUP BY tool_name;
```

## Related Files

- **Types:** `types/sse-events.ts`
- **Event Emitter:** `lib/streaming/sse-event-emitter.ts`
- **Stream Wrapper:** `lib/streaming/sse-stream-wrapper.ts` (infrastructure)
- **Storage:** `lib/assistant-architect/event-storage.ts`
- **Execution:** `app/api/assistant-architect/execute/route.ts`
- **Schema:** `infra/database/schema/037-assistant-architect-events.sql`

## Future Enhancements

- [ ] Real-time SSE endpoint for live event streaming
- [ ] Client components with EventSource integration
- [ ] Progress visualization UI components
- [ ] Analytics dashboard using events data
- [ ] Tool execution event emission (when tools are supported)
- [ ] Progress events for long-running operations
- [ ] Event export/download functionality
- [ ] Webhook support for event notifications

## References

- Issue: #336
- PR: #360
- Research: See issue comments for detailed technical research
- AI SDK Docs: https://sdk.vercel.ai/docs
- MDN SSE: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
