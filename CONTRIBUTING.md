# Contributing Guidelines

Thank you for contributing to this project! Please follow these standards to ensure code quality, maintainability, and security.

## Package Manager
- **Use npm exclusively** as the package manager for this project.
- Do not use yarn, pnpm, or other package managers.
- Always use `npm install` to install dependencies, not `yarn install` or `pnpm install`.
- Commit `package-lock.json` to the repository (never `yarn.lock` or `pnpm-lock.yaml`).

## Logging
- **Do NOT use** `console.log`, `console.error`, `console.warn`, `console.info`, or `console.debug` in any production or shared code.
- **All logging must use** the Winston logger (`import logger from "@/lib/logger"`) **in server-side code only** (server actions, API routes, backend utilities).
- **Never import or use `@/lib/logger` in client components or client hooks.** This will break the build.
- In client components/hooks, use `console.error` only for actionable errors in development. Do not log routine or non-actionable information.
- Remove any logs that are not valuable for debugging or operational insight.
- Never add logs for routine permission checks, database queries, or other noise.

## Linting & Formatting
- All code must pass ESLint (`npm run lint`).
- The `no-console` rule is enforced: no direct `console.*` calls are allowed in production/shared code. Client code may use `console.error` for actionable errors in development only.
- Use Prettier or the project's formatting rules for code style.
- Run `npm run typecheck` to ensure TypeScript types are correct before committing.

## TypeScript & Types
- Use TypeScript for all code.
- Prefer **interfaces** over type aliases.
- Export all types from `types/index.ts`.
- Import types from `@/types`.
- If referring to DB types, use `@/db/schema`.
- Use proper type imports: `import type { ... }` for type-only imports.

## Environment Variables
- Never expose secrets or sensitive values to the frontend.
- Use the `NEXT_PUBLIC_` prefix only for variables that must be accessed in the frontend.
- Update `.env.example` when adding or changing environment variables.
- Store all secrets in `.env.local` (never commit this file).
- **DB_LOG_QUERIES**: Set to `true` in `.env.local` to enable Drizzle ORM query logging in development. Leave blank or set to `false` to disable noisy query logs and keep dev logs clean.
- **Required for SSR**: Set `AUTH_URL=https://yourdomain.com` for server-side auth flows (use HTTPS in production).

## Security Best Practices

### Authentication & Authorization
- **JWT Configuration**: When using NextAuth, explicitly set `session: { strategy: "jwt" }` in configuration.
- **Session Security**: Always configure NextAuth with appropriate callbacks for JWT and session management.
- **Role-Based Access**: Use the `hasToolAccess()` function to check permissions before allowing access to protected resources.
- **Middleware Protection**: Implement authentication checks in `middleware.ts` for protected routes.

### AWS Infrastructure (CDK)
- **Security Groups**: Apply least-privilege principles. Never allow 0.0.0.0/0 unless absolutely necessary.
- **Encryption**: Enable encryption at rest for all data stores (RDS, S3, etc.).
- **SSL/TLS**: Enforce SSL on S3 buckets and use minimum TLS version 1.2.
- **IAM Policies**: Follow least-privilege principles. Use the CDK's `ConfirmPermissionsBroadening` check.
- **Secrets Management**: Use AWS Secrets Manager for all sensitive configuration. Never hardcode secrets.

### Database Access

**⚠️ CRITICAL DATABASE SAFETY WARNING ⚠️**
We experienced a catastrophic database corruption incident (July 2025) when SQL schema files didn't match the actual database structure. The db-init Lambda destroyed production data by running DROP/CREATE statements.

**MANDATORY RULES FOR DATABASE WORK:**
1. **NEVER modify SQL schema files** without verifying against the actual database using MCP tools
2. **NEVER trust the SQL files** in `/infra/database/schema/` - they may not match reality
3. **ALWAYS use MCP database tools** to inspect actual database structure, not file inspection
4. **NEVER deploy CDK** without verifying the Aurora HTTP endpoint is enabled

