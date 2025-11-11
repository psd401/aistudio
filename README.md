# AIStudio - Enterprise Next.js Template

A modern, production-ready template for building internal enterprise applications with Next.js 14+, featuring:

- 🔒 Authentication with [AWS Cognito](https://aws.amazon.com/cognito/) + NextAuth v5
- 🗄️ Database with [AWS RDS Aurora Serverless v2](https://aws.amazon.com/rds/aurora/) (PostgreSQL)
- 🎨 UI with [Shadcn](https://ui.shadcn.com)
- 🚀 Deployment with [AWS Amplify](https://aws.amazon.com/amplify)
- 🏗️ Infrastructure as Code with [AWS CDK](https://aws.amazon.com/cdk/)

## AWS Architecture

This project provisions all core infrastructure using AWS CDK, following the AWS Well-Architected Framework and best practices for cost tracking and security:

- **Networking:** Isolated VPC with public and private subnets
- **Database:** Aurora Serverless v2 PostgreSQL with RDS Data API and Secrets Manager
- **Authentication:** Amazon Cognito with Google federated login + NextAuth v5
- **Storage:** Private S3 bucket for document storage (SSE, versioning, lifecycle)
- **Frontend Hosting:** AWS Amplify with SSR support (WEB_COMPUTE platform)
- **Tagging:** All resources are tagged for cost allocation (Environment, Project, Owner)

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

- Node.js 18+ and npm
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

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

4. Set up your local database (if using local PostgreSQL):
   ```bash
   npm run db:generate
   npm run db:push
   ```

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

The project uses AWS RDS Data API for new features and migrations. Legacy code may still use Drizzle ORM.

- Generate migrations: `npm run db:generate`
- Push schema changes: `npm run db:push`
- Open Drizzle Studio: `npm run db:studio`

For production, all database operations go through the RDS Data API using the `executeSQL` function from `/lib/db/data-api-adapter.ts`.

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
2. Bootstrap CDK in your AWS account
3. Deploy the infrastructure stacks
4. Configure environment variables in AWS Amplify Console
5. Push code to trigger Amplify deployment

See `docs/DEPLOYMENT.md` for full deployment instructions and `docs/OPERATIONS.md` for operational best practices.

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

- [Deployment Guide](./docs/DEPLOYMENT.md) - Detailed deployment instructions
- [Operations Guide](./docs/OPERATIONS.md) - Operational procedures
- [Developer Guide](./DEVELOPER_GUIDE.md) - Development setup and workflow
- [Environment Variables](./docs/ENVIRONMENT_VARIABLES.md) - Required environment variables
- [Technical Specification](./docs/SPECIFICATION.md) - Architecture and design
- [Navigation System](./docs/navigation.md) - Dynamic navigation documentation
- [AI Features](./docs/AI_IMPROVEMENTS.md) - AI capabilities and improvements
- [S3 Uploads](./docs/project-plan-s3-large-uploads.md) - Large file upload implementation
- [CLAUDE.md](./CLAUDE.md) - Development guidelines for AI assistants

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT