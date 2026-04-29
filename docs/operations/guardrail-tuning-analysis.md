# Guardrail Detection Analysis & Tuning Guide

> Analysis procedures and tuning strategy for Bedrock Guardrails content safety. See Issue #763 for context.

## Current State (as of Issue #763)

### Active Blocking Policies

**No policies actively block content.** As of Issue #929, all content filters have been disabled and `contentPolicyConfig` has been removed from the guardrail entirely. The guardrail operates exclusively as a detection/logging layer.

| Policy | Type | Status | Notes |
|--------|------|--------|-------|
| ~~HATE~~ | Content Filter | **REMOVED** | Issue #929 — `contentPolicyConfig` removed. 100% FP rate (3/3 blocks: 2 on large docs Issue #860, 1 on chemistry mnemonics Issue #929). Topic policies satisfy Bedrock's "at least one filter" requirement. |
| ~~PROFANITY~~ | Managed Word List | OFF (disabled) | Issue #763 — 97% of blocks, 24x rate spike. Binary on/off. |

All content safety blocking is now delegated to LLM provider built-in safety training (OpenAI, Anthropic, Google).

### Detect-Only Policies (logging, not blocking)

| Policy | Type | Notes |
|--------|------|-------|
| VIOLENCE | Content Filter | NONE since Issue #761 |
| SEXUAL | Content Filter | NONE since Issue #761 |
| INSULTS | Content Filter | NONE since Issue #761 |
| MISCONDUCT | Content Filter | NONE since Issue #761 |
| PROMPT_ATTACK | Content Filter | NONE since Issue #727 |
| Weapons | Topic Policy | Detect-only since Issue #742 |
| Drugs | Topic Policy | Detect-only since Issue #742 |
| Self-Harm | Topic Policy | Detect-only since Issue #742 |
| Bullying | Topic Policy | Detect-only since Issue #742 |

### Key Finding: PROFANITY Filter is Prime Suspect

If blocking has increased without configuration changes, the PROFANITY managed word list is the most likely cause. AWS controls this list — it cannot be tuned, only enabled or disabled. AWS does not document changes to the profanity word list.

## CloudWatch Analysis Queries

Run these in CloudWatch Logs Insights against the `/ecs/aistudio-dev` (or `-prod`) log group.

### 1. All Blocks — What's Actually Being Blocked?

```
fields @timestamp, source, blockedCategories, wordPolicyMatches, contentFilterDetails, contentLength
| filter module = "BedrockGuardrailsService"
| filter @message like "Guardrail intervened"
| sort @timestamp desc
| limit 200
```

### 2. Profanity Blocks Specifically

```
fields @timestamp, source, wordPolicyMatches, contentLength
| filter module = "BedrockGuardrailsService"
| filter @message like "Guardrail intervened"
| filter wordPolicyMatches is not empty
| sort @timestamp desc
| limit 100
```

### 3. Block Volume by Category (Trend)

```
fields @timestamp, blockedCategories
| filter module = "BedrockGuardrailsService"
| filter @message like "Guardrail intervened"
| stats count() as blockCount by blockedCategories, bin(1d) as day
| sort day desc
```

### 4. Block Volume by Source (Input vs Output)

```
fields @timestamp, source
| filter module = "BedrockGuardrailsService"
| filter @message like "Guardrail intervened"
| stats count() as blockCount by source, bin(1d) as day
| sort day desc
```

### 5. Detected-Only Topics (Not Blocked)

```
fields @timestamp, source, detectedTopics, contentLength
| filter module = "BedrockGuardrailsService"
| filter detectedTopics is not empty
| stats count() by detectedTopics, source
| sort count desc
```

### 6. Detected-Only Content Filters (Not Blocked)

```
fields @timestamp, source, detectedFilters, contentLength
| filter module = "BedrockGuardrailsService"
| filter detectedFilters is not empty
| stats count() by detectedFilters, source
| sort count desc
```

### 7. All Activity Over Time (Blocks + Detections)

```
fields @timestamp, detectedTopics, detectedFilters, blockedCategories, source
| filter module = "BedrockGuardrailsService"
| filter (detectedTopics is not empty OR detectedFilters is not empty OR blockedCategories is not empty)
| stats count() by bin(1d), source
| sort @timestamp asc
```

### 8. Suspicious Prompt Patterns (Issue #727 Monitoring)

```
fields @timestamp, patterns, contentPreview, sessionId
| filter module = "BedrockGuardrailsService"
| filter patterns is not empty
| stats count() by patterns
| sort count desc
```

## Analysis Procedure

### Step 1: Run Block Analysis

1. Run queries #1-4 above for the past 30 days
2. Compile results into this table:

| Category | Source | Total Blocks | Trend (up/down/stable) | Sample Words |
|----------|--------|-------------|------------------------|--------------|
| HATE at LOW | input | ? | ? | |
| HATE at LOW | output | ? | ? | |
| Profanity filter | input | ? | ? | ? |
| Profanity filter | output | ? | ? | ? |

### Step 2: Classify Blocks

For each blocked item, classify as:
- **True positive**: Content genuinely inappropriate for K-12
- **False positive — Educational**: Legitimate educational content (e.g., literature with strong language)
- **False positive — Professional**: Staff documentation with clinical/behavioral language
- **Ambiguous**: Needs human judgment

### Step 3: Calculate False Positive Rates

```
FP Rate = (False Positives) / (Total Blocks) x 100
```

