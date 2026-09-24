---
title: Buttons rendered outside <form> trigger native submit-and-reload; FormLabel needs a FormField ancestor
category: react-patterns
tags:
  - react-hook-form
  - form-semantics
  - accessibility
  - double-submit
  - assistant-architect
severity: medium
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1697 (Assistant Architect create page) had two adjacent form-structure
defects found while fixing the main dead-button bug:

1. The `<form>` had no `onSubmit` and contained no submit button (the
   Continue / Add Field buttons are rendered outside it). It did contain a
   single text input, which is exactly the shape that triggers the browser's
   implicit-submission rule: pressing Enter in that input performed a native
   GET to the current URL with the field values as query params — a full page
   reload that silently discarded the whole draft.
2. `field-options-editor` used `<FormLabel>` with no `<FormField>` ancestor.
   After switching `useFormField` to `useFormState({ name })` (see
   `docs/guides/silent-failure-patterns.md`), a label with no owning field
   subscribed to the **entire form's** state instead of one field, causing
   unnecessary re-renders on every keystroke anywhere in the form.

Also found: double-submit created two draft assistants, because
`isSubmitting` was only set `true` **after** the async zod resolver returned,
leaving a window where a second click passed validation before the flag was
raised.

## Root Cause

- Implicit submission: a `<form>` with a text input submits on Enter unless
  it is prevented. The `<form>` here had no `onSubmit` to prevent it. Note
  that a `<textarea>` does NOT block implicit submission, and having the
  buttons outside the form is what removes the submit button — it is not
  itself the trigger.
- `FormLabel`/`FormMessage` call `useFormField()`, which reads
  `fieldContext.name`. With no `FormField` ancestor that name is `undefined`,
  and `useFormState({ name: undefined })` subscribes to the ENTIRE form. The
  label also renders `htmlFor="undefined-form-item"`, pointing at nothing.
- Async validation resolvers create a gap between "user can click again" and
  "isSubmitting is true" if the flag is set post-await instead of
  pre-validation.

## Solution

- Give the `<form>` an `onSubmit` even when submission is driven from
  buttons outside it: `onSubmit={event => event.preventDefault()}` is enough
  to kill implicit submission. (Moving the buttons inside and wiring a real
  submit handler also works, but is a bigger change.)
- Use `FormLabel` only inside a `FormField`. For inputs that are plain local
  component state rather than RHF fields, use `<Label>` from
  `@/components/ui/label` with an explicit `htmlFor`/`id` pair via `useId()` —
  that is what the fix did here.
- Set `isSubmitting = true` synchronously before calling the async resolver,
  not after it returns.

## Prevention

- When auditing a form for the shared `useFormState` re-render pattern, also
  check every `FormLabel`/`FormMessage` has a `FormField` ancestor — the
  symptom (form-wide re-renders) only appears after that fix lands, not
  before.
- Any `<form>` containing a text input needs an `onSubmit`. Grep for
  `<form` without one — especially where the actions are rendered as siblings
  of the form rather than children, since that form has no submit button and
  the defect is invisible until someone presses Enter.
