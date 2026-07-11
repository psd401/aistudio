# Testing

AI Studio has comprehensive test coverage including unit tests, integration tests, E2E tests, and smoke tests. The test suite ensures reliability across authentication, content management, AI streaming, and infrastructure.

## Test Structure

```
/tests/
├── unit/              # Unit tests (Jest)
│   ├── actions/       # Server action tests
│   ├── api/           # API route tests
│   ├── lib/           # Library unit tests
│   ├── components/    # Component tests
│   └── nexus/         # Nexus-specific tests
├── e2e/               # E2E tests (Playwright)
│   ├── fixtures.ts    # Test fixtures
│   └── helpers/       # E2E test helpers
├── integration/       # Integration tests
├── smoke/             # Smoke tests
├── performance/       # Performance tests
├── security/          # Security tests
└── setup.ts           # Test setup configuration
```

## Running Tests

```bash
# Unit tests
bun run test                    # All unit tests
bun run test:watch              # Watch mode
bun run test:ci                 # CI configuration

# E2E tests
bunx playwright test tests/e2e/                # All E2E
bunx playwright test tests/e2e/nexus-*.spec.ts # Nexus tests only

# Smoke tests
bun run test:smoke:atrium       # Atrium smoke tests
bun run test:smoke:atrium-render
bun run test:smoke:atrium-collab

# Performance tests
bun run test:perf               # All performance
bun run test:perf:ttft          # Time to first token
bun run test:perf:concurrent    # Concurrent streams

# Streaming tests
bun run test:streaming          # Streaming unit tests
bun run test:streaming:integration
bun run test:streaming:contract  # Contract tests
```

## Unit Tests

### Configuration

- **Framework**: Jest
- **Config**: `/jest.config.js`
- **Setup**: `/tests/setup.ts`
- **CI Config**: `/jest.config.ci.js`

### Key Test Files by Domain

**Atrium/Content**:
- `atrium-content-helpers.test.ts` - Content service helpers
- `atrium-publish-service.test.ts` - Publishing logic
- `atrium-visibility.test.ts` - Visibility filtering
- `atrium-version-snapshot.test.ts` - Versioning

**Authentication**:
- Tests in `/tests/unit/lib/auth/`

**Nexus**:
- `/tests/unit/nexus/` - Nexus-specific unit tests

