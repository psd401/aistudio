# AI Studio Architecture

## Overview

AI Studio is a Next.js 16 enterprise application built with modern cloud-native architecture principles. It provides AI-powered tools with role-based access control, featuring multiple LLM providers, document processing, and knowledge management capabilities.

> **📊 Visual Diagrams**: See `/docs/diagrams/` for comprehensive architectural diagrams including:
> - [CDK Stack Dependencies](./diagrams/01-cdk-stack-dependencies.md)
> - [VPC Network Topology](./diagrams/02-vpc-network-topology.md)
> - [AWS Service Architecture](./diagrams/03-aws-service-architecture.md)
> - [Database ERD](./diagrams/04-database-erd.md)
> - [Authentication Flow](./diagrams/05-authentication-flow.md)
> - [Request Flow Diagrams](./diagrams/06-request-flow-diagrams.md)

## Technology Stack

### Core Framework
- **Frontend**: Next.js 16 with App Router, React 19
- **UI Components**: Shadcn UI + Tailwind CSS
- **TypeScript**: Strict type safety across the application

### AI & Machine Learning
- **AI SDK**: Vercel AI SDK v6 for LLM integration
- **Providers**: 
  - OpenAI (GPT-5, GPT-4, GPT-3.5)
  - Google AI (Gemini models)
  - Amazon Bedrock (Claude, Llama)
  - Azure OpenAI
- **Streaming**: Server-Sent Events (SSE) for real-time responses
- **Embeddings**: Vector search for knowledge retrieval

### Authentication & Security
- **Auth Provider**: AWS Cognito with Google OAuth federation
- **Session Management**: NextAuth v5 with JWT strategy
- **RBAC**: Role-based access control with tool-specific permissions
- **Security Headers**: CSRF protection, CSP, secure cookies

### Data Layer
- **Database**: AWS Aurora Serverless v2 (PostgreSQL)
- **ORM**: Drizzle ORM with postgres.js driver (type-safe queries)
- **Caching**: 5-minute TTL for settings

### Infrastructure
- **IaC**: AWS CDK (TypeScript)
- **Hosting**: AWS ECS Fargate with Application Load Balancer
- **Container**: Next.js 16 SSR on Fargate with auto-scaling
- **Storage**: S3 with lifecycle policies
- **Monitoring**: CloudWatch with structured logging + ADOT
- **Network**: VPC with public/private/isolated subnets

## System Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│                 │     │              │     │                 │
│  Client (React) │────▶│   Next.js    │────▶│   AWS Cognito   │
│                 │     │  App Router  │     │    + Google     │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │                  │
                    │  Server Actions  │
                    │   & API Routes   │
                    │                  │
                    └──────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
        ┌──────────────┐            ┌──────────────┐
        │              │            │              │
        │  AI Providers│            │  Drizzle ORM │
        │   (Factory)  │            │  (postgres)  │
        │              │            │              │
        └──────────────┘            └──────────────┘
                │                             │
                ▼                             ▼
    ┌───────────────────────┐      ┌──────────────┐
    │ OpenAI/Google/Bedrock │      │Aurora Server-│
    │      Azure APIs       │      │   less v2    │
    └───────────────────────┘      └──────────────┘
