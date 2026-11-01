-- Gemini Live moves from the Gemini API key to keyless Vertex AI (standard 14).
-- `gemini-3.1-flash-live-preview` (the dev and prod value on 2026-10-28) is a
-- Gemini-API-only ID, and `gemini-2.0-flash-live-001` (the old code default)
-- is retired, so Vertex rejects both. `gemini-3.8-live` is the current GA Live
-- model on Vertex (us, eu, us-central1) and the Gemini API.
--
-- Only these known-dead values are replaced; any other administrator-chosen
-- model is left alone.
UPDATE settings
   SET value = 'gemini-3.8-live',
       description = 'Voice model ID (e.g., gemini-3.8-live)',
       updated_at = now()
 WHERE key = 'VOICE_MODEL'
   AND value IN ('gemini-3.1-flash-live-preview', 'gemini-2.0-flash-live-001');
