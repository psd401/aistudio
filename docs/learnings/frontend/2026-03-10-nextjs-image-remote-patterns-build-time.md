---
title: Next.js Image remotePatterns evaluated at build time — S3 signed URLs blocked when env vars absent from Docker build context
category: frontend
tags:
  - nextjs
  - image-optimization
  - s3
  - caching
  - stale-while-revalidate
severity: high
date: 2026-03-10
source: auto — /work
applicable_to: project
---

## What Happened

S3 presigned URLs served via `next/image` were blocked in the containerized app. `remotePatterns` in `next.config.ts` referenced env vars for the S3 hostname, but those vars were not present in the Docker build context, so the pattern compiled to an empty or wrong value.

## Root Cause

`next/image` `remotePatterns` are evaluated at **build time** (when `next build` runs), not at runtime. If the env var supplying the S3 hostname is missing during `docker build`, the pattern is never registered and all matching URLs are blocked with a 400.

## Solution

Add the `unoptimized` prop to `<Image>` components that render dynamic S3 presigned URLs. This bypasses the Next.js image optimizer entirely, which is appropriate for short-lived signed URLs that cannot be cached anyway.

```tsx
<Image src={presignedUrl} unoptimized ... />
```

## Prevention

- For any `<Image>` that renders a signed or dynamic S3 URL, default to `unoptimized`.
- `remotePatterns` is only viable for stable, non-signed hostnames whose value is known at build time and injected into the Docker build via `--build-arg` / `ARG` / `ENV`.
- If the hostname is dynamic or env var is runtime-only, `unoptimized` is the correct approach.
