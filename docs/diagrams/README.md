# AI Studio - Architectural Diagrams

This directory contains comprehensive architectural diagrams for the AI Studio application infrastructure and application layers.

## Infrastructure Diagrams

### [01. CDK Stack Dependencies](./01-cdk-stack-dependencies.md)
**Deployment order and SSM parameter flows between AWS CDK stacks**

- Stack dependency graph showing deployment order
- SSM Parameter Store cross-stack references
- Independent vs sequential deployment patterns
- Troubleshooting stack deployment issues

**Use this when**: Planning infrastructure deployments, debugging stack dependencies

---

### [02. VPC Network Topology](./02-vpc-network-topology.md)
**Complete VPC architecture with subnets, security groups, and endpoints**

- Multi-AZ subnet design (public, private-application, private-data, isolated)
- Security group rules and traffic flow
- VPC endpoints for cost optimization
- Network performance metrics

**Use this when**: Understanding network architecture, troubleshooting connectivity, planning security changes

---

### [03. AWS Service Architecture](./03-aws-service-architecture.md)
**High-level view of all AWS services and their interactions**

- Complete service breakdown by category
- Data flow patterns for key features
- High availability configuration
- Cost breakdown and optimization strategies
- Monitoring dashboard overview

**Use this when**: Understanding overall system architecture, cost analysis, capacity planning

---

## Application Diagrams

### 04. Database ERD *(Coming Soon)*
**Entity-Relationship Diagram for all 30+ PostgreSQL tables**

- Core tables (users, roles, tools)
- AI & Chat tables (conversations, messages, token_usage)
- Knowledge management (repositories, documents, embeddings)
- Assistant Architect tables

---

### 05. Authentication Flow *(Coming Soon)*
**OAuth 2.0 authentication flow with Cognito and Google**

- User sign-in flow
- JWT token generation and validation
- Session management
- Role-based access control (RBAC)

---

### 06. Request Flow Diagrams *(Coming Soon)*
**End-to-end request flows for major features**

- Chat conversation flow
- Model comparison flow
- Document upload and processing
- Real-time streaming architecture

---

## Feature-Specific Diagrams

### 07. Assistant Architect Execution *(Coming Soon)*
**Multi-prompt chain execution with knowledge and tools**

- Prompt chain configuration
- Variable substitution flow
- Tool integration (web search, code interpreter)
- Result aggregation

---

### 08. Document Processing Pipeline *(Coming Soon)*
**Upload → S3 → Lambda → Textract → Embedding → PostgreSQL**

- Async processing flow
- Textract OCR integration
- Embedding generation
- Vector search with pgvector

---

### 09. Streaming Architecture *(Coming Soon)*
**Server-Sent Events (SSE) for real-time AI responses**

- HTTP/2 streaming via ECS Fargate
- ALB configuration for long-running connections
- Client-side streaming with `useChat` hook
- Error handling and reconnection logic

---

## Diagram Conventions

### Mermaid.js Diagrams
All diagrams use Mermaid.js for version control-friendly, text-based diagrams that render in GitHub and documentation tools.

**Color Coding**:
- 🔵 **Blue** (`fill:#e1f5ff`): Data/Storage services
- 🟢 **Green** (`fill:#c8e6c9`): Frontend/User-facing
- 🟡 **Yellow** (`fill:#fff9c4`): Backend/Processing
- 🔴 **Red** (`fill:#ffcccc`): Public/External
- 🟣 **Purple** (`fill:#d1c4e9`): Monitoring/Observability
- 🌸 **Pink** (`fill:#f8bbd0`): AI/ML services

### Diagram Sources
For complex diagrams that require draw.io:
- Source files: `/docs/diagrams/sources/`
- Export as PNG/SVG for embedding
- Keep `.drawio` files for future edits

## Contributing

When adding new diagrams:

1. **Naming**: Use sequential numbers (e.g., `10-new-diagram.md`)
2. **Format**: Markdown file with embedded Mermaid.js code blocks
3. **Metadata**: Include "Last Updated" date and related docs links
4. **README**: Update this index with description and use cases
5. **Cross-link**: Reference diagrams in relevant documentation files

## Related Documentation

- [Architecture Overview](/docs/ARCHITECTURE.md)
- [Deployment Guide](/docs/DEPLOYMENT.md)
- [Infrastructure Code](/infra/lib/)
- [ADR Documents](/docs/architecture/)

---

**Last Updated**: November 2025
**Total Diagrams**: 3 (of 10+ planned)
**Format**: Mermaid.js (text-based, version-controlled)
