# Voice API

Real-time voice conversations via WebSocket proxy to Gemini Live API.

**Issue #872** — Nexus Voice Mode (Epic Issue 1 of 5)

## Endpoints

### GET /api/nexus/voice

Returns voice configuration and availability. Clients call this before attempting a WebSocket connection.

**Auth:** Requires authenticated session + `voice-mode` tool access.

**Response (200):**
```json
{
  "available": true,
  "provider": "gemini-live",
  "model": "gemini-2.0-flash-live-001",
  "language": "en-US",
  "wsEndpoint": "/api/nexus/voice"
}
```

**Error responses:**
- `401` — No authenticated session
- `403` — User lacks `voice-mode` tool access
- `500` — Internal server error

### WebSocket /api/nexus/voice

Bidirectional audio streaming for real-time voice conversations.

**Auth:** Session cookie (Auth.js encrypted JWT) validated on upgrade. `hasToolAccess("voice-mode")` checked before session starts.

**Origin:** Validated against `ALLOWED_ORIGINS` env var, `NEXTAUTH_URL`, or same-origin fallback.

**Close codes:**
- `4001` — Unauthorized (invalid/missing session)
- `4003` — Forbidden (no voice-mode access)
- `4500` — Server error (provider unavailable, config missing)

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
| `VOICE_PROVIDER` | `gemini-live` | Voice provider ID |
| `VOICE_MODEL` | `gemini-2.0-flash-live-001` | Gemini Live model ID |
| `VOICE_LANGUAGE` | `en-US` | BCP47 language code |
| `VOICE_NAME` | — | Provider voice name (e.g., "Aoede") |

The Google API key is read from `GOOGLE_API_KEY` via `Settings.getGoogleAI()` and never sent to the client.

## Infrastructure

- ALB natively supports WebSocket — no config changes needed
- 300s idle timeout on ALB; server sends keepalive ping every 240s
- WebSocket connections are persistent — no sticky sessions required
- TLS terminated at ALB; backend receives plain WS on port 3000
