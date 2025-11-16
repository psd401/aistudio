# AIStudio - Enterprise Next.js Template

A modern, production-ready template for building internal enterprise applications with Next.js 14+, featuring:

- 🔒 Authentication with [AWS Cognito](https://aws.amazon.com/cognito/) + NextAuth v5
- 🗄️ Database with [AWS RDS Aurora Serverless v2](https://aws.amazon.com/rds/aurora/) (PostgreSQL)
- 🎨 UI with [Shadcn](https://ui.shadcn.com)
- 🚀 Deployment with [AWS ECS Fargate](https://aws.amazon.com/fargate/) + Application Load Balancer
- 🏗️ Infrastructure as Code with [AWS CDK](https://aws.amazon.com/cdk/)

## AWS Architecture

This project provisions all core infrastructure using AWS CDK, following the AWS Well-Architected Framework and best practices for cost tracking and security:

- **Networking:** Shared VPC with public, private, and isolated subnets + VPC endpoints
- **Database:** Aurora Serverless v2 PostgreSQL with RDS Data API and Secrets Manager
- **Authentication:** Amazon Cognito with Google federated login + NextAuth v5
- **Storage:** Private S3 bucket for document storage (SSE, versioning, lifecycle)
- **Frontend Hosting:** ECS Fargate containers with Application Load Balancer and auto-scaling
- **Monitoring:** CloudWatch dashboards with ADOT (AWS Distro for OpenTelemetry)
- **Tagging:** All resources tagged for cost allocation (Environment, Project, Owner, ManagedBy)

## Features

- Role-based access control with tool-specific permissions
- Automatic user creation on first sign-in
- Modern, responsive UI with dark mode support
- Type-safe database operations with RDS Data API
- AI-powered chat and utilities
- Document management with S3 integration
- Knowledge repository with embedding generation and vector search
- Asynchronous file processing with text extraction and chunking
- Test-driven development setup

## Getting Started

### Prerequisites

- Node.js 20.x and npm
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Docker installed (for building container images)

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/psd401/aistudio.git
   cd aistudio
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env.local` and fill in your environment variables:
   ```bash
   cp .env.example .env.local
   ```

4. **Note on Database Setup**:
   - The project uses AWS RDS Data API (no local database needed for development)
   - Configure `.env.local` with your AWS RDS cluster ARN and secret ARN
   - See `/docs/DEPLOYMENT.md` for complete infrastructure setup

5. Run the development server:
   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Testing

Run the test suite:
```bash
npm test
```

Watch mode:
```bash
npm run test:watch
```

Run specific test file:
```bash
npm test -- path/to/test.test.ts
```

## Database Management

The project uses AWS RDS Data API for all database operations (no ORM).

- **Schema**: SQL migration files in `/infra/database/schema/`
- **Migrations**: Managed by Lambda function during CDK deployment
- **Development**: Use MCP tools for database queries:
  - `mcp__awslabs-postgres-mcp-server__get_table_schema` - Inspect tables
  - `mcp__awslabs-postgres-mcp-server__run_query` - Execute SQL

All database operations use the `executeSQL` function from `/lib/db/data-api-adapter.ts` with parameterized queries.

## Deployment

### Quick Deploy

```bash
cd infra
cdk deploy --all \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=your-dev-client-id \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=your-prod-client-id \
  --context baseDomain=yourdomain.com
```

### Detailed Steps

1. Create required AWS Secrets Manager secrets (see `DEPLOYMENT.md`)
2. Bootstrap CDK in your AWS account:
   ```bash
   cd infra
   npx cdk bootstrap aws://ACCOUNT-ID/REGION
   ```
3. Deploy the infrastructure stacks in order:
   ```bash
   npx cdk deploy AIStudio-DatabaseStack-Dev
   npx cdk deploy AIStudio-AuthStack-Dev
   npx cdk deploy AIStudio-StorageStack-Dev
   npx cdk deploy AIStudio-DocumentProcessingStack-Dev
   npx cdk deploy AIStudio-FrontendStack-Dev
   ```
4. Verify deployment via CloudWatch Logs and ECS task status
5. Access application at ALB DNS name or configured custom domain

See `docs/DEPLOYMENT.md` for full deployment instructions, `docs/OPERATIONS.md` for operational best practices, and `/infra/README.md` for CDK details.

## Project Structure

```
├── app/                  # Next.js App Router pages and layouts
├── components/          # UI components (Shadcn)
├── actions/            # Server actions for database operations
├── db/                 # Database schemas and configuration
├── lib/                # Utility functions and helpers
├── infra/              # AWS CDK infrastructure code
├── public/             # Static assets
└── docs/               # Documentation
```

## Key Documentation

### Core Documentation
- [Architecture Overview](./docs/ARCHITECTURE.md) - Complete system architecture
- [Deployment Guide](./docs/DEPLOYMENT.md) - Detailed deployment instructions
- [API Reference](./docs/API_REFERENCE.md) - REST endpoints and server actions
- [Error Reference](./docs/ERROR_REFERENCE.md) - Error codes and handling patterns
- [Troubleshooting Guide](./docs/TROUBLESHOOTING.md) - Common issues and solutions

### Infrastructure
- [CDK Infrastructure](./infra/README.md) - AWS CDK stack details
- [Database Management](./docs/DATABASE_MANAGEMENT.md) - PostgreSQL with RDS Data API
- [Environment Variables](./docs/ENVIRONMENT_VARIABLES.md) - Required configuration

### Architecture Diagrams
- [CDK Stack Dependencies](./docs/diagrams/01-cdk-stack-dependencies.md)
- [VPC Network Topology](./docs/diagrams/02-vpc-network-topology.md)
- [AWS Service Architecture](./docs/diagrams/03-aws-service-architecture.md)
- [Database ERD](./docs/diagrams/04-database-erd.md) - 54 tables with relationships
- [Authentication Flow](./docs/diagrams/05-authentication-flow.md)
- [Request Flow Diagrams](./docs/diagrams/06-request-flow-diagrams.md)
- [Assistant Architect Execution](./docs/diagrams/07-assistant-architect-execution.md)
- [Document Processing Pipeline](./docs/diagrams/08-document-processing-pipeline.md)
- [Streaming Architecture](./docs/diagrams/09-streaming-architecture.md)

### Development
- [Developer Guide](./DEVELOPER_GUIDE.md) - Development setup and workflow
- [CLAUDE.md](./CLAUDE.md) - Development guidelines for AI assistants
- [Library Documentation](./lib/README.md) - Core utilities and patterns
- [Operations Guide](./docs/OPERATIONS.md) - Operational procedures

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT