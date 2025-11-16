# Assistant Architect - Deployment Guide

## Overview

This guide covers the deployment of the Assistant Architect feature, which executes multi-step AI workflows via direct ECS execution. Assistant Architect uses the same streaming infrastructure as Nexus Chat and Model Compare for consistent, scalable AI processing.

## 🏗️ Architecture

Assistant Architect execution follows this flow:

1. **User Execution** → Frontend calls `executeAssistantArchitectAction`
2. **Job Creation** → Creates execution job in database (`tool_executions` table)
3. **Direct ECS Processing** → ECS service executes the tool via HTTP/2 streaming
4. **Chain Execution** → Sequential prompt processing with variable substitution
5. **Database Updates** → Real-time updates to `tool_executions` and `prompt_results`
6. **Results Display** → Frontend receives execution results immediately

**Key Change (PR #340)**: Assistant Architect previously used Lambda workers + SQS polling. It now uses direct ECS execution for simplified architecture and reduced latency.

## 🚀 Pre-Deployment Checklist

### ✅ Code Quality & Build Status
- **Linting**: Must pass (`npm run lint`)
- **TypeScript**: Must compile (`npm run typecheck`)
- **Build**: Must complete successfully (`npm run build`)
- **Dependencies**: Must be installed (`npm install`)

### ✅ Infrastructure Requirements
- **ECS Service**: Running on Fargate with auto-scaling enabled
- **Database**: Aurora Serverless v2 accessible from ECS tasks
- **RDS Data API**: Configured for database access
- **IAM Roles**: ECS task role has permissions for RDS, Bedrock, SSM

## 🔧 Deployment Process

### Step 1: Code Build

```bash
# Navigate to project root
cd /path/to/aistudio.psd401.ai

# Install dependencies
npm install

# Build the application
npm run build

# Verify build succeeded
ls -la .next/
```

### Step 2: Run Quality Checks

```bash
# TypeScript type checking
npm run typecheck

# Linting
npm run lint

# Fix any auto-fixable issues
npm run lint:fix
```

### Step 3: Commit Changes

```bash
# Stage changes
git add .

# Commit with detailed message
git commit -m "feat: update Assistant Architect deployment

- Description of changes
- Any breaking changes
- Related issues"

# Push to development branch
git push origin dev
```

### Step 4: Deploy to AWS

The application is automatically built and deployed via ECS Fargate when changes are merged to the `dev` or `main` branches (requires manual CDK deployment).

**Manual ECS deployment:**

```bash
# Deploy Frontend stack (includes ECS Fargate service)
cd infra
npx cdk deploy AIStudio-FrontendStack-Dev

# Or deploy all stacks
npx cdk deploy --all
```

## 📋 Post-Deployment Testing

### Basic Functionality Test

1. **Create Simple Tool**: Make a 1-prompt Assistant Architect tool
2. **Execute Tool**: Run it and verify it completes successfully
3. **Check Results**: Verify output is correct and saved to database

### Chain Execution Test

1. **Create Chain Tool**: Make a 2-prompt tool with variable substitution
   - Prompt 1: "Analyze this: {{user_input}}"
   - Prompt 2: "Summarize: {{prompt_1_output}}"
2. **Execute**: Verify second prompt receives first prompt's output
3. **Database Check**: Verify both prompts saved to `prompt_results` table

### Error Handling Test

1. **Create Invalid Tool**: Tool with malformed prompt or missing model
2. **Execute**: Should fail gracefully with clear error message
3. **Check**: Verify `tool_executions` marked as `failed`

## 🔍 Monitoring & Debugging

### Application Logs

```bash
# View ECS service logs
aws logs tail /aws/ecs/AIStudio-ECSService-Dev --follow

# Filter for Assistant Architect logs
aws logs tail /aws/ecs/AIStudio-ECSService-Dev --follow --filter-pattern "assistant-architect"

# Get recent error logs
aws logs tail /aws/ecs/AIStudio-ECSService-Dev --follow --filter-pattern "ERROR"
```

### Database Queries

```sql
-- Recent tool executions
SELECT te.id, te.status, te.started_at, te.completed_at,
       aa.name as tool_name,
       u.email as user_email
FROM tool_executions te
JOIN assistant_architects aa ON te.assistant_architect_id = aa.id
JOIN users u ON te.user_id = u.id
ORDER BY te.started_at DESC
LIMIT 10;

-- Tool execution with prompt results
SELECT te.id as execution_id,
       te.status as execution_status,
       aa.name as tool_name,
       pr.prompt_id,
       pr.status as prompt_status,
       pr.execution_time_ms,
       LENGTH(pr.output_data::text) as output_length
FROM tool_executions te
JOIN assistant_architects aa ON te.assistant_architect_id = aa.id
LEFT JOIN prompt_results pr ON pr.execution_id = te.id
WHERE te.id = :execution_id
ORDER BY pr.prompt_id;

-- Failed executions for debugging
SELECT te.id, te.started_at, aa.name, te.input_data
FROM tool_executions te
JOIN assistant_architects aa ON te.assistant_architect_id = aa.id
WHERE te.status = 'failed'
ORDER BY te.started_at DESC
LIMIT 20;
```

### Performance Monitoring

Monitor these CloudWatch metrics:
- **ECS Service CPU/Memory**: Should stay below 80%
- **Response Time**: Should average < 5 seconds for simple tools
- **Error Rate**: Should be < 1%
- **Database Connections**: Should not exceed pool limit

## 🎯 Expected Architecture Flow

### Current Flow (ECS-based)

1. User clicks "Execute" on Assistant Architect tool
2. `executeAssistantArchitectAction` creates execution record in database
3. ECS service processes the tool via direct HTTP request
4. For multi-prompt tools:
   - Execute Prompt 1 → Save to `prompt_results`
   - Substitute variables into Prompt 2 using Prompt 1 output
   - Execute Prompt 2 → Save to `prompt_results`
   - Continue for all prompts in sequence
5. Mark execution as `completed` or `failed`
6. Return results to frontend

### Previous Flow (Deprecated - Lambda-based)

~~1. User execution → Create streaming job~~
~~2. Queue job to SQS~~
~~3. Lambda worker processes from queue~~
~~4. Poll for results~~

**Migration (PR #340)**: Lambda workers and SQS queues removed. All execution now via ECS.

## 🚨 Troubleshooting

### Tool Execution Fails

**Symptoms**: Execution status shows `failed`

**Debugging Steps**:
1. Check application logs for error details
2. Verify model is configured correctly
3. Check database for error messages in `tool_executions`
4. Verify ECS service is running and healthy

**Common Causes**:
- Invalid prompt syntax
- Model not available or quota exceeded
- Database connection issues
- Insufficient ECS task permissions

### Variable Substitution Not Working

**Symptoms**: Prompt 2+ doesn't receive output from Prompt 1

**Debugging Steps**:
1. Check `prompt_results` table for Prompt 1 output
2. Verify variable syntax: `{{prompt_1_output}}`, `{{user_input}}`
3. Check application logs for substitution errors

**Common Causes**:
- Typo in variable name
- Prompt 1 failed to execute
- Output data not saved correctly

### Slow Execution

**Symptoms**: Tool takes too long to complete

**Debugging Steps**:
1. Check model response times in logs
2. Verify database query performance
3. Review ECS service metrics (CPU/Memory)
4. Check for network latency issues

**Common Causes**:
- Large prompt requiring long processing time
- Database queries slow (needs indexing)
- ECS service under-provisioned
- Model API throttling

## 📝 Deployment Summary

### What This Deployment Includes

- **Backend**: `executeAssistantArchitectAction` creates execution records
- **ECS Service**: Processes tools via direct HTTP execution
- **Frontend**: Displays execution status and results
- **Database**: Stores executions in `tool_executions` and `prompt_results`

### Architecture Benefits

- **Performance**: Direct execution eliminates SQS polling delay (1-5 second improvement)
- **Simplicity**: Single execution path via ECS (no Lambda workers to manage)
- **Cost**: Reduced infrastructure costs (~$40/month savings)
- **Scalability**: ECS auto-scaling handles load automatically
- **Reliability**: Fewer infrastructure components to maintain

### Database Schema

**`tool_executions` table**:
- Tracks overall execution status
- Links to `assistant_architects` and `users`
- Stores input data and completion time

**`prompt_results` table**:
- Stores individual prompt execution results
- Links to `tool_executions` via `execution_id`
- Contains prompt inputs, outputs, and execution time

**`assistant_architects` table**:
- Tool configuration (name, description, model)
- Prompt chain definition
- Tool permissions and visibility

## 🔄 Rollback Plan

If deployment fails or Assistant Architect stops working:

### Quick Rollback

```bash
# Revert to previous working commit
git checkout <previous-working-commit>

# Rebuild
npm run build

# Redeploy
cd infra
npx cdk deploy AIStudio-ECSServiceStack-Dev
```

### Emergency Fix

If issues persist, check:
1. ECS service health status
2. Database connectivity from ECS
3. IAM role permissions
4. Application logs for specific errors

## 📚 Related Documentation

- [ECS Deployment Guide](./ECS_DEPLOYMENT.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [ADR-002: Streaming Architecture Migration](./architecture/ADR-002-streaming-architecture-migration.md)
- [ADR-003: ECS Streaming Migration](./architecture/ADR-003-ecs-streaming-migration.md)
- [Streaming Infrastructure Operations](./operations/streaming-infrastructure.md)

---

**Last Updated**: October 2025
**Migration**: PR #340 - Remove Lambda streaming workers, use direct ECS execution
**Related Issues**: #313, #341, #343
