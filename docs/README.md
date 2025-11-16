# AI Studio Documentation

Welcome to the AI Studio documentation. This guide provides comprehensive information for developers, operators, and administrators.

## 📚 Documentation Structure

### Core Documentation

#### [ARCHITECTURE.md](./ARCHITECTURE.md)
Complete system architecture including technology stack, design patterns, database schema, and security model.

#### [DEPLOYMENT.md](./DEPLOYMENT.md)
Step-by-step deployment guide for AWS infrastructure using CDK, including Google OAuth setup and first administrator configuration.

#### [API_REFERENCE.md](./API_REFERENCE.md) ⭐ **NEW**
Complete API documentation for REST endpoints and server actions with request/response examples.

#### [ERROR_REFERENCE.md](./ERROR_REFERENCE.md) ⭐ **NEW**
Error codes, handling patterns, and debugging workflow.

#### [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) ⭐ **NEW**
Common issues and solutions for development, deployment, and production.

#### [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)
Complete reference of all environment variables required for development and production environments.

### Visual Architecture Diagrams ⭐ **NEW**

#### [diagrams/README.md](./diagrams/README.md)
**Index of all architectural diagrams** (9 comprehensive Mermaid.js diagrams with 10,000+ lines of documentation):

##### Infrastructure Diagrams
- **[01. CDK Stack Dependencies](./diagrams/01-cdk-stack-dependencies.md)** - Deployment order and SSM parameter flows
- **[02. VPC Network Topology](./diagrams/02-vpc-network-topology.md)** - Multi-AZ subnets, security groups, and VPC endpoints
- **[03. AWS Service Architecture](./diagrams/03-aws-service-architecture.md)** - Complete service breakdown with cost analysis

##### Application Diagrams
- **[04. Database ERD](./diagrams/04-database-erd.md)** - All 54 PostgreSQL tables with relationships
- **[05. Authentication Flow](./diagrams/05-authentication-flow.md)** - OAuth 2.0 via Cognito + NextAuth v5
- **[06. Request Flow Diagrams](./diagrams/06-request-flow-diagrams.md)** - Nexus Chat, Model Compare, Document Processing

##### Feature-Specific Diagrams
- **[07. Assistant Architect Execution](./diagrams/07-assistant-architect-execution.md)** - Multi-prompt chains with variable substitution
- **[08. Document Processing Pipeline](./diagrams/08-document-processing-pipeline.md)** - Upload → S3 → Lambda → Textract → Embedding → pgvector
- **[09. Streaming Architecture](./diagrams/09-streaming-architecture.md)** - SSE via ECS Fargate with circuit breaker pattern

### Development Guides

#### [guides/LOGGING.md](./guides/LOGGING.md)
Comprehensive logging patterns with examples for server actions, API routes, and error handling.

#### [guides/TESTING.md](./guides/TESTING.md)
Testing strategies including unit tests, integration tests, and E2E testing with Playwright.

#### [guides/TYPESCRIPT.md](./guides/TYPESCRIPT.md)
TypeScript best practices, conventions, and guidelines for maintaining type safety.

#### [guides/adding-ai-providers.md](./guides/adding-ai-providers.md)
Step-by-step provider integration guide for adding new AI providers.

#### [guides/secrets-management-quickstart.md](./guides/secrets-management-quickstart.md)
AWS Secrets Manager integration and best practices.

### Library Documentation ⭐ **NEW**

#### [/lib/README.md](../lib/README.md)
Overview of library directory structure and common utilities.

#### [/lib/db/README.md](../lib/db/README.md)
Database access layer using RDS Data API with field transformation patterns.

#### [/lib/streaming/README.md](../lib/streaming/README.md)
Unified streaming service, provider adapters, and circuit breaker implementation.

### Infrastructure Documentation

#### [/infra/README.md](../infra/README.md) ⭐ **UPDATED**
Complete CDK infrastructure guide with deployment commands, environment configuration, and best practices.

#### [infrastructure/VPC-CONSOLIDATION.md](./infrastructure/VPC-CONSOLIDATION.md)
VPC consolidation and network architecture optimization.

#### [infrastructure/AURORA_COST_OPTIMIZATION.md](./infrastructure/AURORA_COST_OPTIMIZATION.md)
Aurora Serverless v2 cost optimization and monitoring strategies.

#### [infrastructure/LAMBDA_OPTIMIZATION.md](./infrastructure/LAMBDA_OPTIMIZATION.md)
Lambda optimization framework with PowerTuning results (66% memory reduction).

