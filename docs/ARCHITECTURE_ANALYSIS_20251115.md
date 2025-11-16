# Architecture Documentation Analysis - AI Studio

## Executive Summary

AI Studio has **strong foundational architecture documentation** with clear patterns, but **lacks visual data flow and component relationship diagrams** that would significantly improve developer onboarding. The documentation is well-organized and detailed in specific areas, but fragmented across multiple files.

**Documentation Maturity: 7/10**
- Strong conceptual docs
- Weak visual representations
- Missing dependency mapping
- Good code patterns but scattered

---

## 1. Documented Architecture Components

### 1.1 Overall System Architecture ✅

**File:** `ARCHITECTURE.md` (lines 43-74)

**Coverage:**
- High-level system diagram showing client → Next.js → Cognito
- Layered architecture overview (Presentation → Application → Infrastructure)
- Technology stack clearly defined

**Gaps:**
- No detailed request flow diagrams
- Missing deployment pipeline visualization
- No service dependency graph
- Unclear how components interact during execution

### 1.2 Frontend/Backend Interaction ⚠️ (Partial)

**Documented:**
- Server Actions return `ActionState<T>` pattern
- API routes with streaming support
- useChat hook integration from `@ai-sdk/react`

**Files:**
- `CLAUDE.md` - Server action template
- `API/AI_SDK_PATTERNS.md` - Streaming patterns (lines 62-98)
- `guides/LOGGING.md` - API route patterns (lines 134-229)

**Gaps:**
- No visualization of client-server message flow
- Missing error handling flow diagram
- Unclear how streaming errors propagate back to UI
- No authentication handshake diagram

**Example Missing Diagram:**
```
User Input → Component → Server Action → Database → Response
                                  ↓
                            Error Handling
                                  ↓
                            CloudWatch Logs
```

### 1.3 AI Provider Integration 🟡 (Good but Scattered)

**Files:**
- `API/AI_SDK_PATTERNS.md` - Core provider patterns
- `CLAUDE.md` - Quick provider reference
- `guides/adding-ai-providers.md` - Provider integration guide
- `features/ai-streaming-core-package.md` - Shared package structure

**Documented:**
- Provider factory pattern (unified interface)
- Streaming with `streamText`
- Client-side `useChat` integration
- Token tracking

**Gaps:**
- **No diagram showing provider selection flow**
- Missing provider capability matrix visualization
- No example of multi-provider comparison rendering
- Unclear how provider settings are loaded and cached

**Critical Gap:** Where does the provider actually get selected? UI component → Server Action → Database lookup → Factory pattern. Not clearly visualized.

### 1.4 Database Architecture 🟡 (Schema Defined, Relationships Unclear)

**Documented:**
- Core tables listed (users, models, conversations, messages, repositories)
- Migration strategy (immutable 001-005, new migrations 010+)
- Field transformation (snake_case → camelCase)

**Files:**
- `ARCHITECTURE.md` (lines 134-161)
- Database schema files: `001-enums.sql` through `037-*.sql`
- `guides/LOGGING.md` - Database operation examples

**Gaps:**
- **No Entity-Relationship Diagram (ERD)**
- Missing table relationship descriptions
- Unclear foreign key hierarchies
- No visualization of data flow through tables

**Example Missing Diagram:**
```
users ──→ user_roles ──→ roles
  ↓
  ├─→ conversations ──→ messages
  │                        ↓
  │                    token_usage
  │
  ├─→ repositories ──→ repository_files ──→ embeddings
  │
  └─→ documents ──→ document_chunks
```

### 1.5 Authentication Flow 🟢 (Well Documented)

**Files:**
- `ARCHITECTURE.md` (lines 164-182)
- `security/USING_IAM_SECURITY.md`
- `architecture/ADR-001-authentication-optimization.md`

**Documented:**
- OAuth flow with Cognito and Google federation
- JWT session management
- Role-based access control (RBAC)
- Tool-specific permissions

**Gaps:**
- Session refresh flow not diagrammed
- Token rotation process unclear
- Missing session contamination safeguards diagram

**Well-Explained:**
- Security headers and CSRF protection
- Parameterized queries for SQL injection prevention
- PII redaction in logs

### 1.6 Streaming Architecture 🟢 (Excellent Documentation with ADRs)

