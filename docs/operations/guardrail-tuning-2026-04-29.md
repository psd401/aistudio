# Bedrock Guardrails — 24h Detection Analysis & Tuning Recommendations

**Date**: 2026-04-29
**Window**: Last 24 hours (rolling, captures post-deploy spike from 2026-04-28 guardrails update)
**Scope**: AI Studio dev (`/ecs/aistudio-dev`) + prod (`/ecs/aistudio-prod`)
**Author**: Generated during PR #930 review

## Executive summary

- **Prod volume**: ~253 input evaluations + ~253 output evaluations in 24h, producing **146 detection events**. That is a **~28% detection rate per evaluation cycle**, or roughly 1 in every 1.7 user turns triggering a detection.
- **Single biggest finding**: ~86% of detections fire **all four topics simultaneously** (Weapons + Drugs + Self-Harm + Bullying). Definitions are not discriminating between concepts — they are co-firing on a single signal ("possibly sensitive content"). This is signature of overlapping definitions interpreted by the underlying ML classifier as one bucket.
- **Volume spike**: 80 events in a single hour (02:00 UTC) — likely one extended user/session generating most of the day's noise. Content lengths in that window range from 11 chars to 90,525 chars; length is not the trigger.
- **Dev volume**: only ~14 detection events in 24h. Same all-4-co-fire pattern but at much lower absolute volume.
- **Conclusion**: With a 28% detection rate and 86% all-four co-fire, the current guardrail signal is **near-useless for blocking** and **noisy for analytics**. Tuning is required before any move toward enforcement.

## Detection counts (prod, 24h)

| Pattern | Count | % of detections |
|---|---:|---:|
| All 4 topics co-fire (any order, INPUT or OUTPUT) | ~125 | ~86% |
| Single topic (Bullying / Drugs / Self-Harm / Weapons) | ~17 | ~12% |
| Two-topic combos | ~4 | ~2% |
| **Total** | **146** | **100%** |

By single-topic detections (the actually-discriminating events):

| Topic | Single-topic events |
|---|---:|
| Self-Harm | 6 |
| Bullying | 5 |
| Weapons | 3 |
| Drugs | 1 |
| Bullying+Weapons | 2 |

By source:

| Source | Co-fire-all-4 | Single/dual | Total |
|---|---:|---:|---:|
| INPUT | ~62 | ~10 | ~72 |
| OUTPUT | ~63 | ~11 | ~74 |

INPUT and OUTPUT detections occur at roughly equal rates — consistent with the "any sensitive-adjacent content trips all four" hypothesis (since model outputs about sensitive topics fire just like user inputs about them).

## Hourly distribution (prod)

```
2026-04-28 17:00 UTC    1
2026-04-28 18:00        4
2026-04-28 19:00        7
2026-04-28 21:00        2
2026-04-29 01:00        3
2026-04-29 02:00       80   ← single-session spike
2026-04-29 03:00        8
2026-04-29 04:00        4
2026-04-29 05:00       15
2026-04-29 07:00        2
2026-04-29 13:00        4
2026-04-29 14:00        6
2026-04-29 15:00        9
```

The 02:00 spike (80 events / hour, ~10x baseline) is consistent with one user holding an extended session on sensitive-adjacent content. Without input text in logs (correctly redacted), we can't confirm intent, but the request-ID stream shows variable content lengths (11 → 90K chars), so it's not a single repeated query.

## Why the all-4-co-fire pattern is the real problem

Bedrock's topic policy uses an ML classifier seeded by your `definition` text + `examples`. When four definitions all describe variants of "harmful content directed at people," the classifier learns a single internal representation and fires all four when *any* of them would have fired. Co-fire rate is the diagnostic.

Confirming details from `infra/lib/guardrails-stack.ts`:

| Topic | Definition (verbatim) | Length |
|---|---|---:|
| Weapons | `Content about weapons, firearms, explosives, or how to make weapons` | 67 |
| Drugs | `Content promoting or instructing about illegal drug use or substance abuse` | 74 |
| Self-Harm | `Content that promotes, instructs, or glorifies self-harm, suicide, or eating disorders. Targets instructional or promotional content, not educational discussions or behavioral documentation.` | 190 |
| Bullying | `Instructions or encouragement for bullying, harassing, or intimidating individuals. Targets promotional content, not educational discussions about anti-bullying or behavior documentation.` | 187 |

Self-Harm and Bullying already attempted to scope-limit ("not educational discussions") and still co-fire 86% of the time. The CLASSIC tier 200-char limit is the binding constraint on writing more discriminating definitions.

