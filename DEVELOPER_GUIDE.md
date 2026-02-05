# Developer Guide

This guide covers local development, coding standards, and testing for this project.

## Local Setup
1. Clone the repository:
   ```sh
   git clone git@github.com:psd401/aistudio.git
   cd aistudio
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
   **Important**: This project uses npm as its package manager. Do not use yarn, pnpm, or other package managers.
3. Copy and configure environment variables:
   ```sh
   cp .env.example .env.local
   # Edit .env.local with your local/test values
   ```
4. Start local PostgreSQL and dev server:
   ```sh
   npm run db:up              # Start PostgreSQL via Docker
   npm run db:seed            # Create test users (first time only)
   npm run dev:local          # Start Next.js with local database
   ```
   Test users after seeding:
   - `test@example.com` — administrator role
   - `staff@example.com` — staff role
   - `student@example.com` — student role

   Other useful database commands:
   ```sh
   npm run db:studio          # Open Drizzle Studio to inspect DB
   npm run db:psql            # Connect via psql
   npm run db:reset           # Reset database (destroys all data)
   ```

## Coding Standards
- All code must follow the rules in `CONTRIBUTING.md`.
- Use TypeScript for all code.
- Prefer interfaces over type aliases.
- Use kebab-case for files and folders.
- Use the `@` alias for imports.
- Use type-only imports: `import type { ... }` for types.
- Never expose secrets to the frontend.
- Update `.env.example` when adding/changing environment variables.

## Architecture Overview
This project follows a **Layered Architecture** pattern:

1. **Presentation Layer** (`/app`, `/components`)
   - React Server Components by default
   - Client components only when necessary (`"use client"`)
   - No business logic in components

2. **Application Layer** (`/actions`)
   - All business logic in server actions
   - Consistent `ActionState<T>` return pattern
   - Authorization checks via `hasToolAccess()`

3. **Infrastructure Layer** (`/lib`, `/infra`)
   - Database access via Drizzle ORM (`executeQuery`/`executeTransaction`)
   - External service integrations
   - AWS CDK infrastructure definitions

When adding new features:
- Start with server actions in `/actions`
- Keep UI components thin and focused on presentation
- Abstract infrastructure details behind functions in `/lib`

### Import Optimization
For better build performance, import specific components rather than entire libraries:
```typescript
// ✅ Good - specific import
import TriangleIcon from '@phosphor-icons/react/dist/csr/Triangle'

// ❌ Bad - imports entire library
import { TriangleIcon } from '@phosphor-icons/react'
```

## Configuration Management
- **Public config** (e.g., Google OAuth client IDs, frontend base domain) is provided as CloudFormation parameters at deploy time. Never hardcode or store these in Secrets Manager.
- **Secrets** (e.g., Google OAuth client secrets, GitHub tokens) are stored in AWS Secrets Manager and referenced in CDK using `SecretValue.secretsManager(...)`.
- This pattern ensures that public values are easily visible and configurable, while secrets remain secure and never exposed in code or CloudFormation outputs.

## Frontend Domain Pattern
- The base domain is provided as a parameter (e.g., `yourdomain.com`).
- The ECS Fargate service uses `dev.<domain>` for dev and the apex domain for prod.
- DNS is managed via Route 53 with A records pointing to the Application Load Balancer.

## Example: Passing Parameters
When deploying, pass the client IDs and base domain as parameters:
```sh
cdk deploy AuthStack-Dev --parameters AuthStack-Dev:GoogleClientId=your-dev-client-id
cdk deploy AuthStack-Prod --parameters AuthStack-Prod:GoogleClientId=your-prod-client-id
cdk deploy FrontendStack-Dev --parameters FrontendStack-Dev:BaseDomain=yourdomain.com
cdk deploy FrontendStack-Prod --parameters FrontendStack-Prod:BaseDomain=yourdomain.com
```

## Best Practices for Open Source CDK Projects
- **Never hardcode secrets or public config in code.**
- Use CloudFormation parameters for public config that may change per deployment (e.g., OAuth client IDs, callback URLs, base domain).
- Use AWS Secrets Manager for all sensitive values (e.g., client secrets, API keys).
- Document all required parameters and secrets in `docs/DEPLOYMENT.md`.
- Do not use environment variables for stack configuration—prefer parameters and secrets for reproducibility and security.

## Database Development

### Drizzle ORM Usage
All database operations use Drizzle ORM with the postgres.js driver:
```typescript
import { eq, and } from "drizzle-orm"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { users, userRoles } from "@/lib/db/schema"

// ✅ Correct - type-safe Drizzle query
const user = await executeQuery(
  (db) => db.select().from(users).where(eq(users.id, userId)).limit(1),
  "getUserById"
)