**Safe Practices:**
- **Field Naming Convention**: Database column names use snake_case. Drizzle ORM schema maps these to camelCase in TypeScript automatically.
- **Type-Safe Queries**: Always use Drizzle ORM `executeQuery` for database operations:
  ```typescript
  import { eq } from "drizzle-orm"
  import { executeQuery } from "@/lib/db/drizzle-client"
  import { users } from "@/lib/db/schema"

  const user = await executeQuery(
    (db) => db.select().from(users).where(eq(users.id, userId)).limit(1),
    "getUserById"
  )
  ```
- **Transaction Management**: Use `executeTransaction()` for operations that modify multiple tables.
- **Connection Security**: Access the database only through Drizzle ORM's `executeQuery`/`executeTransaction` wrappers.

**Database Migration Guidelines:**
- Initial setup files (001-005) should ONLY run on empty databases
- Migration files (010+) can make changes but must be carefully tested:
  - **Safe operations**: Adding tables, adding nullable columns, creating indexes
  - **Careful operations**: Adding NOT NULL columns (need defaults), renaming columns, changing data types
  - **Dangerous operations**: Dropping columns/tables (ensure no code depends on them first)
- Test ALL migrations on a restored snapshot before production deployment
- All migrations are tracked in the `migration_log` table
- The db-init-handler.ts must distinguish between fresh installs and existing databases
- Consider backwards compatibility - deploy code that works with both old and new schema first

## Server-Side Rendering (SSR) & Next.js

### Performance Optimization
- **Development**: Use `npm run dev:local` for local development with Docker PostgreSQL.
- **Imports**: Import specific components rather than entire libraries:
  ```typescript
  // Good
  import TriangleIcon from '@phosphor-icons/react/dist/csr/Triangle'
  // Bad
  import { TriangleIcon } from '@phosphor-icons/react'
  ```
- **Images**: Use `next/image` with proper `width` and `height` or `fill` props.

## Code Patterns & Architecture

### Architectural Principles
- **Separation of Concerns**: Keep presentation, business logic, and infrastructure in separate layers
- **Server-First**: Prefer server components and server actions over client-side logic
- **Consistency**: All server actions must return `ActionState<T>` for uniform error handling
- **No Business Logic in Components**: Business rules belong in `/actions`, not in UI components
- **Infrastructure Abstraction**: Database and external services accessed only through adapters in `/lib`

### Server Actions
Follow the consistent `ActionState<T>` pattern for all server actions:
```typescript
export async function actionName(): Promise<ActionState<ReturnType>> {
  const session = await getServerSession()
  if (!session) return { isSuccess: false, message: "Unauthorized" }

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

### Error Handling
- Use structured error handling with `AppError` and error levels (USER, SYSTEM, EXTERNAL).
- Handle refresh token errors gracefully in authentication flows.
- Provide meaningful error messages that help users understand what went wrong.

### File References
When documenting code or in comments, include file references in the format `path/to/file.ts:lineNumber` for easy navigation.

## Naming & Imports
- Use **kebab-case** for all files and folders.
- Use the `@` alias for imports unless otherwise specified.
- Follow existing naming patterns in the codebase.

## Components & Folders
- Place shared components in `/components`.
- Place one-off route components in `/_components` within the route.
- Follow project structure and naming conventions.
- Keep components focused and single-purpose.

## Testing
- Add or update tests for new features and bug fixes.
- Include tests for authentication flows and protected routes.
- Test error scenarios and edge cases.
- Do not break existing tests.
- Run all tests before submitting a PR (`npm test`).

## Development Workflow

### Before Committing
1. Run `npm run lint` to check for linting errors.
2. Run `npm run typecheck` to verify TypeScript types.
3. Run `npm test` to ensure all tests pass.
4. Update `CLAUDE.md` if you've made architectural changes.
5. Update relevant documentation for API changes.

### Pull Requests & Code Review
- All PRs must pass CI (lint, build, and tests) before merge.
- All PRs must be reviewed and approved by at least one other contributor.
- Use the PR template and complete all checklist items.
- Include clear descriptions of what changed and why.
- Reference any related issues or tickets.

## Documentation
- Update documentation as needed for new features, changes, or fixes.
- Document security implications of changes.
- Keep `CLAUDE.md` up to date with architectural decisions.
- Use clear, concise comments for complex logic.

---

By following these guidelines, you help keep the codebase clean, maintainable, and production-ready. Thank you for your contributions! 