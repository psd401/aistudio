# AI SDK Upgrade Checklist

This document provides a systematic checklist for upgrading the Vercel AI SDK without breaking production.

**Related Issues:**
- [#366 - SDK Version Detection](https://github.com/psd401/aistudio.psd401.ai/issues/366)
- [#355 - Streaming Bug from Field Mismatch](https://github.com/psd401/aistudio.psd401.ai/issues/355)

---

## Overview

The Vercel AI SDK controls how our application streams responses from AI models. When the SDK changes, event formats may change, potentially breaking streaming in:
- ✨ Assistant Architect
- 💬 Nexus Chat
- 🔧 Tool execution flows

This checklist ensures upgrades are safe and tested.

---

## Pre-Upgrade Steps

### 1. Check Current Version

```bash
bun run check-sdk-version
```

**Expected Output:**
```
5.0.0
```

### 2. Review Release Notes

Visit the official changelog and check for:
- 🚨 **Breaking changes** (field renames, API changes)
- ⚠️ **Deprecations** (features being removed)
- ✨ **New features** (optional enhancements)
- 🐛 **Bug fixes** (may affect our workarounds)

**Resources:**
- [Vercel AI SDK Releases](https://github.com/vercel/ai/releases)
- [AI SDK Changelog](https://github.com/vercel/ai/blob/main/CHANGELOG.md)

### 3. Run Current Test Suite

Ensure all tests pass before upgrading:

```bash
bun run test:streaming
bun run test:streaming:contract
bun run typecheck
bun run lint
```

**All tests must pass before proceeding.**

---

## Upgrade Steps

### 1. Update package.json

Choose your upgrade strategy:

#### Option A: Patch Update Only (Safest)
```bash
# Updates to latest patch version (e.g., 5.0.0 → 5.0.3)
bun install ai@~5.0.0
```

#### Option B: Minor Update (Moderate Risk)
```bash
# Updates to latest minor version (e.g., 5.0.0 → 5.2.0)
bun install ai@~5.2.0
```

#### Option C: Major Update (Highest Risk)
```bash
# Updates to next major version (e.g., 5.x → 6.x)
# ⚠️ ONLY do this after completing entire checklist
bun install ai@~6.0.0
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Check for TypeScript Errors

```bash
bun run typecheck
```

**If errors appear:**
- SSE event type definitions may have changed
- Update `lib/streaming/sse-event-types.ts`
- Update compatibility adapter if needed

### 4. Run Contract Tests

These tests verify the SDK's actual behavior:

```bash
export OPENAI_API_KEY=sk-...
bun run test:streaming:contract
```

**If tests fail:**
- SSE event format has changed
- Field names may be different
- Update compatibility adapter (see Step 5)

### 5. Update Compatibility Adapter (If Needed)

If event formats changed, update the adapter:

**File:** `lib/streaming/sdk-compatibility-adapter.ts`

```typescript
// Add mappings for new SDK version
private initializeMappings(): void {
  // ... existing mappings ...

  // v6 mappings (example)
  if (this.version.major === 6) {
    const v6Mappings = new Map<string, string>([
      ['oldFieldName', 'newFieldName'], // Add actual field changes
    ]);
    this.fieldMappings.set('6', v6Mappings);
  }
}
```

### 6. Update Type Definitions (If Needed)

**File:** `lib/streaming/sse-event-types.ts`

- Add new event types if SDK added them
- Update field names if they changed
- Add deprecation comments for old fields

**Example:**
```typescript
export interface TextDeltaEvent extends BaseSSEEvent {
  type: 'text-delta';
  delta: string; // v5+
  /** @deprecated Use 'delta' instead (v4 compatibility) */
  textDelta?: string;
}
```

### 7. Run All Tests

```bash
bun run test
bun run test:streaming
bun run test:e2e
bun run typecheck
bun run lint
```

**All tests must pass.**

### 8. Manual Testing

Test critical streaming flows:

- [ ] **Assistant Architect**
  - Create new execution
  - Verify streaming appears correctly
  - Check tool calls work
  - Test error handling

- [ ] **Nexus Chat**
  - Start new conversation
  - Verify streaming responses
  - Test follow-up questions
  - Check conversation history

- [ ] **Error Scenarios**
  - Invalid API key (should show error)
  - Network timeout (should handle gracefully)
  - Invalid model (should show error message)

### 9. Deploy to Staging

```bash
# From /infra directory
cd infra
bunx cdk deploy AIStudio-FrontendStack-ECS-Dev
```

**Test in staging environment:**
- All streaming features work
- No console errors
- Performance is acceptable

### 10. Monitor Logs

Check CloudWatch logs for:
- ✅ SDK version detection messages
- ⚠️ Compatibility adapter warnings
- ❌ Parse failures or unknown event types

```bash
# Check SDK version in logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/ai-studio \
  --filter-pattern "SDK" \
  --start-time $(($(date +%s) - 3600))000 # Last hour
```

---

## Post-Upgrade

### 1. Update Documentation

Update the following if changes were made:

- `lib/streaming/sse-event-types.ts` - JSDoc comments
- This checklist - Note any new considerations
- `docs/operations/streaming-infrastructure.md` - Architecture changes

### 2. Monitor Production

After deploying to production, monitor for:

**CloudWatch Metrics:**
- Error rate (should not increase)
- Latency (should not increase significantly)
- Request count (should remain normal)

**Application Logs:**
- Unknown event type warnings
- Field mismatch errors
- Parse failures

**User Reports:**
- Streaming stops mid-response
- Missing content in responses
- Error messages appearing

### 3. Create Issue for Future Updates

Document lessons learned:

```markdown
## SDK Upgrade Notes

**Version:** 5.x → 6.x
**Date:** YYYY-MM-DD

### Changes Required:
- Field name changed: `delta` → `content`
- New event type: `reasoning-delta`
- Deprecated: `tool-call-delta`

### Issues Encountered:
- TypeScript errors in event handlers
- Had to update compatibility adapter

### Testing Notes:
- Contract tests caught the field name change
- Manual testing revealed minor UI issue
```

---

## Troubleshooting

### Issue: Contract Tests Fail

**Symptoms:**
- `text-delta` events have unexpected structure
- Missing fields that should exist

**Solution:**
1. Check SDK release notes for breaking changes
2. Update `sse-event-types.ts` to match new format
3. Add compatibility mappings in `sdk-compatibility-adapter.ts`
4. Re-run tests

### Issue: TypeScript Errors After Upgrade

**Symptoms:**
- Cannot find property errors
- Type mismatch errors

**Solution:**
1. Run `bun run typecheck` to see all errors
2. Update type definitions in `sse-event-types.ts`
3. Update code to use new field names
4. Add compatibility layer for old code

### Issue: Streaming Stops Working in Production

**Symptoms:**
- No text appears during streaming
- Console shows parse errors
- Events are silently dropped

**Solution:**
1. Check CloudWatch logs for error messages
2. Verify SDK version: `bun run check-sdk-version`
3. Test locally with same SDK version
4. Check if event format changed unexpectedly
5. Roll back if necessary: `bun install ai@<previous-version>`

### Issue: Unknown Event Type Warnings

**Symptoms:**
- Console warnings about unrecognized events
- New event types in logs

**Solution:**
1. Check if SDK added new event types
2. Update `VALID_SSE_EVENT_TYPES` in `sse-event-types.ts`
3. Add type definitions for new events
4. Update event handlers to process new types

---

## Emergency Rollback

If the upgrade causes issues in production:

### 1. Revert package.json

```bash
git checkout HEAD~1 package.json package-lock.json
```

### 2. Reinstall Dependencies

```bash
bun install
```

### 3. Rebuild and Deploy

```bash
bun run build
cd infra && bunx cdk deploy AIStudio-FrontendStack-ECS-Prod
```

### 4. Verify Rollback

- Check CloudWatch logs for SDK version
- Test streaming features
- Monitor error rates

---

## Version Pinning Strategy

We use **tilde pinning** (`~5.0.0`) to:

✅ **Allow:** Patch updates (5.0.0 → 5.0.3)
❌ **Block:** Minor/major updates without explicit action

**package.json:**
```json
{
  "dependencies": {
    "ai": "~5.0.0"
  },
  "overrides": {
    "ai": "~5.0.0"
  }
}
```

This prevents surprise breakage from automatic upgrades while allowing bug fixes.

---

## CI/CD Integration

The **SDK Version Guard** workflow automatically:

1. ✅ Detects AI SDK version changes in PRs
2. ⚠️ Warns about minor/patch updates
3. 🚫 Blocks major version changes until checklist complete
4. 🧪 Runs contract tests automatically
5. 💬 Comments on PR with required actions

**Workflow:** `.github/workflows/sdk-version-guard.yml`

---

## Quick Reference

### Commands

```bash
# Check current SDK version
bun run check-sdk-version

# Run pre-flight checks before upgrade
bun run preflight:ai-sdk-upgrade

# Run contract tests (requires API key)
bun run test:streaming:contract

# Run all streaming tests
bun run test:streaming

# Type check entire codebase
bun run typecheck
```

### Key Files

- `lib/streaming/sdk-version-detector.ts` - Version detection
- `lib/streaming/sdk-compatibility-adapter.ts` - Compatibility layer
- `lib/streaming/sse-event-types.ts` - Event type definitions
- `.github/workflows/sdk-version-guard.yml` - CI/CD guard

### Related Documentation

- [Streaming Infrastructure](./streaming-infrastructure.md)
- [Performance Testing](./PERFORMANCE_TESTING.md)
- [Vercel AI SDK Docs](https://sdk.vercel.ai/docs)

---

## Success Criteria

✅ All tests pass
✅ No TypeScript errors
✅ Staging environment works correctly
✅ Production monitoring shows no issues
✅ SDK version logged correctly
✅ Compatibility adapter handles events
✅ Documentation updated

---

**Last Updated:** 2026-01-08
**AI SDK Version:** 6.0.0
**Compatibility:** v4.x, v5.x, v6.x (with adapter)
