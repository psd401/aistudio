# File Upload Architecture

## Overview

Repository-backed product uploads use the canonical unified-content contract.
The browser sends bounded metadata to an authenticated initiation route, uploads
the file directly to a signed S3 URL, and sends only multipart ETags/session
metadata to completion. File bytes do not traverse a Next.js request.

The document endpoints below remain compatibility paths for product surfaces
not yet retired. Repository Manager, Assistant Architect canonical runtime
inputs, and Nexus canonical attachments use the repository flow described in
[Unified Repository Product Integration](./unified-repository-product-integration.md).

### Canonical upload safety

- Upload reservation locks and verifies the current active repository before
  issuing a one-hour URL. Completion takes the same repository lock before the
  session lock and registration transaction.
- Single-part URLs are write-once (`If-None-Match: *`). Single and multipart
  sources are created with `aistudio-upload-state=temporary`.
- The processor reads GuardDuty tags before source bytes. Awaiting or infected
  objects remain temporary; after a clean/not-required decision it preserves
  the full existing tag set and changes only the upload-state value to
  `permanent`.
- Expired sessions receive an initial version-aware sweep and a delayed final
  sweep after a one-hour request-settle window. A tag-filtered S3 lifecycle rule
  expires any late temporary current object within one day.
- Repository deletion waits through the same settle window and refuses active
  or deferred external processors before entering its retryable `deleting`
  state.

## Legacy document upload flow

### Small Files (≤ 1MB)
1. Files are uploaded directly to `/api/documents/upload`
2. The API processes the file in memory
3. Text is extracted and chunked
4. File is uploaded to S3
5. Metadata is saved to the database

### Large Files (> 1MB)
1. Client requests a presigned URL from `/api/documents/presigned-url`
2. Client uploads file directly to S3 using the presigned URL
3. Client notifies `/api/documents/process` of successful upload
4. Server downloads file from S3 for processing
5. Text is extracted and chunked
6. Metadata is saved to the database

## Benefits
- Bypasses Amplify's 1MB limit for production deployments
- Provides real-time upload progress for large files
- Reduces server memory usage for large uploads
- Maintains backward compatibility for small files

## Configuration
- File size limit is controlled by `MAX_FILE_SIZE_MB` environment variable (default: 25MB)
- The 1MB threshold for switching to presigned URLs is hardcoded based on AWS Amplify's request body size limit

## Security
- Presigned URLs expire after 1 hour
- S3 keys include user ID for access isolation
- Processing endpoint validates S3 object ownership
- All endpoints require authentication

## Related Files
- `/app/api/documents/presigned-url/route.ts` - Generates presigned URLs
- `/app/api/documents/process/route.ts` - Processes uploaded files
- `/app/(protected)/chat/_components/document-upload.tsx` - Client upload component
- `/lib/aws/s3-client.ts` - S3 utilities including presigned URL generation

## GitHub Issue
This implementation addresses issue #73: File uploads failing with HTTP 413 on production environment
