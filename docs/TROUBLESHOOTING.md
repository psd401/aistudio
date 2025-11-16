# Troubleshooting Guide

Common issues and solutions for AI Studio development and deployment.

## Table of Contents

- [Development Issues](#development-issues)
- [Database Issues](#database-issues)
- [Authentication Issues](#authentication-issues)
- [Deployment Issues](#deployment-issues)
- [Performance Issues](#performance-issues)
- [Streaming & SSE Issues](#streaming--sse-issues)

## Development Issues

### Issue: `npm run dev` fails with module not found

**Symptoms:**
```
Error: Cannot find module '@/lib/...'
```

**Solutions:**
1. Clear Next.js cache and rebuild:
```bash
rm -rf .next node_modules
npm install
npm run dev
```

2. Check tsconfig.json paths are configured:
```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./*"]
    }
  }
}
```

### Issue: Type errors after pulling latest code

**Symptoms:**
```
Type 'X' is not assignable to type 'Y'
```

**Solutions:**
```bash
# Regenerate types from database
npm run typecheck

# If using Prisma (legacy):
npx prisma generate
```

### Issue: Environment variables not loading

**Symptoms:**
- `process.env.VARIABLE_NAME` is `undefined`
- API calls fail with missing configuration

**Solutions:**
1. Verify `.env.local` exists with required variables
2. Restart dev server after adding new variables
3. Check variable names start with `NEXT_PUBLIC_` if used client-side
4. Verify no typos in variable names

**Required variables:**
```bash
# See .env.example for complete list
DATABASE_RESOURCE_ARN=
DATABASE_SECRET_ARN=
DATABASE_NAME=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
```

## Database Issues

### Issue: RDS Data API returns empty results

**Symptoms:**
- Queries execute but return `[]`
- No errors in logs

**Solutions:**
1. Use MCP tools to verify schema:
```
mcp__awslabs_postgres-mcp-server__get_table_schema table_name
```

2. Check parameter types match database columns:
```typescript
// Wrong
{ name: 'id', value: { stringValue: '123' } }  // id is INT

// Correct
{ name: 'id', value: { longValue: 123 } }
```

3. Verify table actually has data:
```sql
SELECT COUNT(*) FROM table_name;
```

### Issue: Migration fails with "relation already exists"

**Symptoms:**
```
ERROR: relation "table_name" already exists
```

**Solutions:**
1. Check if migration already ran:
```sql
SELECT * FROM migration_log ORDER BY executed_at DESC;
```

2. For development, reset database:
```bash
# WARNING: Destroys all data
cd infra
npx cdk destroy AIStudio-DatabaseStack-Dev
npx cdk deploy AIStudio-DatabaseStack-Dev
```

3. For production, create new migration to fix inconsistency

### Issue: "null value in column violates not-null constraint"

**Symptoms:**
```
ERROR: null value in column "column_name" violates not-null constraint
```

**Solutions:**
1. Check all required fields are provided:
```typescript
await executeSQL(`INSERT INTO users (email, first_name) VALUES (:email, :firstName)`, [
  { name: 'email', value: { stringValue: email } },
  { name: 'firstName', value: { stringValue: firstName } }  // Was missing
]);
```

2. Use `isNull: true` for nullable columns:
```typescript
{ name: 'optional_field', value: { isNull: true } }
```

## Authentication Issues

### Issue: "Unauthorized" after login

**Symptoms:**
- Redirected to login page immediately after successful login
- Session cookie not being set

**Solutions:**
1. Check `NEXTAUTH_URL` matches your development URL:
```bash
# .env.local
NEXTAUTH_URL=http://localhost:3000
```

2. Verify Cognito callback URL is configured:
```
AWS Cognito User Pool → App Client → Allowed callback URLs
http://localhost:3000/api/auth/callback/cognito
```

3. Clear browser cookies and retry

### Issue: "You do not have permission to use this tool"

**Symptoms:**
- User logged in but gets 403 Forbidden
- `hasToolAccess()` returns false

**Solutions:**
1. Verify user has correct role assigned:
```sql
SELECT u.email, r.name AS role
FROM users u
JOIN user_roles ur ON u.id = ur.user_id
JOIN roles r ON ur.role_id = r.id
WHERE u.email = 'user@example.com';
```

2. Check role has tool permission:
```sql
SELECT r.name AS role, t.identifier AS tool
FROM roles r
JOIN role_tools rt ON r.id = rt.role_id
JOIN tools t ON rt.tool_id = t.id
WHERE r.name = 'staff';
```

3. Grant permission manually:
```sql
INSERT INTO role_tools (role_id, tool_id)
SELECT r.id, t.id
FROM roles r, tools t
WHERE r.name = 'staff' AND t.identifier = 'assistant-architect';
```

### Issue: Session expires immediately

**Symptoms:**
- Need to re-login every few minutes
- `getServerSession()` returns null

**Solutions:**
1. Check session maxAge in auth config:
```typescript
// Should be 30 days
session: {
  maxAge: 30 * 24 * 60 * 60
}
```

2. Verify cookies are being sent:
```bash
# Check browser dev tools → Application → Cookies
__Secure-next-auth.session-token should exist
```

## Deployment Issues

### Issue: CDK deploy fails with "Stack already exists"

**Symptoms:**
```
Stack [StackName] already exists
```

**Solutions:**
```bash
# Update existing stack instead
npx cdk deploy StackName --require-approval never

# Or force recreate (WARNING: destroys resources)
npx cdk destroy StackName
npx cdk deploy StackName
```

### Issue: ECS task fails to start

**Symptoms:**
- Task shows "STOPPED" status immediately
- Container exits with code 1

**Solutions:**
1. Check CloudWatch Logs:
```bash
aws logs tail /aws/ecs/aistudio-frontend-dev --follow
```

2. Common issues:
- Missing environment variables
- Database connection failure
- Port 3000 already in use
- Out of memory (increase task memory)

3. Verify ECS task definition:
```bash
aws ecs describe-task-definition --task-definition aistudio-frontend-dev
```

### Issue: ALB health checks failing

**Symptoms:**
- Targets show "unhealthy" in target group
- 502 Bad Gateway errors

**Solutions:**
1. Verify health check endpoint works:
```bash
curl http://task-ip:3000/api/health
```

2. Check health check configuration:
```typescript
healthCheck: {
  path: '/api/health',    // Must return 200
  interval: Duration.seconds(30),
  timeout: Duration.seconds(5),
  healthyThresholdCount: 2,
  unhealthyThresholdCount: 3
}
```

3. Increase health check timeout if responses are slow

## Performance Issues

### Issue: Slow database queries

**Symptoms:**
- API responses take > 1 second
- Database queries timeout

**Solutions:**
1. Add indexes for frequently queried columns:
```sql
CREATE INDEX idx_nexus_conversations_user_id ON nexus_conversations(user_id);
CREATE INDEX idx_nexus_messages_conversation_id ON nexus_messages(conversation_id);
```

2. Use `EXPLAIN ANALYZE` to debug slow queries:
```sql
EXPLAIN ANALYZE
SELECT * FROM repository_item_chunks
WHERE item_id = 123
ORDER BY chunk_index;
```

3. Consider pagination for large result sets:
```sql
SELECT * FROM nexus_conversations
WHERE user_id = :userId
ORDER BY last_message_at DESC
LIMIT 50 OFFSET 0;
```

### Issue: High memory usage in Lambda

**Symptoms:**
- Lambda functions timing out
- Out of memory errors

**Solutions:**
1. Check memory allocation (should be 1024MB after PowerTuning):
```typescript
new Function(this, 'MyFunction', {
  memorySize: 1024  // Not 3008
});
```

2. Process in batches:
```typescript
// Instead of processing all at once
const chunks = await getAllChunks();  // Could be 10,000 items

// Process in batches
for (let i = 0; i < chunks.length; i += 25) {
  const batch = chunks.slice(i, i + 25);
  await processBatch(batch);
}
```

## Streaming & SSE Issues

### Issue: SSE stream disconnects after 30 seconds

**Symptoms:**
- Stream stops mid-response
- Browser shows "EventSource failed"

**Solutions:**
1. Increase ALB idle timeout:
```typescript
alb.setAttribute('idle_timeout.timeout_seconds', '900');
```

2. Send heartbeat events to keep connection alive:
```typescript
// Server-side
const interval = setInterval(() => {
  res.write(':heartbeat\n\n');
}, 15000);  // Every 15 seconds
```

3. Handle reconnection client-side:
```typescript
eventSource.onerror = () => {
  eventSource.close();
  // Reconnect after delay
  setTimeout(() => reconnect(), 1000);
};
```

### Issue: "Circuit breaker is open" errors

**Symptoms:**
- All requests to AI provider fail immediately
- Error: `CircuitBreakerOpenError`

**Solutions:**
1. Check circuit breaker metrics:
```bash
# Check CloudWatch metrics
aws cloudwatch get-metric-statistics \
  --namespace AIStudio/Streaming \
  --metric-name CircuitBreakerState \
  --dimensions Name=Provider,Value=openai
```

2. Wait for automatic reset (30 seconds)

3. Or manually reset by restarting ECS task:
```bash
aws ecs update-service \
  --cluster aistudio-dev \
  --service frontend \
  --force-new-deployment
```

### Issue: Streaming responses are garbled

**Symptoms:**
- Text chunks appear out of order
- Response contains invalid JSON

**Solutions:**
1. Verify SSE event parsing:
```typescript
// Events must be properly formatted
data: {"type":"text-delta","content":"Hello"}\n\n
```

2. Don't buffer responses:
```typescript
// Wrong
let buffer = '';
buffer += chunk;  // Can cause out-of-order issues

// Correct
yield chunk;  // Emit immediately
```

## Getting Help

1. **Check logs:**
   - CloudWatch Logs for Lambda/ECS
   - Browser console for client errors
   - Network tab for API failures

2. **Enable debug logging:**
```typescript
import { createLogger } from '@/lib/logger';
const log = createLogger({ module: 'debug' });
log.debug('Detailed info', { data });
```

3. **Search GitHub issues:**
```bash
https://github.com/psd401/aistudio/issues
```

4. **Create new issue with:**
- Error message
- Steps to reproduce
- Environment (dev/staging/prod)
- Relevant logs

---

**Last Updated**: November 2025
**Status**: Living document - add new issues as discovered
**Priority**: Keep solutions concise and actionable
