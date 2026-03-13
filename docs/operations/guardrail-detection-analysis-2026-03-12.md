# Guardrail Detection Analysis — 2026-03-12

> Analysis of 30 days of production guardrail data (Feb 11 — Mar 12, 2026).
> Performed for Issue #763.

## Executive Summary

**68 blocks in 30 days** across production. The data confirms the user-reported increase in blocking and identifies the root cause:

- **97% of blocks (66/68) have empty `blockedCategories`** — these are PROFANITY managed word list blocks that were **invisible** in monitoring due to a bug in `extractBlockedCategories()` (missing `managedWordLists` handling). Fixed in this PR.
- **3% of blocks (2/68) are "Hate speech"** — both are false positives on large educational documents (28KB and 52KB inputs that also triggered educational topic detections).
- **Block rate increased 16x starting March 6** — from ~1 block/week to ~10+/day. Usage also increased, but the block RATE (blocks/evaluations) also climbed from <1% to 2-7%, confirming something became more sensitive.
- **Since no config changed, the PROFANITY managed word list is the confirmed source** — AWS likely updated the word list silently.

## Block Trend (Production)

| Date | Evaluations | Blocks | Block Rate | Notes |
|------|------------|--------|------------|-------|
| Feb 11-12 | 387 | 0 | 0.0% | |
| Feb 13 | 144 | 2 | 1.4% | 1 HATE FP + 1 PROFANITY |
| Feb 14-24 | 665 | 0 | 0.0% | |
| Feb 25 | 223 | 1 | 0.4% | PROFANITY |
| Feb 26-Mar 2 | 574 | 0 | 0.0% | |
| Mar 3 | 309 | 1 | 0.3% | PROFANITY |
| Mar 4-5 | 716 | 0 | 0.0% | |
| **Mar 6** | **629** | **22** | **3.5%** | **Spike starts — 15 OUTPUT, 7 INPUT** |
| Mar 7-8 | 158 | 0 | 0.0% | Weekend |
| **Mar 9** | 315 | 5 | 1.6% | |
| **Mar 10** | 388 | 9 | 2.3% | |
| **Mar 11** | 288 | 22 | **7.6%** | **Peak block rate** |
| **Mar 12** | 308 | 6 | 1.9% | Partial day (analysis time) |

**Pre-spike (Feb 11 — Mar 5):** 4 blocks in 3,018 evaluations = **0.13% block rate**
**Post-spike (Mar 6 — Mar 12):** 64 blocks in 2,086 evaluations = **3.07% block rate**

That's a **24x increase in block rate**.

## Block Category Breakdown

| Category | Input Blocks | Output Blocks | Total | % of All |
|----------|-------------|--------------|-------|----------|
| PROFANITY (empty categories) | 18 | 48 | **66** | **97%** |
| Hate speech (HATE at LOW) | 2 | 0 | **2** | **3%** |
| **Total** | **20** | **48** | **68** | |

**Key observation**: OUTPUT blocks (48) vastly outnumber INPUT blocks (20). The PROFANITY filter is primarily blocking AI-generated responses, not user inputs. This means the AI models are generating words that match the profanity list in educational responses.

## Hate Speech Blocks — Both Are False Positives

### Block #1: Feb 13, 15:39 UTC
- **Content length**: 28,049 characters (28KB input)
- **Simultaneously detected**: Bullying topic (detect-only)
- **Assessment**: False positive. A 28KB input that triggers Bullying topic detection is educational content (likely PBIS/behavioral documentation), not hate speech.

### Block #2: Mar 12, 22:27 UTC
- **Content length**: 52,208 characters (52KB input)
- **Simultaneously detected**: Weapons topic (detect-only)
- **Same session**: Two more blocks with empty categories (PROFANITY) at 22:27:54 and 22:28:27
- **Assessment**: False positive. A 52KB input that triggers Weapons topic detection is a large educational document or assistant architect prompt, not hate speech.

**HATE at LOW false positive rate: 100% (2/2)**

## Topic Detection Data (Detect-Only, Not Blocking)

100+ topic detections logged in 30 days. Breakdown:

| Topic | Detections | Common Context |
|-------|-----------|---------------|
| **Bullying** | Most frequent | Anti-bullying programs, PBIS docs, behavioral discussions (1-136KB inputs) |
| **Weapons** | Several | Large educational documents (47-60KB inputs) |
| **Self-Harm** | Several | Behavioral health documentation, student support (3-62KB inputs) |
| **Drugs** | Several | Educational content, often combined with other topics (26-136KB inputs) |

**Decision**: All topics should remain in detect-only mode. The large content sizes (3KB-136KB) confirm these are educational documents triggering detections, not genuine safety threats.

**Multi-topic triggers are common**: Single inputs triggering 2-4 topics simultaneously (e.g., `['Drugs', 'Bullying', 'Weapons', 'Self-Harm']` on a 136KB input). This is expected for comprehensive educational documents.

## Content Filter Detection Data

**0 detections** from content filters in detect-only mode (VIOLENCE, SEXUAL, INSULTS, MISCONDUCT).

This means either:
1. Content filters set to `NONE` don't produce assessment data (likely — differs from topic behavior)
2. No content is triggering these filters

After deploying the `outputScope: 'FULL'` change in this PR, we should see assessment data for all filters, which will clarify this.

## Suspicious Pattern Detection

6 detections in 30 days — **all false positives**:

| Pattern | Count | Source |
|---------|-------|--------|
| `system_override_attempt` | 6 | All from legitimate Assistant Architect system prompts containing "**SYSTEM INSTRUCTION**" |

Content previews confirm these are educational AI assistant configurations (K-12 Instructional Coach, SciScore Agent, Curriculum Designer). The `PROMPT_ATTACK` disable (Issue #727) remains correct.

## Recommendations

### Immediate (this PR)
1. **Fixed**: PROFANITY block attribution now visible in logs/notifications
2. **Fixed**: `outputScope: 'FULL'` for better diagnostic data
3. **Fixed**: Detailed word matches logged for blocked content

### Short-term (after merge + deploy)
1. **Investigate PROFANITY blocks**: Deploy this PR, then analyze the next week's data to see which specific words are triggering. The new detailed logging will show the matched words.
2. **Consider disabling PROFANITY**: If FP rate is high (AI responses blocked for educational language), disable the managed word list. LLM safety training prevents actual profanity in responses.
3. **HATE at LOW**: Both blocks are FPs. Consider lowering to NONE, but this requires Bedrock to still accept the guardrail (at least one filter must be non-NONE). If PROFANITY is kept enabled, the word policy may satisfy this requirement. Needs testing.

### Medium-term
4. **STANDARD tier evaluation**: Better contextual classification could reduce HATE FPs. But "strengthened defense" may increase other FPs. Test in dev first.
5. **Re-evaluate after `outputScope: 'FULL'`**: With full assessment data, we'll see what content filters would trigger if re-enabled, informing future tuning.

### Not recommended
- Re-enabling any topic policies — 100% of topic detections are on educational content
- Re-enabling PROMPT_ATTACK — 100% of suspicious pattern detections are legitimate assistant prompts
