---
title: An ambient `declare module "pkg"` shadows a real package's exports unless the .d.ts is a module
category: tooling
tags:
  - typescript
  - ambient-declarations
  - module-augmentation
  - declare-module
  - tiptap
  - atrium
severity: medium
date: 2026-06-26
source: manual — #1051 Atrium Phase 1 TipTap integration
applicable_to: general
---

## What Happened

Added `types/tiptap-markdown.d.ts` to type the untyped `tiptap-markdown` package
and to augment `@tiptap/core`'s `Storage` interface with `markdown.getMarkdown()`.
Immediately, every real `@tiptap/core` import failed: `Module '"@tiptap/core"' has
no exported member 'Mark' | 'mergeAttributes' | 'Extensions' | 'JSONContent' |
'getSchema'` — even though those ARE exported.

## Root Cause

The `.d.ts` had no top-level `import`/`export`, so TypeScript treated the whole
file as a **global script**, not a module. In a global script,
`declare module "@tiptap/core" { … }` is read as a *declaration* of that module's
shape (which **shadows/replaces** the real types), not an *augmentation* of it. The
shadow exposed only the `Storage` interface I declared, hiding every real export.

## The Fix

Make the `.d.ts` a module by adding a top-level `export {}`. Then
`declare module "@tiptap/core" { interface Storage { … } }` is a proper module
augmentation that **merges** into the real package, and
`declare module "tiptap-markdown" { … }` still declares the missing types for the
untyped package. One line fixed all 11 collab type errors.

```ts
// types/tiptap-markdown.d.ts
export {}; // <-- makes this a module so the blocks below AUGMENT, not SHADOW
declare module "tiptap-markdown" { export const Markdown: Extension; }
declare module "@tiptap/core" { interface Storage { markdown: { getMarkdown(): string } } }
```

## Rule

Any `.d.ts` that augments an existing package (`declare module "real-pkg"`) MUST be
a module — add `export {}` if it has no other top-level import/export. Reserve the
script form only for declaring genuinely-absent packages, and even then prefer the
module form to avoid accidental shadowing.