| Threshold | Action |
|-----------|--------|
| FP < 10% | Safe to keep current settings |
| FP 10-25% | Consider reducing filter strength or disabling |
| FP > 25% | Disable or replace with application-layer filtering |

### Step 4: Analyze Detect-Only Data

Run queries #5-6 to understand what detect-only policies are catching:
- Are topics detecting legitimate educational content? (Expected based on prior FP history)
- Are any topics showing primarily true positive detections? (Candidates for re-enabling)
- What content filter categories would trigger if re-enabled?

## Tuning Options

### Option A: Disable PROFANITY Managed Word List

**When**: If profanity blocks have high FP rate on educational content (literature, behavioral docs).

```typescript
// In guardrails-stack.ts — remove the wordPolicyConfig section entirely
// wordPolicyConfig: {
//   managedWordListsConfig: [{ type: 'PROFANITY' }],
// },
```

**Tradeoff**: Students could use profanity in prompts without being blocked. LLM safety training still prevents the AI from generating profane responses.

### Option B: Asymmetric Input/Output Filtering

**When**: False positives are primarily on AI outputs (educational responses), not user inputs.

```typescript
// Block on input only — users can't send profanity, but AI can discuss topics freely
// NOTE: Bedrock managed word lists don't support asymmetric input/output config.
// This option only works for content filters:
{ type: 'HATE', inputStrength: 'LOW', outputStrength: 'NONE' }
```

### Option C: Upgrade to STANDARD Tier

**When**: Need better classification accuracy and longer topic definitions.

**Benefits**:
- Topic definitions increase from 200 to 1,000 characters
- "More robust, consistent, reliable" detection
- Better contextual understanding reduces FPs
- 60+ language support

**Requirements**:
- Cross-region inference must be configured
- Test thoroughly — "strengthened defense" means more detections, not fewer
- PROMPT_ATTACK behavior may change (verify Issue #727 FPs still resolved)

```typescript
// Add to both contentPolicyConfig and topicPolicyConfig:
// tierConfig: { tierName: 'STANDARD' }
// NOTE: Requires crossRegionConfig on the guardrail
```

**Risk**: STANDARD tier's "strengthened" detection could INCREASE false positives initially. Test in dev extensively before production.

### Option D: Application-Layer Pre-Filtering

**When**: Bedrock filters are too coarse for K-12 educational context.

Add context-aware filtering in `bedrock-guardrails-service.ts` that considers the educational context before sending to Bedrock:
- Detect educational keywords (PBIS, SEL, Danielson, curriculum)
- Skip guardrails for known-safe content patterns
- Apply stricter checks only when educational context is absent

### Option E: Selectively Re-Enable Topics

**When**: Detection data shows a topic has < 10% false positive rate.

Re-enable one topic at a time with monitoring:
1. Change `inputAction: 'NONE'` to `inputAction: 'BLOCK'` for the target topic
2. Deploy to dev
3. Monitor for 1 week
4. If FP rate acceptable, promote to prod
5. Repeat for next topic

## Post-Tuning Monitoring

After any guardrail change, monitor for 1 week:

1. **Daily**: Run query #3 to check block volume trend
2. **Daily**: Check SNS email notifications for unexpected blocks
3. **Day 3**: Run full analysis (queries #1-8)
4. **Day 7**: Calculate FP rate and decide whether to keep, adjust, or rollback

## STANDARD Tier Migration Checklist

If migrating from CLASSIC to STANDARD tier:

- [ ] Review all topic definitions — can now use up to 1,000 chars
- [ ] Test PROMPT_ATTACK behavior — may re-introduce Issue #727 FPs
- [ ] Configure cross-region inference profile
- [ ] Run full manual test suite (see k12-content-safety.md)
- [ ] Deploy to dev first, monitor 1 week
- [ ] Compare detection rates: STANDARD vs CLASSIC baseline
- [ ] Promote to prod only after dev validation

## AWS Opacity Note

AWS does not publish changelogs for Bedrock Guardrails classifier model updates. If blocking behavior changes without configuration changes, possible explanations:
1. AWS updated the underlying classifier model silently
2. User content patterns changed (new use cases, different vocabulary)
3. AWS updated the PROFANITY managed word list

There is no way to pin a specific classifier version. The only mitigation is detect-only mode for policies prone to false positives, which is the current configuration.

## SNS Notification Policy

**Issue #929**: Detect-only detections no longer trigger SNS email notifications. Previously, each detect-only topic and content filter detection generated an individual SNS publish call on both input and output evaluation — up to 4 emails per user message. This flooded the notification channel with non-actionable telemetry.

- **Actual blocks**: Still trigger SNS notification (if blocking is re-enabled in the future)
- **Detect-only detections**: Logged to CloudWatch only — use Logs Insights queries above for monitoring
- **CloudWatch is the correct channel** for high-volume detection telemetry; SNS email is for actionable alerts

## Related Issues

- #639 — INSULTS/MISCONDUCT lowered from MEDIUM to LOW
- #727 — PROMPT_ATTACK disabled (75% FP rate)
- #731 — Max 5 examples per topic
- #742 — Topic policies switched to detect-only mode
- #761 — Content filters switched to detect-only mode
- #763 — This analysis and tuning strategy
- #860 — HATE output set to NONE (100% FP rate on output)
- #929 — HATE input set to NONE, contentPolicyConfig removed, detect-only SNS flood fixed
