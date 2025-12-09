# syntax=docker.io/docker/dockerfile:1
# Multi-stage Dockerfile for Next.js AI Studio Application
# Optimized for ECS Fargate deployment with streaming support and graceful shutdown

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

# Install dependencies for native packages
RUN apk add --no-cache libc6-compat

# Copy package files
COPY package.json package-lock.json* ./

# Install ALL dependencies (including dev) with BuildKit cache mount for 50-90% faster builds
# Dev dependencies needed for build stage
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

# ============================================================================
# Stage 2: Builder
# ============================================================================
FROM node:22-alpine AS builder
WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy all source files
COPY . .

# Set build-time environment variables
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Dummy environment variables required for Next.js build
# Real values will be injected at runtime by ECS
ENV DOCUMENTS_BUCKET_NAME=build-time-placeholder
ENV NEXT_PUBLIC_AWS_REGION=us-east-1
ENV RDS_RESOURCE_ARN=arn:aws:rds:us-east-1:000000000000:cluster:build-placeholder
# Use ARG for secret ARN to avoid security warning (it's just a build placeholder)
ARG RDS_SECRET_ARN=arn:aws:secretsmanager:us-east-1:000000000000:secret:build-placeholder
ENV RDS_SECRET_ARN=${RDS_SECRET_ARN}

# Build with cache mount for Next.js build artifacts
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# ============================================================================
# Stage 3: Production Runner
# ============================================================================
FROM node:22-alpine AS runner
WORKDIR /app

# Install curl for health checks (works with read-only filesystem and non-root users)
RUN apk add --no-cache curl

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Copy only necessary files from builder
# Next.js standalone output - copy everything from standalone directory first
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Copy public files to the root (standalone expects them here)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Copy static files to the .next/static location
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Create Next.js cache directories with correct ownership
# Required for Image Optimization in read-only filesystem (issue #509)
# Next.js attempts to create /app/.next/cache/images at runtime, but the volume
# is mounted with root ownership. Pre-creating with nextjs:nodejs ownership
# allows the non-root user to write optimized images to cache.
RUN mkdir -p .next/cache/images && \
    chown -R nextjs:nodejs .next/cache && \
    chmod 755 .next/cache/images

# Switch to non-root user
USER nextjs

# Expose application port
EXPOSE 3000

# Note: Health checks are defined in ECS task definition (ecs-service.ts)
# Dockerfile HEALTHCHECK is redundant since ECS task definition overrides it
# Removed to follow AWS best practice: single source of truth for health checks

# ECS Fargate provides built-in init process (initProcessEnabled: true)
# No need for tini - ECS handles PID 1 signal management
CMD ["node", "server.js"]
