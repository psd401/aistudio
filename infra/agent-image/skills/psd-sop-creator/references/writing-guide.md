# PSD SOP Writing Guide

How to write the content of each section. `template.md` covers structure; this
covers voice, depth, and district-specific conventions. Conventions here are
drawn from published PSD SOPs — the *Printer & Copier Allocation, Upkeep &
Maintenance* SOP is the worked example referenced throughout.

## Interview before drafting

Never draft from an underspecified request. Gather what is missing, then write.
Ask in rounds — not all at once — and stop as soon as you have enough.

**Round 1 — basics (always).**

1. What specific process needs documenting?
2. Which department owns it? (must be one of the eight in `template.md`)
3. Who is the audience — all employees, a role, building-level staff?
4. Who is the SOP's owner (a person or a role), and what is its effective date?

**Round 2 — the procedure itself (always).**

5. Walk through it step by step: what happens first, then what?
6. Are there decision points where the path branches?
7. Who is responsible at each step? Use roles, never individual names.
8. What triggers it — an event, a request, a schedule, an incident?
9. What does "done" look like?

**Round 3 — compliance and safety (when relevant).**

10. Which board policies, RCWs, WACs, or CBA sections apply?
11. What are the safety considerations or risks?
12. Who monitors compliance, how, and how often?
13. Are there related SOPs to cross-reference?

**Round 4 — complexity (only for involved procedures).**

14. Is a classification system needed (Minor / Moderate / Severe)?
15. Are there forms, checklists, or templates?
16. Which district systems are involved?

If an answer is missing and the user cannot supply it, mark the spot
`[NEEDS INPUT: what is missing]` rather than inventing a fact. An invented owner,
date, or policy number is worse than a visible gap.

## Section by section

**Title.** A specific noun phrase naming the thing being governed. "Printer &
Copier Allocation, Upkeep & Maintenance", not "Printers".

**Scope.** Exactly who and what this applies to, in one line where possible.
Real examples: "All schools and administrative buildings"; "All PSD employees and
volunteers"; "Building Administrators, Counselors, Teachers".

**Procedure.** The substance. Direct, imperative, present tense, active voice:
"The principal will…", "Staff must…", "Navigate to…". Numbered steps for
sequences; lettered sub-steps for branches; bold for critical actions and for
the label of a category being defined. State exceptions and approval
requirements explicitly — an unstated exception is the most common failure mode
in a district SOP. Where a rule is absolute, say so and say it in one sentence
("No printers or copiers may be added to any district facility outside this
allocation, regardless of funding options.").

**Safety Considerations.** Real risks and the protections against them. Write
`N/A` only when there genuinely are none — for anything touching equipment,
facilities, students, or personnel there almost always are.

**Quality Control.** Who monitors compliance, by what mechanism, how often.
Name the role and the cadence, not a vague intention: "ESS Technicians audit
clearance records quarterly", not "records are audited regularly".

**References.** Board policies, RCWs, WACs, CBA sections, dashboards, and
related SOPs. Bare titles are acceptable; a link is better.

**Revision History.** Newest first, one entry per line, `MM/DD/YYYY - II`
(initials). The first entry on a new SOP is `Created: MM/DD/YYYY - II`.

## Depth by complexity

- **Simple** (5–10 steps, one path): the seven required sections only.
- **Moderate** (branching, or a software walkthrough): add `Purpose` and/or
  `Compliance`; use sub-steps and cross-references.
- **Complex** (classifications, forms, multiple approval chains): add
  `Definitions`, a classification table, `Addendum`, and `Glossary`.

## Department patterns

- **Safety and Security** — most procedural; substantive Safety Considerations,
  never N/A; evidence-handling and law-enforcement protocols.
- **Employee Support Services** — severity classification (Minor / Moderate /
  Severe) with a table; Weingarten and Loudermill rights; escalation Building
  Principal → ESS → Legal/Superintendent.
- **Teaching and Learning** — adds Purpose, Compliance, Contact; tab-by-tab
  software walkthroughs; qualifying vs non-qualifying examples.
- **Athletics & Activities** — Roman-numeral major sections; extensive
  Definitions; funding-stream classification tables; Title IX equity.
- **Finance and Operations** — screenshot-heavy; allocation formulas; budget
  account codes.
- **Technology** — policy-oriented over step-by-step; allocation formulas;
  public-records implications; cost allocation.

## Roles and systems

Use exact role titles, never a person's name in the procedure body:
Superintendent; Chief Academic Officer (CAO); Chief of Schools; Chief
Information Officer (CIO); Chief of Finance and Operations; Executive Director
of Student Services (ESS); Director of Athletics and Activities; Director of
Facilities and Capital Projects; Transportation Director; Communications
Coordinator; ESS Paralegals; HIB Compliance Officer; Title IX Coordinator;
School Safety Officers (SSOs); Building Leadership Team (BLT).

District systems, spelled as here: Freshservice, PowerSchool, Skyward, Nav360,
RedRover, pdEnroller, ParentSquare, Google Chat, Zoom Phone, EasyAlert, Amazon
Business, Tandem, InTouch, HearMe WA, Vector, Securly, Classlink.

Commonly cited authorities: Board Policies 2150, 2153, 3207/3207P, 3241,
3246/3246P, 3510/3510P, 4120/4120P, 5100, 7320/7320-P; RCW 28A.400.303,
RCW 28A.600.485, RCW 43.09.240; WAC 296-800-130, WAC 181-85; the PEA and PSE
CBAs. Cite by number, and only when the reference actually applies.

## Images

Screenshots and diagrams from a source document must be **carried over**, not
described. A Finance or Technology SOP built from a screenshot-heavy source
loses most of its value as prose. Reference each image on its own line in the
body and pass it to `create`; the skill uploads it and rewrites the reference.
Give every image real alt text describing what it shows.

## What not to do

- Do not write raw HTML. It is dropped by the storage layer, silently.
- Do not name individuals in the procedure body. Roles outlive people.
- Do not invent policy numbers, dates, owners, or RCW citations.
- Do not leave a required section empty to "fill in later" — that is what
  `[NEEDS INPUT: …]` is for, and it stays visible.
- Do not publish. `create` makes a **private draft** on purpose; review and
  publication are a human step.