```

## Layered Architecture

### Presentation Layer (`/app`, `/components`)
- React Server Components (default)
- Client components with `"use client"` directive
- Shadcn UI components with Tailwind CSS
- Form handling with react-hook-form

### Application Layer (`/actions`)
- Server actions return `ActionState<T>` pattern
- Business logic isolation
- Request ID tracking for tracing
- Comprehensive logging and error handling

### Infrastructure Layer (`/lib`)
- Database adapter (`/lib/db`)
- Authentication utilities (`/lib/auth`)
- AI provider factory (`/app/api/chat/lib`)
- AWS service clients (S3, CloudWatch)
- Settings management with caching

## Key Design Patterns

### 1. ActionState Pattern
All server actions return a consistent response structure:
```typescript
interface ActionState<T> {
  isSuccess: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
  message?: string
}
```

### 2. Provider Factory Pattern
Unified interface for multiple AI providers:
```typescript
createProviderModel(provider: string, modelId: string): Promise<LanguageModel>
```

### 3. Request Tracing
Every operation gets a unique request ID:
```typescript
const requestId = generateRequestId()
const log = createLogger({ requestId, action: "actionName" })
```

### 4. Settings Management
Database-first configuration with environment fallback:
```typescript
// Check database → Fall back to env → Cache result
await getSetting('OPENAI_API_KEY')
```

## Database Schema

### Core Tables

#### Users & Roles
- `users` - User accounts linked to Cognito
- `roles` - Available roles (Admin, Staff)
- `user_roles` - User-role associations
- `tools` - Feature-specific permissions
- `role_tools` - Role-tool associations

#### AI & Chat
- `models` - AI model configurations
- `conversations` - Chat sessions
- `messages` - Chat messages with usage tracking
- `token_usage` - Token consumption tracking

#### Knowledge Management
- `repositories` - GitHub repository metadata
- `repository_files` - Indexed file content
- `documents` - Uploaded documents
- `embeddings` - Vector embeddings for search

#### Assistant Architect
- `assistant_architects` - AI assistant configurations
- `assistant_tools` - Tool assignments
- `assistant_executions` - Execution history

## Security Architecture

### Authentication Flow
1. User initiates sign-in via `/auth/signin`
2. Redirected to Cognito hosted UI
3. Google OAuth authentication
4. Cognito returns authorization code
5. NextAuth exchanges for JWT tokens
6. Session stored in HTTP-only cookies

### Authorization Model
- **Role Hierarchy**: Admin → Staff
- **Tool-Based Permissions**: Granular feature access
- **Session Validation**: Server-side JWT verification
- **CSRF Protection**: State parameter validation

### Data Protection
- **SQL Injection**: Parameterized queries only
- **XSS Prevention**: Input sanitization, CSP headers
- **Secrets Management**: AWS Secrets Manager
- **PII Handling**: Automatic log redaction

## Performance Optimizations

### Caching Strategy
- **Settings**: 5-minute TTL cache
- **Model Configs**: In-memory caching
- **S3 Client**: Connection pooling
- **Database**: postgres.js connection pooling

### Streaming Architecture
- **Chat Responses**: SSE for real-time streaming
- **File Processing**: Chunked uploads for large files
- **Assistant Execution**: Progressive updates

### Code Splitting
- **Route-based**: Automatic with App Router
- **Component-level**: Dynamic imports for heavy components
- **Library-level**: Lazy loading for document processors

## Monitoring & Observability

### Structured Logging
- JSON format in production
- Request ID correlation
- Performance metrics
- User context injection

### CloudWatch Integration
```json
{
  "timestamp": "2025-08-20T10:00:00Z",
  "level": "info",
  "requestId": "abc123",
  "userId": "user-456",
  "action": "chat.completion",
  "duration": 1234,
  "tokens": 500
}
```

### Error Tracking
- Typed error codes (60+ categories)
- Appropriate severity levels
- Stack traces in development
- User-friendly messages in production

## Deployment Architecture

### Infrastructure as Code
All resources defined in AWS CDK:
```
/infra/
├── lib/
│   ├── stacks/
│   │   ├── auth-stack.ts         # Cognito configuration
│   │   ├── database-stack.ts     # Aurora Serverless v2
│   │   ├── frontend-stack.ts     # ECS Fargate + ALB
│   │   ├── guardrails-stack.ts   # Bedrock Guardrails + DynamoDB + SNS
│   │   └── storage-stack.ts      # S3 buckets
│   └── constructs/
│       ├── security/             # IAM, service roles
│       ├── network/              # VPC patterns
│       ├── compute/              # Lambda, ECS
│       └── monitoring/           # CloudWatch, ADOT
└── database/
    └── schema/                   # SQL migrations
