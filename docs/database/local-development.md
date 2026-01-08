# Local Development Environment

Issue #607 - Overhaul Local Development Environment

This guide explains how to set up and use the local development environment with PostgreSQL.

## Quick Start

```bash
# Start local PostgreSQL
npm run db:up

# Create test users (admin, staff, student)
npm run db:seed

# Start Next.js with local database
npm run dev:local
```

## Prerequisites

- Docker Desktop (or compatible Docker runtime)
- Node.js 22+
- npm or bun

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run db:up` | Start PostgreSQL container |
| `npm run db:down` | Stop PostgreSQL container |
| `npm run db:reset` | Reset database (destroys all data, re-runs migrations) |
| `npm run db:logs` | View PostgreSQL container logs |
| `npm run db:seed` | Create test users |
| `npm run db:studio` | Open Drizzle Studio to inspect database |
| `npm run db:psql` | Connect to database via psql CLI |
| `npm run db:migrate` | Run pending migrations |
| `npm run dev:local` | Start Next.js with local database |
| `npm run dev:docker` | Start full app + database in Docker |

## Environment Variables

Create a `.env.local` file with the following for local development:

```bash
# Database - Local PostgreSQL
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aistudio
DB_SSL=false

# Authentication (use AWS Cognito dev pool)
AUTH_URL=http://localhost:3000
AUTH_SECRET=your-local-secret-here
AUTH_COGNITO_CLIENT_ID=your-cognito-client-id
AUTH_COGNITO_ISSUER=https://cognito-idp.us-west-2.amazonaws.com/your-pool-id
NEXT_PUBLIC_COGNITO_USER_POOL_ID=your-pool-id
NEXT_PUBLIC_COGNITO_CLIENT_ID=your-cognito-client-id
NEXT_PUBLIC_COGNITO_DOMAIN=your-domain.auth.us-west-2.amazoncognito.com
NEXT_PUBLIC_AWS_REGION=us-west-2

# AI Providers (optional)
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
```

## Test Users

After running `npm run db:seed`, the following test accounts are created:

| Email | Role | Access Level |
|-------|------|--------------|
| test@example.com | administrator | Full access |
| staff@example.com | staff | Staff tools |
| student@example.com | student | Basic access |

Note: These users require Cognito authentication in the actual app. For local testing without Cognito, you may need to mock the authentication layer.

## Database Architecture

### Local vs AWS

| Environment | Database | SSL | Migration Method |
|-------------|----------|-----|------------------|
| Local Docker | PostgreSQL 16 Alpine | disabled | init-local.sh (auto on first start) |
| AWS Dev | Aurora Serverless v2 | required | Lambda (CDK deploy) |
| AWS Prod | Aurora Serverless v2 | required | Lambda (CDK deploy) |

### Migration Workflow

1. **Make schema changes** in `lib/db/schema/*.ts`

2. **Test locally** with push:
   ```bash
   npm run db:up
   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false npm run drizzle:push
   ```

3. **Generate migration** for AWS:
   ```bash
   npm run drizzle:generate
   npm run migration:prepare -- "description"
   ```

4. **Add to Lambda** in `infra/database/lambda/db-init-handler.ts`:
   ```typescript
   const MIGRATION_FILES = [
     // ... existing migrations
     '049-your-new-migration.sql'  // Add your migration
   ];
   ```

5. **Deploy to AWS**:
   ```bash
   cd infra && npx cdk deploy AIStudio-DatabaseStack-Dev
   ```

## Docker Compose Services

### PostgreSQL (postgres)

- **Image**: postgres:16-alpine
- **Port**: 5432
- **Credentials**: postgres/postgres
- **Database**: aistudio
- **Volume**: postgres_data (persistent)

### Next.js App (app) - Optional

- **Port**: 3000
- **Hot reload**: Enabled via volume mounts
- **Environment**: Development mode

## Troubleshooting

### "Connection refused" when starting dev:local

Ensure PostgreSQL is running:
```bash
npm run db:up
docker ps  # Should show aistudio-postgres
```

### Database schema mismatch

Reset and re-run migrations:
```bash
npm run db:reset
npm run db:seed
```

### Migrations failed during init

Check the logs:
```bash
npm run db:logs
```

Common issues:
- Migration file not found: Ensure file exists in `infra/database/schema/`
- Syntax error: Check the SQL file for errors

### "SSL required" error

Ensure `DB_SSL=false` is set in your environment:
```bash
export DB_SSL=false
npm run dev:local
```

## Data Sync from AWS (Advanced)

For syncing reference data (models, tools) from AWS dev:

```bash
# Set AWS credentials
export AWS_DEV_DB_HOST=your-aurora-cluster.rds.amazonaws.com
export AWS_DEV_DB_USER=your_user
export AWS_DEV_DB_PASSWORD=your_password

npm run db:sync-dev
```

Note: User data is NOT synced for privacy. Use `npm run db:seed` for test users.

## Related Documentation

- [Drizzle Migration Guide](/docs/database/drizzle-migration-guide.md)
- [Drizzle Patterns](/docs/database/drizzle-patterns.md)
- [Database Architecture](/docs/ARCHITECTURE.md#database)
