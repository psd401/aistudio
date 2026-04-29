---
title: assistant-ui v0.12.22 exports voice hooks but no pre-built voice UI components
category: react-patterns
tags:
  - assistant-ui
  - voice
  - web-audio-api
  - audioworklet
severity: medium
date: 2026-04-09
source: auto — /work
applicable_to: project
---

## What Happened

Implemented full-screen voice mode UI for Nexus. Research referenced pre-built components (e.g., VoiceOrb) from assistant-ui, but those do not exist in the package at v0.12.22. All voice UI had to be built from scratch.

## Root Cause

Documentation or AI-generated research described components that were planned or existed in a different version. The actual package exports hooks only — no visual components for voice interaction.

## Solution

assistant-ui v0.12.22 exports these voice primitives:
- `createVoiceSession` — factory for the adapter interface `{ connect(options) => Session }`
- `useVoiceState` — current voice connection state
- `useVoiceVolume` — real-time volume level (float)
- `useVoiceControls` — connect/disconnect actions

Build all voice UI (orb, waveform, controls) as custom components consuming these hooks. Use the `composerExtraActions` slot to inject the voice trigger into `Thread` without coupling the Thread component to voice-specific imports.

## Prevention

- When adding assistant-ui voice features, verify exported symbols against the installed package before referencing any component names from docs or research.
- `grep -r "export" node_modules/@assistant-ui/react/dist` or check the package index to confirm what actually exists.
- Assume pre-built UI components do not exist unless confirmed in the dist output.
