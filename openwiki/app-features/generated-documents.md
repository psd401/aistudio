---
type: Feature Guide
title: Nexus Generated Documents (#1898)
description: How Nexus chat turns a model request into a downloadable Word, Excel, PowerPoint, or PDF file, covering the generate_document tool, conversation-scoped storage, the authenticated download route, and the download card.
tags: [nexus, documents, generation, download, chat-tools]
openwiki:
  roles: [architecture, domain, integration]
  change_kinds: [public-api, lifecycle, security]
  source_paths:
    - lib/tools/document-create-tool.ts
    - lib/tools/document-create-contract.ts
    - lib/ai/document-generation-service.ts
    - lib/ai/markdown-blocks.ts
    - lib/ai/document-docx-builder.ts
    - app/api/nexus/documents/[...key]/route.ts
    - app/api/nexus/chat/route.ts
    - app/(protected)/nexus/_components/tools/document-download-ui.tsx
    - lib/nexus/workspace-tool-history.ts
    - lib/tools/catalog/manifest.ts
  symbols: [createDocumentCreateTool, skillPinAllowsDocumentCreate, generateDocument, isConversationScopedDocumentKey, conversationIdFromDocumentKey, markdownToSlides, buildDocxDocument, GET]
  test_paths:
    - tests/unit/lib/tools/document-create-tool.test.ts
    - tests/unit/nexus-document-download-route.test.ts
    - tests/unit/nexus-document-download-card.test.tsx
    - tests/unit/lib/ai/document-generation-service.test.ts
    - tests/unit/lib/ai/document-generation-pptx.test.ts
    - tests/smoke/nexus-document-markdown.smoke.ts
    - infra/lambdas/nexus-conversation-retention/retention-policy.test.ts
  invariants:
    - A conversation-scoped document is never delivered through a presigned S3 URL; every download re-checks conversation ownership.
    - userId and conversationId come from the authenticated request, never from model input.
    - Tool failures are returned as data so the turn continues.
  validation_commands:
    - bun run test:smoke:nexus-document-markdown
---
