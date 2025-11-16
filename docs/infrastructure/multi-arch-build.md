# Multi-Architecture Docker Build Guide

This document explains the multi-architecture Docker build strategy for AI Studio, optimized for AWS Graviton2 (ARM64) processors.

## Overview

AI Studio uses AWS Graviton2 processors (ARM64 architecture) to achieve:
- **40% better price/performance** compared to x86
- **70% cost savings** with Fargate Spot instances
- **Lower latency** with optimized ARM64 builds

## Build Strategies

### 1. CDK Automatic Build (Recommended)

The default deployment uses `ecs.ContainerImage.fromAsset()` which automatically:
- Builds Docker images during CDK deployment
- Uses the correct architecture (ARM64) based on `platform` parameter
- Pushes images to ECR
- No manual Docker commands required

```bash
cd infra
npx cdk deploy AIStudio-FrontendStack-ECS-Dev
```

### 2. Manual Multi-Architecture Build

For manual builds or CI/CD pipelines:

```bash
# Set up Docker buildx for multi-architecture support
docker buildx create --use --name multiarch-builder
docker buildx inspect --bootstrap

# Build and push for both ARM64 and AMD64
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --tag ${ECR_REPO}:latest \
  --tag ${ECR_REPO}:${GIT_SHA} \
  --file Dockerfile.graviton \
  --push \
  .
```

### 3. ARM64-Only Build (Current Default)

For Graviton2-optimized deployments:

```bash
# Build for ARM64 only (faster, smaller)
docker buildx build \
  --platform linux/arm64 \
  --tag ${ECR_REPO}:latest \
  --file Dockerfile.graviton \
  --push \
  .
```

## Dockerfile Variants

### Dockerfile (Standard)
- Multi-architecture support
- Uses Node.js 22 Alpine base
- Suitable for both ARM64 and AMD64

### Dockerfile.graviton (Optimized)
- ARM64-specific optimizations
- Compiler flags: `-march=armv8-a+crc+simd`
- Memory optimization: `MALLOC_ARENA_MAX=2`
- Better performance on Graviton2

## CDK Configuration

The ECS construct automatically uses ARM64:

```typescript
// infra/lib/constructs/ecs-service.ts
const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
  runtimePlatform: {
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
  },
});

// Container image with platform targeting
const containerImage = ecs.ContainerImage.fromAsset('../', {
  file: 'Dockerfile.graviton',
  platform: ecr_assets.Platform.LINUX_ARM64,
});
```

## Build Performance Comparison

| Architecture | Build Time | Image Size | Runtime Performance |
|-------------|------------|------------|---------------------|
| ARM64 (Graviton) | ~5-7 min | ~180 MB | Baseline |
| AMD64 (x86) | ~6-9 min | ~195 MB | -20% slower |
| Multi-arch | ~10-15 min | Both | Depends on runtime |

## Native Dependencies

Some npm packages require compilation for ARM64:

```json
{
  "dependencies": {
    "sharp": "^0.33.0",      // Auto-detects ARM64
    "bcrypt": "^5.1.1",      // Compiles for ARM64
    "@aws-sdk/client-*": "*" // Pure JS, no compilation
  }
}
```

## Troubleshooting

### Build Fails with "exec format error"

**Cause:** Building on x86 machine without proper emulation

**Solution:**
```bash
# Install QEMU for ARM64 emulation
docker run --privileged --rm tonistiigi/binfmt --install all

# Verify buildx supports ARM64
docker buildx inspect --bootstrap
```

### Slow Builds on macOS

**Cause:** QEMU emulation overhead on Apple Silicon

**Solution:**
```bash
# Use native ARM64 build on Apple Silicon
docker buildx build --platform linux/arm64 ...
```

### Native Module Compilation Errors

**Cause:** Missing build dependencies

**Solution:**
```dockerfile
# Ensure build tools installed
RUN apk add --no-cache python3 make g++
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: Set up QEMU
  uses: docker/setup-qemu-action@v3

- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3

- name: Build and push
  uses: docker/build-push-action@v5
  with:
    platforms: linux/arm64
    file: Dockerfile.graviton
    push: true
    tags: ${{ env.ECR_REPO }}:${{ github.sha }}
```

### AWS CodeBuild

```yaml
phases:
  pre_build:
    commands:
      - docker run --privileged --rm tonistiigi/binfmt --install all
      - docker buildx create --use
  build:
    commands:
      - docker buildx build --platform linux/arm64 --push .
```

## Performance Optimization

### Compiler Flags

Dockerfile.graviton uses ARM64-specific flags:

```dockerfile
ENV CFLAGS="-O3 -march=armv8-a+crc+simd"
ENV CXXFLAGS="-O3 -march=armv8-a+crc+simd"
```

- `-O3`: Maximum optimization
- `-march=armv8-a`: Target ARM v8 architecture
- `+crc`: Enable CRC extensions
- `+simd`: Enable SIMD instructions

### Memory Configuration

```dockerfile
ENV MALLOC_ARENA_MAX=2      # Reduce fragmentation
ENV GODEBUG=madvdontneed=1  # Better memory release
```

### Node.js Optimization

Set via ECS task environment:

```typescript
NODE_OPTIONS: `--max-old-space-size=${Math.floor(memory * 0.7)}`
UV_THREADPOOL_SIZE: '8'  // Optimized for ARM64 cores
```

## Cost Analysis

### Fargate Pricing (us-east-1)

| Configuration | Architecture | Pricing | Monthly Cost (1 task) |
|--------------|--------------|---------|----------------------|
| 1 vCPU, 2 GB | x86 (On-Demand) | $0.04048/hr | ~$29.15 |
| 1 vCPU, 2 GB | ARM64 (On-Demand) | $0.03238/hr | ~$23.32 |
| 1 vCPU, 2 GB | ARM64 (Spot) | $0.00971/hr | ~$6.99 |

**Savings:**
- ARM64 vs x86: 20% savings
- Spot vs On-Demand: 70% savings
- ARM64 Spot vs x86 On-Demand: **76% savings**

## Best Practices

1. **Use Dockerfile.graviton** for production deployments
2. **Enable BuildKit caching** for faster builds
3. **Pin Node.js version** to ensure consistency
4. **Test native modules** before deploying
5. **Monitor memory usage** and adjust limits
6. **Use multi-stage builds** to minimize image size
7. **Set proper health checks** in ECS task definition
8. **Enable Container Insights** for monitoring

## References

- [AWS Graviton2 Getting Started](https://github.com/aws/aws-graviton-getting-started)
- [Fargate Pricing](https://aws.amazon.com/fargate/pricing/)
- [Docker Buildx Documentation](https://docs.docker.com/buildx/working-with-buildx/)
- [Node.js on ARM64](https://nodejs.org/en/download/)
