---
type: Feature Runtime
title: Voice Mode (Gemini Live)
description: Nexus voice mode, a browser-to-Gemini-Live audio session proxied through the server WebSocket at /api/nexus/voice, with server-side availability gating, Vertex AI credentials, and transcript persistence.
tags: [voice, nexus, gemini-live, websocket, vertex-ai]
---

# Voice Mode (Gemini Live)

Voice mode lets a signed-in user talk to a Gemini Live model from the Nexus chat screen. The browser never talks to Gemini directly. It opens a WebSocket to the server, and the server authorizes the session, builds the instruction, and holds the Google credentials.