**Files:**
- `ARCHITECTURE.md` (lines 597-691) - Current architecture
- `architecture/ADR-002-streaming-architecture-migration.md` - Amplify → ECS
- `architecture/ADR-003-ecs-streaming-migration.md` - Lambda → Direct ECS
- `operations/streaming-infrastructure.md`

**Documented:**
- Evolution from Amplify → ECS Fargate → Direct ECS
- HTTP/2 streaming via ALB
- Real-time vs. buffered responses
- Cost savings and performance metrics

**Gaps:**
- No detailed packet flow diagram showing ALB → ECS → Client
- Missing SSE (Server-Sent Events) payload examples
- Unclear how long-running operations are handled in ECS
- No timeout/backpressure handling visualization

### 1.7 File Upload Architecture ✅

**File:** `features/file-upload-architecture.md`

**Documented:**
- Two-path architecture (small ≤1MB direct, large >1MB presigned)
- S3 integration with presigned URLs
- Processing flow
- Security measures

**Gaps:**
- No state machine diagram for upload states
- Missing error recovery path visualization
- Unclear concurrent upload handling

### 1.8 Embedding System 🟡 (Pipeline Documented, Integration Unclear)

**File:** `features/EMBEDDING_SYSTEM.md`

**Documented:**
- File Processor Lambda → SQS → Embedding Generator Lambda → PostgreSQL
- Configuration via database
- Supported providers (OpenAI, Bedrock, Azure)
- Status tracking

**Gaps:**
- **No diagram showing chunk processing pipeline**
- Missing vector storage and retrieval flow
- Unclear how embeddings are used for semantic search
- No performance metrics for batch processing

### 1.9 Assistant Architect Tool Integration 🟡 (Events Documented, Execution Unclear)

**Files:**
- `ARCHITECTURE.md` (lines 255-595) - Comprehensive
- `features/assistant-architect-sse-events.md` - Event streaming
- `operations/assistant-architect-tools-troubleshooting.md`

**Documented:**
- Tool registry and validation pipeline
- Execution pipeline with Lambda workers
- Security constraints (network isolation, resource limits)
- Event types and storage

**Gaps:**
- **No flow diagram for prompt chain execution**
- Missing variable substitution visualization
- Unclear how tool results get injected back into prompt chain
- No state diagram for execution states

**Critical Gap:** How does a 3-prompt chain with tools and knowledge retrieval execute? Unclear.

---

## 2. API Documentation & Contracts

### 2.1 Server Actions 🟢

**Files:**
- `CLAUDE.md` (lines 106-145) - Template
- `guides/LOGGING.md` (lines 22-132) - Detailed patterns
- `API/AI_SDK_PATTERNS.md` - Provider-specific patterns

**Documented:**
- ActionState<T> response contract
- Request ID generation and tracing
- Error handling patterns
- Logging structure

**Gaps:**
- No API specification file (OpenAPI/Swagger)
- Missing server action listing
- No validation contract documentation
- Unclear which actions are protected vs. public

### 2.2 API Routes 🟡

**Documented:**
- Streaming chat endpoint pattern
- Document upload endpoints
- OAuth callback routes

**Gaps:**
- **No complete API endpoint reference**
- Missing request/response schema documentation
- No rate limiting documentation
- Unclear error response formats

**Missing Documentation:**
```
POST /api/chat - Request/Response schemas
POST /api/documents/upload - Multipart handling
GET /api/documents/presigned-url - Query params
POST /api/assistant-architect/execute - Event streaming
GET /api/assistant-architect/events/[id] - SSE format
```

### 2.3 Real-Time Contracts 🟡

**Documented:**
- SSE event types (execution-start, prompt-start, etc.)
- Token usage tracking
- Progress events

**Gaps:**
- No client-side event listener patterns
- Missing error event contract
- No timeout/disconnection handling documented
- Unclear event ordering guarantees

---

## 3. Component Relationships & Data Flow

### 3.1 Missing Relationship Maps 🔴

**No documentation of:**

1. **Component Tree Structure**
   - Which components use which server actions
   - Component dependencies
   - State lifting patterns

2. **Data Flow Through Application**
   ```
   Example Gap: How does a user input flow through:
   UI Component → Server Action → DB Query → Cache Check → Response
   ```

