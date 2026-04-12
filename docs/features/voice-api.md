# Voice API

Real-time voice conversations via WebSocket proxy to Gemini Live API.

**Issue #872** — Nexus Voice Mode (Epic Issue 1 of 5)

## Endpoints

### GET /api/nexus/voice/availability

Returns voice availability with reason string for user-facing messages. Issue #876.

**Auth:** Requires authenticated session.

**Response (200):**
```json
{
  "available": false,
  "reason": "Voice mode is disabled by administrator"
}
```

Possible reasons:
- `"Voice mode is disabled by administrator"` — VOICE_ENABLED is not "true"
- `"Voice mode is not enabled for your role"` — User lacks voice-mode tool access
- `"Voice mode is not currently available"` — Provider or API key not configured (details logged server-side only)

**Caching:** Response includes `Cache-Control: max-age=30, private`. After an admin
toggles `VOICE_ENABLED` or changes role assignments, individual users may see stale
availability for up to 30 seconds (HTTP cache) plus up to 5 minutes (server-side
settings cache TTL) — worst case ~5.5 minutes total. WebSocket connections check
availability at connect time and are not affected by the HTTP cache.

**Active sessions:** The availability check runs only at connection time. Disabling
voice via the kill switch blocks new connections immediately but does **not** terminate
sessions already in progress. Users on active voice sessions retain access until their
current session ends naturally.

**Error responses:**
- `401` — No authenticated session
- `500` — Internal server error

### WebSocket /api/nexus/voice

Bidirectional audio streaming for real-time voice conversations.

**Auth:** Session cookie (Auth.js encrypted JWT) validated on upgrade. Centralized `getVoiceAvailability()` checked before session starts.

**Origin:** Validated against `ALLOWED_ORIGINS` env var, `NEXTAUTH_URL`, or same-origin fallback.

**Close codes:**
- `4001` — Unauthorized (invalid/missing session)
- `4003` — Forbidden (admin disabled voice, or user lacks voice-mode permission)
- `4500` — Server error — with distinct close reasons:
  - `"Provider not configured"` — provider/model/API key not configured
  - `"Availability check failed"` — transient error (e.g., DB timeout) during availability check

#### Connection Flow

```
1. Client → Server: WebSocket upgrade request (with session cookie)
2. Server validates JWT, checks hasToolAccess("voice-mode")
3. Server connects to Gemini Live API
4. Server → Client: { type: "ready" }
5. Client → Server: { type: "audio", data: "<base64 PCM16 16kHz mono>" }
6. Server ↔ Gemini: Bidirectional audio proxy
7. Server → Client: audio, transcripts, state changes
8. Client → Server: { type: "disconnect" } to end session
```

#### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `audio` | `data: string` (base64) | PCM16 16kHz mono audio chunk. Max 128KB base64 per message. Rate limited to 50 msgs/sec. |
| `disconnect` | — | Request graceful session end |

**Important:** Do not send audio before receiving `{ type: "ready" }`.

#### Server → Client Messages

| Type | Fields | Description |
|------|--------|-------------|
| `ready` | — | Provider connected, ready for audio |
| `audio` | `data: string` (base64) | Model speech audio (PCM) |
| `transcript` | `entry: { role, text, isFinal, timestamp }` | Speech-to-text transcript |
| `state` | `speaking: "user" \| "assistant" \| "none"` | Turn state change |
| `error` | `message: string` | Error description |
| `session_ended` | `reason: string` | Session terminated (`"finished"` or `"cancelled"`) |

## Configuration

Voice settings are managed via the Settings admin UI or environment variables:

| Setting | Default | Description |
|---------|---------|-------------|
| `VOICE_ENABLED` | `false` | Global kill switch — must be `"true"` to enable voice |
| `VOICE_PROVIDER` | — | Voice provider ID (e.g., `gemini-live`) |
| `VOICE_MODEL` | — | Gemini Live model ID |
| `VOICE_LANGUAGE` | `en-US` | BCP47 language code |
| `VOICE_NAME` | — | Provider voice name (e.g., "Aoede") |

The Google API key is read from `GOOGLE_API_KEY` via `Settings.getGoogleAI()` and never sent to the client.

## Permissions (Issue #876)

Voice mode uses the existing `hasToolAccess()` permission system:

- **Tool identifier:** `voice-mode`
- **Default:** Not assigned to any role (opt-in rollout)
- **Admin control:** Admin > Role Management > Tool Assignments
- **Global kill switch:** `VOICE_ENABLED` setting (Admin > System Settings > Voice Mode tab)

The centralized `getVoiceAvailability(cognitoSub)` utility in `/lib/voice/availability.ts` checks all conditions:
1. Global `VOICE_ENABLED` setting
2. User has `voice-mode` tool access
3. Voice provider and model configured
4. Google API key present

## Infrastructure

- ALB natively supports WebSocket — no config changes needed
- 300s idle timeout on ALB; server sends keepalive ping every 240s
- WebSocket connections are persistent — no sticky sessions required
- TLS terminated at ALB; backend receives plain WS on port 3000