#### [infrastructure/lambda-powertuning-results.md](./infrastructure/lambda-powertuning-results.md)
Detailed PowerTuning results for all Lambda functions.

#### [infrastructure/multi-arch-build.md](./infrastructure/multi-arch-build.md)
Multi-architecture Docker builds for ARM64/AMD64 support.

### Security

#### [security/USING_IAM_SECURITY.md](./security/USING_IAM_SECURITY.md) ⭐ **START HERE**
How to use the IAM security framework with examples and patterns.

#### [security/IAM_LEAST_PRIVILEGE.md](./security/IAM_LEAST_PRIVILEGE.md)
Comprehensive IAM security architecture with least privilege and tag-based access control.

#### [security/MIGRATION_GUIDE.md](./security/MIGRATION_GUIDE.md)
Step-by-step guide for migrating existing infrastructure to secure IAM constructs.

### Operations

#### [operations/OPERATIONS.md](./operations/OPERATIONS.md)
Operational procedures, monitoring, and maintenance guidelines.

#### [operations/PERFORMANCE_TESTING.md](./operations/PERFORMANCE_TESTING.md)
Load testing and performance benchmarking procedures.

#### [operations/streaming-infrastructure.md](./operations/streaming-infrastructure.md)
ECS streaming infrastructure operations and monitoring.

#### [operations/production-migration-checklist.md](./operations/production-migration-checklist.md)
Comprehensive checklist for deploying to production.

#### [operations/tool-management.md](./operations/tool-management.md)
Managing Assistant Architect tools and permissions.

### API Documentation

#### [API/AI_SDK_PATTERNS.md](./API/AI_SDK_PATTERNS.md)
AI integration patterns using Vercel AI SDK v5, provider factory implementation, and streaming techniques.

### Feature Documentation

#### [features/navigation.md](./features/navigation.md)
Dynamic navigation system with role-based menu items.

#### [features/file-upload-architecture.md](./features/file-upload-architecture.md)
Document upload and processing system with S3 integration.

#### [features/EMBEDDING_SYSTEM.md](./features/EMBEDDING_SYSTEM.md)
Vector embedding and semantic search with pgvector.

#### [features/assistant-architect-sse-events.md](./features/assistant-architect-sse-events.md)
Server-Sent Events for Assistant Architect execution.

#### [features/assistant-architect-tools.md](./features/assistant-architect-tools.md)
Tool integration for Assistant Architect prompts.

#### [features/DOCUMENT_PROCESSING_SETUP.md](./features/DOCUMENT_PROCESSING_SETUP.md)
Document processing infrastructure setup.

#### [features/DOCUMENT_PROCESSING_TESTING_STRATEGY.md](./features/DOCUMENT_PROCESSING_TESTING_STRATEGY.md)
Testing strategy for document processing pipeline.

#### [features/polling-api-integration.md](./features/polling-api-integration.md)
Client integration patterns for polling APIs.

#### [features/s3-storage-optimization.md](./features/s3-storage-optimization.md)
S3 lifecycle policies and cost optimization.

## 🚀 Quick Start