3. **Service Layer Dependencies**
   ```
   Example Gap: 
   - What imports SettingsManager?
   - Which lambdas depend on RDS?
   - How does the embedding system connect to search?
   ```

4. **Infrastructure-to-Code Mapping**
   ```
   Example Gap:
   - Which Lambda function handles file processing?
   - How does ECS communicate with RDS?
   - What S3 buckets are accessed by which components?
   ```

### 3.2 Execution Flow Gaps 🔴

**Missing Diagrams:**

1. **Message Flow in Chat System**
   ```
   User Input → Chat Component → Server Action → Provider Factory → AI SDK → ECS Stream → SSE → Browser
                                                        ↓
                                                  Token Usage Tracking
                                                        ↓
                                                  Database Save
   ```

2. **Document Processing Pipeline**
   ```
   Upload → S3 → File Processor Lambda → Text Extraction → SQS → Embedding Generator → PostgreSQL
                                      ↓
                                 Status Update
   ```

3. **Assistant Architect Execution**
   ```
   User Input → Prompt 1 → [Knowledge Retrieval] → [Variable Injection] → AI Stream → Store Event
                    ↓
              Prompt 2 → [Tool Execution?] → Result Storage
                    ↓
              Prompt 3 → Final Output
   ```

---

## 4. Missing Architectural Documentation

### 4.1 Critical Gaps

| Gap | Impact | Priority |
|-----|--------|----------|
| **Entity-Relationship Diagram** | Developers don't understand data model | HIGH |
| **Component Dependency Graph** | Circular dependencies undetected | HIGH |
| **Provider Selection Flow** | Unclear where/how providers are chosen | HIGH |
| **Error Propagation Map** | Hard to trace errors from API → UI | HIGH |
| **Request Tracing Flow** | Unclear how request IDs flow through system | MEDIUM |
| **Caching Strategy Diagram** | Settings cache, model config cache interaction unclear | MEDIUM |
| **Streaming Payload Format** | No SSE chunk structure documentation | MEDIUM |
| **Token Usage Accounting** | How are tokens tracked end-to-end? | MEDIUM |
| **Assistant Architect Execution Flow** | Complex multi-prompt execution unclear | HIGH |
| **Vector Search Integration** | How embeddings connect to semantic search | MEDIUM |

### 4.2 Documentation Organization Issues

**Problem:** Documentation is scattered and fragmented

**Current State:**
- `ARCHITECTURE.md` - High level
- `API/AI_SDK_PATTERNS.md` - Provider patterns
- `guides/LOGGING.md` - Logging patterns
- `features/` - Individual features
- `operations/` - Infrastructure operations
- `CLAUDE.md` - Quick reference

**Issue:** A developer looking for "how does a request flow through the system?" must search multiple files.

**Better Approach:**
- Unified "Request Flows" section with diagrams
- Centralized "Data Model" with ERD
- "Component Index" mapping files to their purpose
- "Integration Guide" showing how pieces connect

---

## 5. Where Diagrams Would Help Most

### 5.1 Request Flow Diagrams (Critical)

**Example: Chat Message Request**
```
┌─────────────┐
│ User Clicks │
│   "Send"    │
└──────┬──────┘
       ▼
┌──────────────────────┐
│ useChat hook updates │
│   local messages     │
└──────┬───────────────┘
       ▼
┌──────────────────────────────┐
│ POST /api/chat with          │
│ - messages array             │
│ - modelId, provider          │
│ - conversationId             │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ Server: getServerSession()   │
│ Validate authentication      │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────────────┐
│ createProviderModel(provider, modelId)│
│ (Factory Pattern)                     │
└──────┬───────────────────────────────┘
       ▼
┌──────────────────────────────┐
│ Get API keys from:           │
│ 1. Database settings         │
│ 2. Environment variables     │
│ 3. AWS Secrets Manager       │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ Initialize AI SDK provider   │
│ (OpenAI/Google/Bedrock/etc)  │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ streamText() with model      │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ Response.toResponse()        │
│ Returns SSE stream           │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ Client receives text chunks  │
│ via EventSource API          │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ useChat hook:                │
│ - Accumulates text           │
│ - Updates UI in real-time    │
│ - Calls onFinish callback    │
└──────┬───────────────────────┘
       ▼
┌──────────────────────────────┐
│ onFinish: Save to database   │
│ - Store conversation         │
│ - Track token usage          │
│ - Record execution event     │
└──────────────────────────────┘
```