```

### Environment Strategy
- **Development**: Feature branches, rapid iteration
- **Staging**: Integration testing, QA
- **Production**: Blue-green deployments

### Database Migrations
1. Files 001-005: Initial schema (immutable)
2. Files 010+: Incremental migrations
3. Lambda-based automatic execution
4. Transaction-wrapped for consistency

## Assistant Architect Tool Integration

### Overview
Assistant Architect supports external tool integration, enabling AI assistants to perform actions beyond text generation. Tools are executed within isolated environments and provide capabilities like web search and code execution.

### Supported Tools

#### Web Search Tool
- **Provider**: SerpAPI integration
- **Models**: GPT-5, Gemini Pro
- **Capabilities**: Real-time web search, current information retrieval
- **Execution**: Asynchronous with 15-second timeout
- **Caching**: Query-based caching with 5-minute TTL

#### Code Interpreter Tool
- **Runtime**: Python 3.9+ in isolated sandbox
- **Models**: GPT-5, GPT-4o, Gemini Pro
- **Libraries**: NumPy, Pandas, Matplotlib, SciPy, Scikit-learn
- **Execution**: Stateless containers with 30-second timeout
- **Security**: No file system access, no network access

### Tool Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│                 │     │                  │     │                 │
│  Assistant      │────▶│  Tool Registry   │────▶│  Model Capability│
│  Architect UI   │     │  & Validation    │     │     Matrix      │
│                 │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
          │                        │
          ▼                        ▼
┌─────────────────┐     ┌──────────────────┐
│                 │     │                  │
│  Prompt Chain   │────▶│  Tool Execution  │
│  Configuration  │     │     Lambda       │
│                 │     │                  │
└─────────────────┘     └──────────────────┘
                                   │
                        ┌──────────┴──────────┐
                        ▼                     ▼
              ┌──────────────┐      ┌──────────────┐
              │              │      │              │
              │  Web Search  │      │Code Interpreter│
              │   Service    │      │   Runtime    │
              │              │      │              │
              └──────────────┘      └──────────────┘
```

### Tool Selection Flow

1. **Model Compatibility Check**
   ```typescript
   interface ModelToolMatrix {
     [modelId: string]: {
       supportedTools: ToolType[]
       limitations: string[]
       performance: PerformanceMetrics
     }
   }
   ```

2. **Tool Registry Lookup**
   ```typescript
   async function getAvailableToolsForModel(modelId: string): Promise<Tool[]> {
     // Check model capabilities in ai_models table
     // Return intersection of model support and enabled tools
     // Apply user permission filtering
   }
   ```

3. **Validation Pipeline**
   - Model compatibility verification
   - User permission checks
   - Tool configuration validation
   - Security constraint enforcement

### Execution Pipeline

#### 1. Tool Selection & Validation
```typescript
interface ToolExecution {
  id: string
  assistantArchitectId: number
  promptId: string
  enabledTools: string[]
  status: 'pending' | 'running' | 'completed' | 'failed'
  results: ToolResult[]
}
```

#### 2. Parallel Execution Engine
- **Queue**: AWS SQS for reliable task distribution
- **Workers**: Lambda functions with model-specific configurations
- **Coordination**: Step Functions for complex workflows
- **Monitoring**: CloudWatch metrics and distributed tracing

#### 3. Result Integration
```typescript
interface ToolResult {
  toolType: 'web_search' | 'code_interpreter'
  status: 'success' | 'error' | 'timeout'
  output: string
  metadata: {
    executionTime: number
    resourceUsage: ResourceMetrics
    cacheHit?: boolean
  }
  error?: {
    code: string
    message: string
    details: unknown
  }
}
```

### Database Schema Extensions

#### Tool Configuration
```sql
-- SECURITY NOTE: The following SQL examples are for documentation purposes only.
-- In production code, ALWAYS use Drizzle ORM type-safe queries
-- through executeQuery/executeTransaction to prevent SQL injection attacks.

-- Enhanced chain_prompts table
ALTER TABLE chain_prompts ADD COLUMN enabled_tools JSONB DEFAULT '[]';
ALTER TABLE chain_prompts ADD COLUMN tool_settings JSONB DEFAULT '{}';

-- Tool execution tracking
CREATE TABLE tool_executions (
  id SERIAL PRIMARY KEY,
  assistant_architect_id INTEGER REFERENCES assistant_architects(id),
  user_id INTEGER REFERENCES users(id),
  status VARCHAR(20) NOT NULL,
  input_data JSONB NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT
);

-- Tool result storage
CREATE TABLE tool_results (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER REFERENCES tool_executions(id),
  tool_type VARCHAR(50) NOT NULL,
  output_data TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### Model Capabilities
```sql
-- SECURITY NOTE: The following SQL examples are for documentation purposes only.
-- In production code, ALWAYS use Drizzle ORM type-safe queries
-- through executeQuery/executeTransaction to prevent SQL injection attacks.

-- Enhanced ai_models table
ALTER TABLE ai_models ADD COLUMN capabilities JSONB DEFAULT '{}';