// ❌ Never use string concatenation or raw SQL for standard queries
```

### Transaction Management
For operations that modify multiple tables, use transactions:
```typescript
await executeTransaction(
  async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId))
    await tx.insert(userRoles).values(
      roleIds.map(id => ({ userId, roleId: id }))
    )
  },
  "updateUserRoles"
)
```

### Migrations
```bash
npm run drizzle:generate        # Generate from schema changes
npm run migration:prepare       # Format for Lambda deployment
npm run migration:list          # List all migrations
# Then add filename to MIGRATION_FILES array in db-init-handler.ts
```

## Server Actions Pattern
All server actions must follow the `ActionState<T>` pattern:
```typescript
export async function actionName(): Promise<ActionState<ReturnType>> {
  const session = await getServerSession()
  if (!session) return { isSuccess: false, message: "Unauthorized" }

  const hasAccess = await hasToolAccess(session.user.sub, "toolName")
  if (!hasAccess) return { isSuccess: false, message: "Access denied" }

  try {
    const result = await executeQuery(
      (db) => db.select().from(table).where(eq(table.id, id)),
      "actionName"
    )
    return { isSuccess: true, message: "Success", data: result }
  } catch (error) {
    return handleError(error, "Operation failed")
  }
}
```

## Testing
- Run all tests before submitting a PR:
  ```sh
  npm test
  npm run lint
  npm run typecheck  # Check TypeScript types
  ```
- Watch mode:
  ```sh
  npm run test:watch
  ```
- Add or update tests for new features and bug fixes.
- Include tests for:
  - Authentication flows
  - Protected routes
  - Server-side rendering
  - Error scenarios
- Do not break existing tests.
- Use `cdk synth` to validate templates before deploying
- Use `cdk diff` to preview changes
- Use AWS CloudFormation console to inspect deployed resources

## Pull Requests
- All PRs must pass CI (lint, build, and tests) before merge.
- All PRs must be reviewed and approved by at least one other contributor.
- Use the PR template and complete all checklist items.

## AWS/CDK Development
- Infrastructure code is in `/infra` and uses AWS CDK (TypeScript).
- See `docs/DEPLOYMENT.md` for deployment instructions.
- See `docs/OPERATIONS.md` for operational best practices.

### Security Best Practices
- **Security Groups**: Apply least-privilege principles. Never allow 0.0.0.0/0.
- **Encryption**: Enable encryption at rest for RDS, S3, and other data stores.
- **SSL/TLS**: Enforce SSL on S3 buckets with minimum TLS version 1.2.
- **IAM Policies**: Follow least-privilege. Enable `ConfirmPermissionsBroadening` in pipelines.
- **Secrets**: Use AWS Secrets Manager exclusively. Never hardcode secrets.
- **Cross-Account**: Enable `crossAccountKeys: true` for cross-account deployments.

## Updating Infrastructure (CDK Workflow)
As you make changes to the infrastructure code (add/modify resources, parameters, etc.), follow this workflow:

1. **Synthesize the CloudFormation templates:**
   ```sh
   cdk synth --context baseDomain=yourdomain.com
   ```
   This checks for errors and generates the updated templates.

2. **Preview the changes:**
   ```sh
   cdk diff --context baseDomain=yourdomain.com
   ```
   This shows what will change in AWS (resources to be created, updated, or deleted).

3. **Deploy the updated stacks:**
   - To deploy all stacks:
     ```sh
     cdk deploy --all \
       --parameters AIStudio-AuthStack-Dev:GoogleClientId=your-dev-client-id \
       --parameters AIStudio-AuthStack-Prod:GoogleClientId=your-prod-client-id \
       --context baseDomain=yourdomain.com
     ```
   - Or deploy only the stacks you changed:
     ```sh
     cdk deploy AIStudio-DatabaseStack-Dev AIStudio-FrontendStack-Dev \
       --parameters AIStudio-AuthStack-Dev:GoogleClientId=your-dev-client-id \
       --context baseDomain=yourdomain.com
     ```
   - Only pass the `--parameters` flag for stacks that require parameters.

4. **Best Practices:**
   - Always run `cdk diff` before `cdk deploy` to avoid surprises.
   - Only deploy the stacks you changed if you want to minimize deployment time.
   - If you add new parameters or context variables, update your deploy commands accordingly.
   - Monitor the deployment output for any errors or manual approval prompts (e.g., IAM changes).

5. **Other Useful Commands:**
   - List stacks: `cdk list`
   - Destroy a stack: `cdk destroy AIStudio-FrontendStack-Dev --context baseDomain=yourdomain.com`

See `docs/DEPLOYMENT.md` for more details and examples.

## Authentication & SSR Development

### NextAuth v5 Configuration
Authentication uses NextAuth v5 with AWS Cognito and JWT strategy:
- Session managed via HTTP-only cookies
- Server-side session access via `getServerSession()`
- Protected routes under `/(protected)` layout group

### Protected Routes
Implement middleware for authentication:
```typescript
// middleware.ts
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sign-in).*)'
  ]
}
```

## Performance Monitoring
- Use `node --heap-prof` for memory profiling during builds
- Monitor bundle sizes with `npm run analyze` (if configured)
- Enable `serverComponentsHmrCache` for better development performance

See `docs/DEPLOYMENT.md` for more details and examples.

For more, see `CONTRIBUTING.md`. 