### 5.2 Provider Selection Flow (Critical)

Current documentation doesn't show WHERE/HOW provider is selected:

```
┌─────────────────────────────────────┐
│ Chat UI Component                    │
│ - Model selector dropdown            │
│ - Provider selector dropdown         │
└────────────┬────────────────────────┘
             │ User selects: GPT-4, OpenAI
             ▼
┌─────────────────────────────────────┐
│ Server Action or API Route           │
│ - Receives provider: 'openai'        │
│ - Receives modelId: 'gpt-4-turbo'    │
└────────────┬────────────────────────┘
             │ Lookup in models table
             ▼
┌─────────────────────────────────────┐
│ Database Query:                      │
│ SELECT * FROM models                 │
│ WHERE model_id = 'gpt-4-turbo'       │
│ AND provider = 'openai'              │
│ AND is_available_for_chat = true     │
└────────────┬────────────────────────┘
             │ Results in ModelConfig
             ▼
┌─────────────────────────────────────┐
│ Provider Factory:                    │
│ createProviderModel('openai',        │
│                    'gpt-4-turbo')    │
└────────────┬────────────────────────┘
             │ Load settings:
             │ 1. Check database
             │ 2. Check env vars
             │ 3. Check Secrets Manager
             ▼
┌─────────────────────────────────────┐
│ Initialize AI SDK:                   │
│ createOpenAI({ apiKey, baseURL })    │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Use model for streaming/generation   │
└─────────────────────────────────────┘
```

### 5.3 Database Schema Relationship (Critical)

**Current:** Text list in ARCHITECTURE.md

**Better:** ERD showing:
- users → conversations → messages → token_usage
- users → repositories → repository_files → embeddings
- models → ai_models_capabilities
- roles → user_roles → tools → role_tools

### 5.4 Error Flow (High Value)

```
┌──────────────────────────┐
│ Error thrown in:         │
│ - Server action          │
│ - API route              │
│ - Database query         │
│ - External API call      │
└───────────┬──────────────┘
            │ Caught by handleError()
            ▼
┌──────────────────────────────────┐
│ Error Classification:             │
│ - Validation error (400)          │
│ - Auth error (401/403)            │
│ - Not found (404)                 │
│ - Server error (500)              │
└───────────┬──────────────────────┘
            │ Logged with:
            │ - requestId (tracing)
            │ - user context (PII redacted)
            │ - stack trace (dev only)
            ▼
┌──────────────────────────────────┐
│ CloudWatch Log Group:             │
│ /aws/lambda/[function-name]      │
│ or /ecs/[service-name]            │
└───────────┬──────────────────────┘
            │ Can search by requestId
            │ in CloudWatch Logs
            ▼
┌──────────────────────────────────┐
│ Return to Client:                 │
│ ActionState<T> {                  │
│   isSuccess: false                │
│   error: { code, message }        │
│ }                                 │
└───────────┬──────────────────────┘
            │
            ▼
┌──────────────────────────────────┐
│ Client Error Handler:             │
│ - Show toast/error message        │
│ - Retry with backoff?             │
│ - Log requestId for support       │
└──────────────────────────────────┘
```

### 5.5 Assistant Architect Prompt Chain Execution (Complex)

