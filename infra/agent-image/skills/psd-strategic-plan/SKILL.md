---
name: psd-strategic-plan
summary: Answer questions about Peninsula 2030, PSD's 2026-2030 strategic plan, mission, vision, values, goals, objectives, academic excellence, innovation, fiscal responsibility, learning environment, community partnership and engagement, plan alignment, priorities, and strategic metrics by searching AI Studio repository 166.
description: Use for questions, explanations, summaries, comparisons, planning alignment, presentations, writing, initiatives, measures, or decisions related to Peninsula School District's Peninsula 2030 strategic plan. Repository 166 is the definitive, updateable source; the bundled plan text is only a fallback snapshot.
allowed-tools: Bash(node:*) Read
---

# PSD Strategic Plan

Use the live, public AI Studio repository as the definitive source:

- Name: `PSD Strategic Plan 2026-2030`
- Repository ID: `166`
- URL: `https://aistudio.psd401.ai/repositories/166`

The repository may gain guides, implementation details, measures, and updated
files without an agent-image rebuild. Always search it before answering from
the bundled fallback or memory.

## Required workflow

1. Confirm that the definitive repository is accessible:

   ```bash
   node /opt/psd-skills/psd-aistudio/run.js repositories-describe \
     --repository-id 166
   ```

2. Search only repository 166 with terms from the user's question:

   ```bash
   node /opt/psd-skills/psd-aistudio/run.js repositories-search \
     --query "<specific strategic-plan question or topic>" \
     --repository-ids 166 --mode hybrid --limit 8
   ```

3. For broad comparisons or exact goal language, run additional focused
   searches rather than treating one excerpt as the whole plan. Keep every
   search pinned to `--repository-ids 166`.
4. Answer from retrieved content and retain its source citations or locators.
   Identify recommendations and interpretations as analysis, not plan text.
5. If repository 166 is temporarily unavailable or has no indexed result, read
   `/opt/psd-skills/psd-strategic-plan/references/strategic-plan.md` and clearly
   label the answer as based on the bundled fallback snapshot. Never substitute
   a different repository.

## Metrics and implementation questions

Repository 166 remains the source for strategic definitions, goals, guidance,
and any metrics stored there. If the user asks for a current measured value
that is not present in repository 166, use `psd-data` to discover the live,
permission-filtered warehouse tables. Keep the distinction clear:

- repository 166 explains what the plan says and how a metric is defined;
- `psd-data` supplies current operational values when available;
- your recommendation or alignment analysis is not official plan language.

## Rules

1. **Use only repository 166 for live strategic-plan knowledge.** Do not select
   repositories by name and do not search all repositories.
2. **Prefer repository content over the fallback.** If a newer repository item
   conflicts with the bundled snapshot, use the repository and note the newer
   source.
3. **Do not invent measures or commitments.** Never create a KPI, target,
   owner, budget, timeline, or completion status that the sources do not state.
4. **Separate source from application.** Clearly label proposed initiatives,
   mappings, examples, and recommendations as analysis.
5. **Protect student information.** Use aggregated, permission-filtered data
   for metrics unless the user is authorized and genuinely needs row-level
   detail.
