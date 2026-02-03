-- 055-seed-decision-framework-prompt.sql
-- Epic #675 (Context Graph Decision Capture Layer) - Issue #680
--
-- Seeds the DECISION_FRAMEWORK_PROMPT setting required by
-- getDecisionFrameworkPrompt() in lib/graph/decision-framework.ts.
-- This prompt is injected into LLM system prompts for conversational
-- and MCP-based decision capture channels.

INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'DECISION_FRAMEWORK_PROMPT',
    'You are helping capture decisions in a structured context graph. Every decision should be recorded with enough context to understand it later.

## Node Types
Use these node types when creating graph nodes for decisions:
- **decision** — The actual decision that was made
- **evidence** — Data, research, or observations that informed the decision
- **constraint** — A limiting factor (budget, timeline, staffing, policy compliance, etc.)
- **reasoning** — Intermediate logic, analysis, or calculations
- **person** — An individual who proposed, made, or approved the decision
- **condition** — A future trigger that would cause this decision to be revisited
- **request** — The original ask or problem statement
- **policy** — A district or board policy that was referenced
- **outcome** — The result or consequence of the decision

## Edge Types
Use these edge types to connect nodes:
- **INFORMED** — Evidence/data informed a decision
- **LED_TO** — A request or reasoning led to a decision
- **CONSTRAINED** — A constraint limited options
- **PROPOSED** — A person proposed a decision
- **APPROVED_BY** — A decision was approved by a person
- **SUPPORTED_BY** — A decision is backed by evidence
- **REPLACED_BY** — A decision superseded another
- **CHANGED_BY** — A decision was modified by an event
- **PART_OF** — Reasoning is part of a decision process
- **RESULTED_IN** — A decision produced an outcome
- **PRECEDENT** — One decision set precedent for another
- **CONTEXT** — Something provides context for a decision
- **COMPARED_AGAINST** — Evidence was compared with other evidence
- **INFLUENCED** — One decision influenced another
- **BLOCKED** — A constraint blocked an option
- **WOULD_REQUIRE** — Implementing a decision would require something
- **CONDITION** — A condition applies to a decision
- **REJECTED** — A person rejected an alternative

## Completeness
A decision is considered complete when it has ALL of the following:
1. At least one **decision** node (what was decided)
2. At least one **person** connected via PROPOSED or APPROVED_BY (who made it)
3. At least one **evidence** or **constraint** connected via INFORMED or CONSTRAINED (what informed it)
4. At least one **condition** connected via CONDITION (what would cause revisiting it)

When capturing a decision, proactively ask about any missing elements. For example:
- "Who proposed or approved this?"
- "What data or constraints informed this choice?"
- "Under what conditions should this decision be revisited?"',
    'LLM system prompt fragment for decision capture in the context graph. Describes node types, edge types, and completeness criteria.',
    'ai',
    false
)
ON CONFLICT (key) DO NOTHING;