```
User Input: "Analyze code in repository X, compare with benchmark Y, generate report"
   │
   ▼
┌────────────────────────────────────────┐
│ Load Prompt Chain (3 prompts):          │
│ 1. Prompt: Analyze code                │
│ 2. Prompt: Compare with benchmark      │
│ 3. Prompt: Generate report             │
└────────┬───────────────────────────────┘
         │
         ▼ Emit: execution-start
┌────────────────────────────────────────┐
│ For Prompt 1 (Analyze code):           │
│                                        │
│ 1. Check for knowledge retrieval      │
│    → Search repositories for code      │
│    → Emit: knowledge-retrieval-start   │
│    → Get relevant files (embeddings)   │
│    → Emit: knowledge-retrieved         │
│                                        │
│ 2. Check for variable substitution     │
│    → Find variables: $codeContent      │
│    → Replace with retrieved context    │
│    → Emit: variable-substitution       │
│                                        │
│ 3. Check for enabled tools             │
│    → Web search? Code interpreter?     │
│    → [Future: tool-execution events]   │
│                                        │
│ 4. Build system prompt with context    │
│    → Add knowledge                     │
│    → Add tool descriptions             │
│                                        │
│ 5. Stream AI response with tokens      │
│    → Emit: prompt-complete             │
│    → Store output in context var       │
└────────┬───────────────────────────────┘
         │
         ▼ Use output as input
┌────────────────────────────────────────┐
│ For Prompt 2 (Compare):                │
│ - Repeat same process                  │
│ - Has access to:                       │
│   - Original user input                │
│   - Prompt 1 output (via variables)    │
│   - Knowledge about benchmarks         │
└────────┬───────────────────────────────┘
         │
         ▼ Use output as input
┌────────────────────────────────────────┐
│ For Prompt 3 (Generate report):        │
│ - Repeat same process                  │
│ - Has access to:                       │
│   - Prompt 1 output                    │
│   - Prompt 2 output                    │
└────────┬───────────────────────────────┘
         │
         ▼ Emit: execution-complete
┌────────────────────────────────────────┐
│ Store Events in Database:              │
│ - assistant_architect_events table     │
│ - Query later for audit/analytics      │
└────────────────────────────────────────┘
```

---

## 6. Documentation Recommendations

### Priority 1: Create Diagrams (2-3 days)

**Create:**
1. **System Request Flow Diagram** - Chat message → AI response
2. **Database ERD** - All tables and relationships
3. **Provider Selection Flow** - How providers are chosen and configured
4. **Error Handling Flow** - Error → Log → Response
5. **Assistant Architect Execution Diagram** - Multi-prompt with knowledge/tools

**Format:**
- Mermaid diagrams (embed in markdown)
- PlantUML as alternative
- PNG exports for documentation PDFs

### Priority 2: Create Integration Guides (1-2 days)

**Create:**
1. **Component Integration Guide**
   - Which server actions each component calls
   - Data passing patterns
   - Common parent components

2. **Data Flow Reference**
   - User input → database
   - Database → UI rendering
   - Server → client streaming

3. **Provider Integration Checklist**
   - Settings needed
   - API key management
   - Error handling
   - Token tracking

4. **Error Code Reference**
   - All error types
   - HTTP status codes
   - User-facing messages

### Priority 3: API Documentation (1 day)

**Create:**
1. **API Endpoint Reference**
   - All POST/GET/PUT/DELETE endpoints
   - Request schemas
   - Response schemas
   - Error responses

2. **Server Action Catalog**
   - List all actions
   - Parameters and return types
   - When to use each

3. **Type Definitions Guide**
   - ActionState<T> structure
   - Common interfaces
   - Model configurations

### Priority 4: Operational Dashboards (2-3 days)

**Create:**
1. **Component Dependency Map**
   - Which files import what
   - Circular dependency detection

2. **Database Query Heat Map**
   - Frequently queried tables
   - Slow query analysis
   - N+1 detection

3. **Provider Usage Analytics**
   - Which providers are used
   - Token consumption by model
   - Cost tracking

---

## 7. Specific Areas Needing Diagrams

### 7.1 Authentication & Authorization
- [ ] OAuth callback flow
- [ ] Session refresh timing
- [ ] Tool permission checking logic
- [ ] Role inheritance diagram

### 7.2 Data Processing
- [ ] File upload → chunking → embedding
- [ ] Vector search query flow
- [ ] Cache invalidation strategy
- [ ] Database transaction boundaries

### 7.3 Streaming & Real-Time
- [ ] SSE event sequencing
- [ ] Backpressure handling
- [ ] Connection lifecycle
- [ ] Error recovery in streaming

### 7.4 Infrastructure
- [ ] VPC topology and security groups
- [ ] Lambda → RDS connection flow
- [ ] ECS task startup sequence
- [ ] ALB routing rules

### 7.5 AI Integration
- [ ] Token counting process
- [ ] Cost calculation
- [ ] Rate limiting strategy
- [ ] Model fallback logic