**MCP**:
- `atrium-mcp-content-tools.test.ts` - MCP tool definitions
- `describe-capabilities-tool.test.ts` - Capability catalog meta-tool (#1100)

**Capabilities**:
- `/tests/unit/lib/capabilities/capability-catalog.test.ts` - Catalog projection logic (#1100)

**Email Triage (Agent Lambda)**:
- `/infra/lambdas/agent-triage-poll/dispatcher.test.ts` - Dispatcher queue logic (#1172)
- `/infra/lambdas/agent-triage-poll/learning.test.ts` - Correction-driven learning (#1172)
- `/infra/lambdas/agent-triage-poll/queue.test.ts` - SQS message handling (#1172)
- `/infra/lambdas/agent-triage-poll/sweep.test.ts` - Inbox backfill state machine (#1172)
- `/infra/lambdas/agent-triage-poll/worker.test.ts` - Per-user worker logic (#1172)

**Agent Skills**:
- `/infra/agent-image/skills/psd-canva/common.test.js` - Canva skill helpers (#1176)
- `/infra/agent-image/skills/psd-canva/run.test.js` - Canva skill runner (#1176)
- `/infra/agent-image/skills/psd-last30days/scripts/test_last30days.py` - Last30days skill (#1180)

## E2E Tests

### Configuration

- **Framework**: Playwright
- **Config**: `/playwright.config.ts`
- **Global Setup**: `/tests/e2e/global-setup.ts`
- **Fixtures**: `/tests/e2e/fixtures.ts`

### Key E2E Suites

| Suite | File | Coverage |
|-------|------|----------|
| Admin Users | `admin-users.spec.ts` | User management UI |
| Admin Capabilities | `admin-capabilities.spec.ts` | RBAC configuration |
| Admin Agents | `admin-agents.spec.ts` | Agent telemetry dashboard, iteration metrics (#1161) |
| Admin Agents Triage | `admin-agents-triage-settings.functional.spec.ts` | Triage settings UI (#1172) |
| Atrium Documents | `atrium-document.guard.spec.ts` | Document editing |
| Atrium Artifacts | `atrium-artifact.guard.spec.ts` | Artifact creation |
| Atrium Publishing | `atrium-visibility-editor.spec.ts` | Publishing workflow |
| Nexus Chat | `nexus-tools.spec.ts` | Chat functionality |
| Nexus Workspace | `nexus-workspace-panel.spec.ts` | Workspace integration |
| Assistant Architect | `assistant-architect-streaming.spec.ts` | Tool execution |
| MCP Describe Capabilities | `mcp-describe-capabilities.spec.ts` | Capability catalog meta-tool (#1100) |
| Canva Consent Page | `canva-consent-page.spec.ts` | Canva OAuth flow UI (#1176) |
| Model Compare | `model-compare-polling.spec.ts` | Dual-stream |

### E2E Test Patterns

**Guard Tests** (`.guard.spec.ts`):
- Test route protection and access control
- Verify unauthorized access is blocked

**Functional Tests** (`.functional.spec.ts`):
- End-to-end user workflows
- Full feature validation

### Running Specific E2E Tests

```bash
# Single test file
bunx playwright test tests/e2e/nexus-tools.spec.ts

# With headed browser
bunx playwright test tests/e2e/nexus-tools.spec.ts --headed

# Debug mode
bunx playwright test tests/e2e/nexus-tools.spec.ts --debug
```

## Smoke Tests

Lightweight tests to verify critical paths without full E2E overhead:

```bash
bun run test:smoke:atrium-render       # Markdown rendering
bun run test:smoke:atrium-collab       # Collaborative editing
bun run test:smoke:atrium-collab-token # Token authentication
bun run test:smoke:atrium-agent-bridge # Agent bridge functionality
bun run test:smoke:atrium-visibility   # Visibility reference
```

**Location**: `/tests/smoke/`

## Performance Tests

Test streaming performance and concurrency:

```bash
bun run test:perf:ttft          # Time to first token benchmarks
bun run test:perf:concurrent    # Concurrent stream handling
bun run test:perf:long          # Long-running streams
bun run test:perf:memory        # Memory leak detection
bun run test:perf:stress        # Stress testing
```

## Streaming Contract Tests

Verify AI SDK integration contracts:

```bash
bun run test:streaming:contract
``

These test the SSE event contracts between server and client.

## Test Utilities

### Fixtures

Located in `/tests/e2e/fixtures/` and `/tests/utils/`:

- Mock users (admin, staff, student)
- Mock conversations
- Mock content objects

### Helpers

`/tests/e2e/helpers/` contains:
- Authentication helpers
- Content creation helpers
- API request builders

### Mocks

`/tests/mocks/` contains:
- External service mocks
- AI provider mocks

## Writing Tests

### Unit Test Example

```typescript
import { describe, it, expect } from '@jest/globals';
import { contentService } from '@/lib/content/content-service';

describe('ContentService', () => {
  it('should create content with valid input', async () => {
    const result = await contentService.create(mockRequester, {
      kind: 'document',
      title: 'Test Document',
    });
    expect(result.isSuccess).toBe(true);
  });
});
```

### E2E Test Example

```typescript
import { test, expect } from '@playwright/test';

test('user can create document', async ({ page }) => {
  await page.goto('/atrium/new');
  await page.fill('[name="title"]', 'My Document');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/atrium\/[a-z0-9-]+/);
});
```

## Test Coverage

Focus areas for high coverage:

1. **Content Services** - Critical for Atrium functionality
2. **Authentication** - Security-critical path
3. **Visibility Filtering** - Permission enforcement
4. **Publishing Flow** - Multi-step workflow with approvals
5. **Streaming** - SSE event handling

## Source References

| Category | Primary Files |
|----------|---------------|
| Jest Config | `/jest.config.js`, `/jest.config.ci.js` |
| Playwright Config | `/playwright.config.ts` |
| Test Setup | `/tests/setup.ts` |
| E2E Fixtures | `/tests/e2e/fixtures.ts` |
| Testing Guide | `/docs/guides/TESTING.md` |
| Streaming Tests | `/lib/streaming/__tests__/` |

## Best Practices

1. **Use TypeScript strict types** in all tests
2. **Prefer integration tests** for server actions
3. **Use Playwright for UI workflows**
4. **Mock external services** (AI providers, AWS) in unit tests
5. **Test error paths** not just happy paths
6. **Use descriptive test names** that explain the scenario