-- Example capabilities structure (use parameterized queries in actual implementation)
UPDATE ai_models SET capabilities = '{
  "tools": ["web_search", "code_interpreter"],
  "maxToolCalls": 5,
  "parallelExecution": true,
  "timeoutSeconds": 30
}' WHERE model_id = 'gpt-5';
```

### Security & Compliance

#### Tool Execution Security

##### Container Security & Isolation
- **Runtime**: AWS Lambda with isolated execution contexts
- **Container Features**:
  - Read-only root filesystem
  - Non-root user execution (UID 1000)
  - No privileged access or capabilities
  - Isolated process namespace (PID isolation)
  - Restricted file system access (no /tmp persistence)
- **Security Context**:
  ```yaml
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    readOnlyRootFilesystem: true
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
  ```

##### Network Isolation
- **Code Interpreter**: Complete network isolation - no outbound internet access
- **Web Search Tool**: Restricted to approved domains only via allowlist
- **DNS Resolution**: Limited to AWS internal DNS for security
- **Firewall Rules**:
  - Block all outbound traffic except HTTPS to approved endpoints
  - No inbound network access permitted
  - VPC security groups with explicit deny-all default

##### Resource Limits & Controls
- **Memory Limits**:
  - Code Interpreter: 512MB maximum (configurable per model)
  - Web Search: 256MB maximum
  - Hard limits enforced at container level
- **CPU Limits**:
  - Code Interpreter: 0.5 vCPU maximum with burst capability
  - Web Search: 0.25 vCPU maximum
  - Timeout enforcement: 30 seconds hard limit
- **Disk I/O**:
  - Ephemeral storage only (no persistent volumes)
  - 512MB maximum temporary space
  - Automatic cleanup after execution

##### Input Validation & Attack Prevention
- **Dangerous Input Patterns Blocked**:
  ```typescript
  // Command injection patterns
  /[;&|`$(){}[\]\\]/g          // Shell metacharacters
  /\b(eval|exec|system)\b/gi   // Dangerous functions
  /import\s+os|subprocess/gi   // System module imports
  /__import__|getattr/gi       // Dynamic imports

  // Path traversal patterns
  /\.\.[\/\\]/g                // Directory traversal
  /\/etc\/|\/proc\/|\/dev\//gi // System directories

  // Network access patterns
  /socket|urllib|requests/gi   // Network libraries
  /http[s]?:\/\//gi           // URL patterns
  ```

- **Code Execution Restrictions**:
  - No file system write access outside `/tmp`
  - Blocked system calls: `socket`, `fork`, `exec`
  - Import restrictions: `os`, `subprocess`, `socket`, `urllib`
  - Memory allocation limits to prevent resource exhaustion

- **Input Sanitization**:
  - Maximum input size: 100KB for code, 10KB for search queries
  - UTF-8 encoding validation
  - SQL injection pattern detection
  - XSS pattern filtering for all outputs

##### Monitoring & Detection
- **Real-time Monitoring**:
  - Resource usage tracking (CPU, memory, disk)
  - Network connection attempts (blocked and logged)
  - Suspicious pattern detection in code execution
  - Failed execution attempt analysis

- **Security Alerting**:
  - Immediate alerts for blocked dangerous patterns
  - Resource limit violations
  - Repeated security violations by user
  - Anomalous execution patterns

- **Audit Logging**:
  - All tool execution inputs and outputs
  - Security violation attempts with user context
  - Resource usage metrics for capacity planning
  - Performance metrics for optimization

#### Data Privacy
- **Temporary Storage**: Tool results stored with automatic cleanup
- **Encryption**: All tool data encrypted in transit and at rest
- **Audit Logging**: Comprehensive logging of tool usage and access
- **Data Residency**: Configurable data processing regions

### Performance Optimization

#### Caching Strategy
```typescript
interface ToolCache {
  webSearch: {
    keyPattern: string // hash of query + parameters
    ttl: number        // 5 minutes for search results
    maxSize: number    // 1000 entries per instance
  }
  codeExecution: {
    keyPattern: string // hash of code + inputs
    ttl: number        // 1 hour for deterministic code
    maxSize: number    // 100 entries per instance
  }
}
```

#### Resource Management
- **Concurrent Execution**: Max 10 tools per user simultaneously
- **Memory Allocation**: Dynamic scaling based on tool complexity
- **CPU Throttling**: Intelligent resource allocation
- **Timeout Handling**: Graceful degradation with partial results

### Monitoring & Metrics

#### Key Performance Indicators
```typescript
interface ToolMetrics {
  executionTime: {
    p50: number    // Target: <15s
    p95: number    // Target: <30s
    p99: number    // Target: <45s
  }
  successRate: number    // Target: >95%
  errorRate: {
    timeout: number      // Target: <2%
    validation: number   // Target: <1%
    system: number       // Target: <1%
  }
  resourceUtilization: {
    memory: number
    cpu: number
    network: number
  }
}
```

#### CloudWatch Integration
- Custom metrics for tool execution performance
- Automated alerting for failure rate thresholds
- Dashboard with real-time tool usage statistics
- Log aggregation for debugging and optimization

### Error Handling & Recovery

#### Failure Modes
1. **Tool Timeout**: Graceful degradation with partial results
2. **API Rate Limiting**: Exponential backoff with queue management
3. **Resource Exhaustion**: Load balancing and capacity scaling
4. **Validation Failures**: Clear error messages and retry options

#### Recovery Strategies
```typescript
interface RecoveryPolicy {
  retryAttempts: number        // Max 3 attempts
  backoffStrategy: 'exponential' | 'linear'
  fallbackOptions: string[]   // Alternative tools or cached results
  userNotification: boolean   // Inform user of degraded service
}
```

## Streaming Architecture Evolution

The AI Studio streaming infrastructure has evolved through two major architectural migrations to optimize performance, cost, and user experience.

### Phase 1: Amplify to ECS Fargate (ADR-002)

**Timeline**: January 2025
**Problem**: AWS Amplify does not support HTTP streaming, causing buffered responses and poor UX
**Solution**: Migrated to ECS Fargate with Application Load Balancer

**Key Changes**:
- Enabled HTTP/2 streaming via ECS Fargate containers
- Eliminated 30-second Amplify timeout limitation
- Achieved real-time AI response streaming
- Reduced time-to-first-token from 2-5 seconds to <1 second

**Impact**:
- ✅ Real-time streaming responses (like ChatGPT/Claude)
- ✅ No timeout limits for long-running AI models
- ✅ Professional user experience
- ✅ Full control over containerized deployment

**See**: [ADR-002: Streaming Architecture Migration](./architecture/ADR-002-streaming-architecture-migration.md)

### Phase 2: Lambda Workers to Direct ECS (ADR-003)

**Timeline**: October 2025 (PR #340)
**Problem**: Redundant Lambda + SQS polling architecture adding latency and cost
**Solution**: Direct ECS execution for all AI streaming

**Key Changes**:
- Removed streaming Lambda workers and SQS queues
- Direct ECS execution via HTTP/2 streaming
- Simplified architecture (fewer moving parts)
- Eliminated 1-5 second SQS polling delay

**Cost Savings**:
- Lambda streaming workers: -$20-30/month
- SQS requests: -$5-10/month
- **Total savings: ~$35-40/month (~40% reduction)**

**Performance Improvements**:
- 1-5 second latency reduction (no SQS polling)
- Eliminated Lambda cold starts for streaming
- Faster job execution start time
- More consistent response times

**Architecture Simplification**:
- Single execution path (ECS only)
- Fewer infrastructure components to maintain
- Unified monitoring and logging
- Easier debugging and troubleshooting

**Components Retained**:
- SQS + Lambda for background processing:
  - Document processing (`file-processor`)
  - Textract processing (`textract-processor`)
  - URL processing (`url-processor`)
  - Embedding generation (`embedding-generator`)
- These remain appropriate for asynchronous, non-streaming tasks

**See**: [ADR-003: ECS Streaming Migration](./architecture/ADR-003-ecs-streaming-migration.md)

### Current Streaming Architecture

```
┌──────────────┐
│   Client     │
└──────┬───────┘
       │ HTTP/2 Streaming
       ▼
┌──────────────┐
│ CloudFront   │ (Optional CDN)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│     ALB      │ ← Chunked Transfer Encoding
└──────┬───────┘ ← Server-Sent Events (SSE)
       │
       ▼
┌──────────────┐
│ ECS Fargate  │ ← Real-time AI streaming
│  (Next.js)   │ ← No timeout limits
└──────┬───────┘
       │
       ├─────────────┐
       ▼             ▼
┌──────────┐  ┌─────────────┐
│  Aurora  │  │   Lambda    │
│ServerlessV2│ │  Workers    │
│          │  │ (Background)│
└──────────┘  └─────────────┘
```

**Features**:
- **Nexus Chat**: Real-time streaming conversations
- **Model Compare**: Side-by-side model comparison with streaming
- **Assistant Architect**: Multi-prompt tool execution
- **All Features**: Unlimited response times, progressive rendering

**Benefits Summary**:
| Metric | Before (Amplify + Lambda) | After (ECS Direct) | Improvement |
|--------|-------------------------|-------------------|-------------|
| **Time-to-first-token** | 2-5 seconds | <1 second | **75-90% faster** |
| **Streaming latency** | 1-5 seconds (polling) | Real-time (<100ms) | **Instant** |
| **Monthly cost** | ~$100-140 | ~$60-100 | **~$40 savings** |
| **Infrastructure components** | 8 services | 4 services | **50% reduction** |
| **Timeout limit** | 30 seconds (Amplify) | None (ECS) | **Unlimited** |

**Migration Impact**:
- Zero user-facing changes (seamless migration)
- Better performance and lower costs
- Simpler architecture for maintenance
- All features continue to work as expected

## Integration Platform

### API v1
REST API for external integrations, providing programmatic access to assistants, decisions, and chat. Authenticated via API key (`sk-` prefix), OAuth JWT, or session cookie. Rate-limited at 60 requests/minute by default.

- **OpenAPI spec**: `docs/API/v1/openapi.yaml`
- **Base path**: `/api/v1/`
- **Auth**: Bearer token (API key or OAuth access token)

### OAuth2/OIDC Provider
JWT-based authorization for external applications using Authorization Code Flow with PKCE.

- **Endpoints**: `/api/oauth/authorize`, `/api/oauth/token`, `/api/oauth/userinfo`
- **Token lifetimes**: Access (15min), Refresh (24hr), ID token (15min)
- **Scopes**: `openid`, `profile`, `email`, `mcp:read`, `mcp:write`, `api:read`, `api:write`
- **Admin UI**: `/admin/oauth-clients` for client registration

### MCP Server
Model Context Protocol server exposing AI Studio capabilities as tools for external AI agents.

- **Tools**: search_decisions, capture_decision, list_assistants, execute_assistant, get_context
- **Transport**: HTTP with SSE streaming
- **Auth**: API key or OAuth access token

### Decision Framework
Structured decision capture and retrieval system for organizational knowledge management.

- **Capture**: Decisions with context, alternatives, criteria, and outcomes
- **Graph**: Relationship-based navigation between related decisions
- **Search**: Full-text and semantic search across decision history

### K-12 Content Safety (Guardrails)
Amazon Bedrock Guardrails integration for content filtering and PII protection.

- **Stack**: `GuardrailsStack` (Bedrock + DynamoDB + SNS)
- **Features**: Content filtering, topic blocking, PII tokenization, real-time alerts
- **Mode**: Detect-only by default to minimize false positives

## Future Enhancements

### Planned
- Multi-modal support (images, audio)
- WebSocket support for real-time collaboration
- Edge runtime optimization
- Distributed caching with Redis
- Horizontal scaling with container orchestration

## Development Guidelines

### Code Organization
```
/app         → Pages and API routes
/actions     → Server-side business logic
/components  → Reusable UI components
/lib         → Shared utilities and adapters
/types       → TypeScript definitions
/infra       → AWS CDK infrastructure
```

### Naming Conventions
- **Files**: kebab-case (`user-actions.ts`)
- **Components**: PascalCase matching filename
- **Server Actions**: camelCase with `Action` suffix
- **Database**: snake_case for tables/columns

### Quality Standards
- Zero TypeScript errors (`npm run typecheck`)
- Zero ESLint violations (`npm run lint`)
- Comprehensive logging (no console methods)
- E2E tests for new features
- 80% code coverage minimum

## References

- [Next.js Documentation](https://nextjs.org/docs)
- [AWS CDK Guide](https://docs.aws.amazon.com/cdk/latest/guide/)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)
- [Internal CLAUDE.md](../CLAUDE.md) - AI assistant guidelines