---

## 8. Documentation Health Metrics

| Metric | Score | Notes |
|--------|-------|-------|
| **Conceptual Clarity** | 8/10 | Good ARCHITECTURE.md, patterns clear |
| **Visual Aids** | 3/10 | Few diagrams, mostly text |
| **Component Relationships** | 3/10 | No dependency graphs |
| **Data Flow Clarity** | 4/10 | Scattered across files |
| **API Documentation** | 5/10 | Patterns shown but no endpoint ref |
| **Error Handling** | 7/10 | Good error factory docs |
| **Deployment Clarity** | 7/10 | Good ADRs and DEPLOYMENT.md |
| **Code Example Coverage** | 8/10 | Excellent pattern examples |
| **Organization** | 6/10 | Scattered across multiple files |
| **Searchability** | 5/10 | Hard to find cross-cutting concerns |

**Overall: 5.6/10 - Good foundation, needs visual organization**

---

## 9. Quick Wins (Easy, High-Impact)

### 9.1 Create System Overview Document
File: `/docs/SYSTEM_OVERVIEW.md`
- Single visual showing all major components
- Color-coded by layer (presentation/application/infrastructure)
- Quick reference for new developers

### 9.2 Create Request Flow Document
File: `/docs/REQUEST_FLOWS.md`
- Documented flows: Chat, Upload, Assistant Architect, OAuth
- Before/after code execution
- Error scenarios

### 9.3 Create Data Model Documentation
File: `/docs/DATA_MODEL.md`
- ERD diagram
- Table descriptions
- Key relationships
- Common queries

### 9.4 Create Component Index
File: `/docs/COMPONENT_INDEX.md`
- All major components/services
- Purpose of each
- Key files involved
- Dependencies

### 9.5 Update ARCHITECTURE.md TOC
Add section: "System Request Flows" with embedded diagrams

---

## 10. Files That Would Benefit from Diagrams

### By Category

**Core Architecture (Critical)**
- `/docs/ARCHITECTURE.md` - Add system flow diagrams
- `/docs/README.md` - Add overview diagram

**Data Management**
- `/docs/features/EMBEDDING_SYSTEM.md` - Pipeline diagram
- Missing: Database ERD
- Missing: Data lifecycle document

**Integration**
- `/docs/API/AI_SDK_PATTERNS.md` - Add provider selection flow
- `/docs/features/assistant-architect-sse-events.md` - Add execution flow
- Missing: Component integration reference

**Operations**
- `/docs/operations/streaming-infrastructure.md` - Add packet flow
- `/docs/operations/OPERATIONS.md` - Add monitoring dashboard overview
- Missing: Infrastructure topology

**Security**
- `/docs/security/IAM_LEAST_PRIVILEGE.md` - Add permission flow
- `/docs/security/USING_IAM_SECURITY.md` - Add role hierarchy diagram

---

## 11. Next Steps for Documentation

### Week 1: Foundation
1. Create SYSTEM_OVERVIEW.md with main architecture diagram
2. Add Mermaid diagram support to documentation toolchain
3. Create ERD of database schema
4. Create REQUEST_FLOWS.md with 3-4 main flows

### Week 2: Integration
1. Create COMPONENT_INDEX.md
2. Document provider selection flow
3. Create error handling reference
4. Update all major docs with cross-references

### Week 3: Operations
1. Create infrastructure topology diagram
2. Add monitoring dashboard reference
3. Create performance tuning guide
4. Create troubleshooting decision tree

### Week 4: Polish
1. Create API reference from code analysis
2. Generate dependency graphs
3. Create deployment flowcharts
4. Update documentation index

---

## Conclusion

AI Studio has **excellent foundational documentation** with clear code patterns, strong architectural decisions (documented in ADRs), and comprehensive guides. However, **the lack of visual diagrams and unified data flow documentation** significantly hinders developer onboarding.

**Key improvements needed:**
1. Add visual diagrams (flowcharts, ERD, dependency graphs)
2. Create unified request flow documentation
3. Build component integration reference
4. Establish architectural patterns index
5. Document cross-service communication flows

**Priority:** Start with Request Flows and Database ERD - these are the most blocking for new developer onboarding.