### For New Developers
1. Start with [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the system
2. Review [diagrams/README.md](./diagrams/README.md) for visual architecture
3. Check [/infra/README.md](../infra/README.md) for infrastructure details
4. Review [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) for setup
5. Follow [guides/TYPESCRIPT.md](./guides/TYPESCRIPT.md) for code standards
6. Reference [guides/LOGGING.md](./guides/LOGGING.md) for logging patterns

### For DevOps/Infrastructure
1. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for initial deployment
2. Study [/infra/README.md](../infra/README.md) for CDK stack details
3. Review [diagrams/01-cdk-stack-dependencies.md](./diagrams/01-cdk-stack-dependencies.md) for deployment order
4. Check [operations/OPERATIONS.md](./operations/OPERATIONS.md) for maintenance
5. Use [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues

### For Testing
1. Read [guides/TESTING.md](./guides/TESTING.md) for testing strategies
2. Use Playwright MCP for E2E testing during development
3. Add tests to `working-tests.spec.ts` for CI/CD

## 📖 Key Concepts

### ActionState Pattern
All server actions return a consistent response structure. See [ARCHITECTURE.md#actionstate-pattern](./ARCHITECTURE.md#actionstate-pattern) and [API_REFERENCE.md#server-actions](./API_REFERENCE.md#server-actions).

### Provider Factory
Unified interface for multiple AI providers. See [API/AI_SDK_PATTERNS.md](./API/AI_SDK_PATTERNS.md#provider-factory-pattern) and [/lib/streaming/README.md](../lib/streaming/README.md#provider-adapters).

### Request Tracing
Every operation gets a unique request ID for end-to-end tracing. See [guides/LOGGING.md](./guides/LOGGING.md#request-tracing) and [ERROR_REFERENCE.md#debugging-workflow](./ERROR_REFERENCE.md#debugging-workflow).

### Settings Management
Database-first configuration with environment fallback. See [ARCHITECTURE.md#settings-management](./ARCHITECTURE.md#settings-management).

### ECS Streaming Architecture
Direct ECS execution for real-time AI streaming with HTTP/2 support. See [diagrams/09-streaming-architecture.md](./diagrams/09-streaming-architecture.md) and [/lib/streaming/README.md](../lib/streaming/README.md).

### Database Access
RDS Data API with field transformation (snake_case ↔ camelCase). See [/lib/db/README.md](../lib/db/README.md) and [diagrams/04-database-erd.md](./diagrams/04-database-erd.md).

## 🔧 Common Tasks

### Adding a New Feature
1. Design the database schema (see [diagrams/04-database-erd.md](./diagrams/04-database-erd.md))
2. Create server actions with proper logging (see [guides/LOGGING.md](./guides/LOGGING.md))
3. Build UI components
4. Add E2E tests (see [guides/TESTING.md](./guides/TESTING.md))
5. Update documentation

### Adding a New AI Provider
1. Follow [guides/adding-ai-providers.md](./guides/adding-ai-providers.md)
2. Create provider adapter in [/lib/streaming/provider-adapters/](../lib/streaming/provider-adapters/)
3. Add to database models and configuration
4. Test with real API and update monitoring
5. Deploy and verify in staging environment

### Debugging Production Issues
1. Use request ID to trace through CloudWatch logs
2. Check [ERROR_REFERENCE.md](./ERROR_REFERENCE.md) for error codes
3. Review [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues
4. Follow [operations/OPERATIONS.md](./operations/OPERATIONS.md) for procedures

### Deploying Updates
1. Test locally with `npm run dev`
2. Run `npm run lint` and `npm run typecheck` (entire codebase)
3. Deploy with CDK: `npx cdk deploy`
4. Monitor CloudWatch for errors
5. See [/infra/README.md](../infra/README.md) for detailed deployment commands

## 🔗 External Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [AWS CDK Guide](https://docs.aws.amazon.com/cdk/latest/guide/)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)
- [Playwright Documentation](https://playwright.dev)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

## 📝 Documentation Standards

### When to Update Documentation
- **Always** when adding new features
- **Always** when changing architecture
- **Always** when modifying deployment process
- When fixing complex bugs (document the solution)
- When discovering non-obvious patterns

### Documentation Guidelines
1. Keep documentation close to code
2. Use clear, concise language
3. Include code examples (tested and working)
4. Include visual diagrams where helpful
5. Update this README index
6. Cross-reference related documents

### File Organization
- Current, active documentation in main folders
- Diagrams in `/docs/diagrams/` (Mermaid.js format)
- Feature docs in `/docs/features/`
- Operations docs in `/docs/operations/`
- Infrastructure docs in `/docs/infrastructure/`
- Guides in `/docs/guides/`

## 🤝 Contributing

When contributing to documentation:
1. Follow the existing structure
2. Use proper markdown formatting
3. Include practical, tested examples
4. Cross-reference related documents
5. Update this README index
6. Add diagrams where helpful (Mermaid.js preferred)

## 🏗️ Architecture Decision Records

Key architectural decisions documented:

- **[ADR-001: Authentication Optimization](./architecture/ADR-001-authentication-optimization.md)** - NextAuth v5 with Cognito integration
- **[ADR-002: Streaming Architecture Migration](./architecture/ADR-002-streaming-architecture-migration.md)** - Amplify to ECS Fargate migration
- **[ADR-003: ECS Streaming Migration](./architecture/ADR-003-ecs-streaming-migration.md)** - Lambda workers to direct ECS execution
- **[ADR-004: Docker Container Optimization](./architecture/ADR-004-docker-container-optimization.md)** - Multi-stage builds and layer caching
- **[ADR-006: Centralized Secrets Management](./architecture/adr/ADR-006-centralized-secrets-management.md)** - AWS Secrets Manager integration

---

**Last updated**: November 2025
**Status**: Active - comprehensive documentation with 9 architectural diagrams
**Total Documentation**: 10,000+ lines across 50+ files
*For AI assistant guidelines, see [CLAUDE.md](../CLAUDE.md)*
