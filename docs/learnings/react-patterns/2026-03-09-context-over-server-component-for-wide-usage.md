---
title: Use React Context (not async server components) when a data source is consumed by 30+ files
category: react-patterns
tags:
  - branding
  - context
  - css-variables
  - next.js
  - server-components
severity: medium
date: 2026-03-09
source: auto — /work
applicable_to: project
---

## What Happened

Replacing hardcoded branding across 30+ UI references. Initial plan: make `PageBranding` an async server component that fetches settings. Abandoned because the component was already imported in 30+ client components, which cannot directly consume async server components.

## Root Cause

Async server components can only be composed by other server components or passed as children. When the consumer count is high and includes client components, wrapping each usage site is impractical.

## Solution

- `BrandingProvider` (server component) fetches branding data once at the root layout and passes it via React Context
- `useBranding()` hook consumed in any client component without prop drilling
- Brand color exposed as a CSS custom property set on the `<html>` element in root layout, so it cascades globally without JS

## Prevention

Before making a shared component async, grep its import count. If it appears in many client component files, use a root-level Provider + context hook instead. Reserve async server components for components with a small, server-side-only usage surface.