## Recommendations (priority-ordered)

### R1 — Move to STANDARD tier with cross-region inference (highest leverage)

CLASSIC tier limits definitions to 200 chars. STANDARD tier allows 1,000 chars. That's the single biggest tuning lever and the only way to write definitions that meaningfully distinguish "harmful instruction" from "educational discussion of harm" within the definition itself, instead of relying on examples alone.

**Tradeoff**: STANDARD requires cross-region inference (latency + slightly higher cost). For a K-12 platform serving sensitive educational content, accuracy is worth it.

**Action**: Cost / latency analysis, decision, and stack change.

### R2 — Collapse to 2 topics (or even 1) until precision improves

Co-fire rate of 86% means we don't actually have 4 independent signals. We have 1. Suggested consolidation:

- **HarmInstruction** (consolidates current Weapons + Drugs + Self-Harm + Bullying *instruction/encouragement* angle)
  - Definition focused on *how-to* / *encouragement* / *targeting* language
  - Examples drawn from current weapons/drugs/self-harm/bullying examples
- Optionally a separate **PIIExposure** topic if we want non-Comprehend coverage

This gives us a cleaner detection signal we can actually act on, instead of 4 indistinguishable channels.

**Action**: Decide. Could ship as a follow-up PR after STANDARD-tier move (R1).

### R3 — Drop the per-detection SNS notification path entirely

PR #930 already removes SNS for detect-only events. After deploy, validate by re-running this same query — if SNS volume is still elevated, audit the call sites again.

**Action**: Already in PR #930. Verify after merge.

### R4 — Remove "version":"unknown" placeholder in log records

Detection log records show `"version":"unknown"`. Either populate with deploy SHA or drop the field. Hygienic, low priority.

**Action**: Trivial follow-up.

### R5 — Sample inputs for FP/TP labeling (privacy-aware)

We currently have NO ability to inspect what triggered a detection because input text is correctly redacted from logs. To actually tune topic definitions toward production reality, we need a privacy-respecting sampling mechanism:

- Option A: Log a SHA-256 of input + first/last 50 chars only when a detection fires (low PII leak, allows clustering)
- Option B: A separate authenticated admin tool that fetches a single triggering input by request-ID for review (audit-logged, role-restricted)
- Option C: Synthetic eval — build a labeled dataset of K-12 educational content and run it through the guardrail offline to tune

Without one of these, every tuning pass is blind. **This is the most important recommendation for sustained tuning.**

**Action**: New issue against epic — captured in PR #930 comment as a follow-up.

### R6 — Until R1+R2 ship, treat current detect-only data as low-signal

Do not build dashboards, alerting, or compliance reports off the current detection stream — the 86% co-fire rate means the data largely measures "user touched a sensitive-adjacent topic," not "user did something concerning." Wait for tuned definitions before consuming the signal downstream.

**Action**: Communicate to anyone monitoring guardrail dashboards.

## Concrete checklist (when ready to apply, after R1 decision)

- [ ] Migrate guardrail to STANDARD tier with cross-region inference
- [ ] Collapse 4 topics → 1 (HarmInstruction) or 2 (HarmInstruction + Targeting)
- [ ] Rewrite consolidated definition using full 1,000-char budget with explicit educational-context exclusion language
- [ ] Refresh examples — pick 5 maximum diverse examples per topic
- [ ] Implement input-sampling mechanism (R5) before next tuning iteration
- [ ] Validate post-tune: detection rate target < 5% of evaluation cycles, single-topic events > 80% of detections, FP rate (manual review of 20 random events) < 20%
- [ ] Only then consider moving any topic from detect-only to BLOCK

## Open questions

- Is the 02:00 UTC spike one user, or a script? (Need request-ID → user-ID correlation)
- What's the cost / latency delta for STANDARD tier with cross-region inference at our volume?
- Should output guardrails be different from input guardrails? (Currently identical settings; output is generated by safety-trained models so detection there mostly catches our prompt → model echo)
- Do we run guardrail evaluation on every model call, or only specific endpoints? (Affects volume / cost calculus)

## References

- PR #930 — removes contentPolicyConfig, suppresses SNS for detect-only
- Issue #929 — HATE filter false positive on chemistry mnemonics
- `infra/lib/guardrails-stack.ts` — current topic definitions
- `lib/safety/bedrock-guardrails-service.ts` — detection log emitters
- Memory: CLASSIC tier 200 char limit; STANDARD 1,000 char with cross-region inference
- Memory: 8-issue progressive disablement history (#639, #727, #731, #742, #761, #763, #860, #929)
