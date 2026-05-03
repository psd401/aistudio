---
name: psd-image-gen
summary: Generate images with OpenAI gpt-image-2 — shared API key, district-funded.
description: Generates an image from a text prompt via OpenAI's gpt-image-2 model and returns a presigned S3 URL the agent can surface in chat. Uses a shared (district-funded) OpenAI API key from Secrets Manager — usage costs accrue centrally. Restricted by the `skill.image-gen` capability; users without the capability will be refused at invocation time (the skill remains visible in the catalog until OpenClaw supports per-session filtering). Output includes the URL, model, and resolved size; never the API key.
allowed-tools: Bash(node:*)
---

# psd-image-gen

Generate an image from a prompt using OpenAI `gpt-image-2`. The image is uploaded to the agent workspace S3 bucket and returned as a presigned URL valid for 1 hour. Surface the URL to the user — Google Chat will render it as a download link today (inline rendering is a planned follow-up).

**Identity.** All commands require `--user <caller-email>`. Pass the email verbatim from the `[caller: Name <email>]` header of the user turn.

## Usage

```bash
node /home/node/.openclaw/skills/psd-image-gen/generate.js \
  --user <email> \
  --prompt "<image description>" \
  [--size 1024x1024 | 1024x1536 | 1536x1024 | auto] \
  [--quality low | medium | high | auto] \
  [--background opaque | transparent | auto]
```

Returns JSON: `{ "url": "...", "model": "gpt-image-2", "prompt": "...", "size": "...", "expiresAt": "..." }`.

## Prompting Guidance

- Be specific about subject, composition, lighting, style.
- gpt-image-2 has strong text rendering — request labels, titles, captions where useful.
- Default `size` is `auto` (model chooses). Specify a size only when aspect ratio matters.
- Default `quality` is `auto`. Use `high` for hero imagery; `low` for thumbnails / iterative drafts to save spend.

## Cost Note

gpt-image-2 is priced per output token. The shared key bills the district. Prefer fewer high-quality generations over many drafts. If the user iterates rapidly, suggest finalizing the prompt before re-generating.

## Permission Model

This skill enforces the `skill.image-gen` capability at invocation time. The capability is granted via roles in the AI Studio `tools` / `role_tools` tables (currently named `tools`; renaming to `capabilities` under epic #922 / issue #923). Migration 075 seeds the capability and grants it to the `administrator` and `staff` roles.

**Catalog visibility caveat.** OpenClaw loads skills statically at container startup, so the skill *appears* in `tools.catalog` for all users. Users without the capability who try to invoke it receive `forbidden_capability` and the call refuses before any OpenAI traffic is sent. Catalog-level filtering (so the skill is invisible to ungranted users) is a planned follow-up once OpenClaw exposes a per-session catalog hook.

## Errors

- **`forbidden_capability`** — caller lacks `skill.image-gen` capability. The skill refuses without spending any OpenAI quota. Tell the user to ask an administrator to grant it via `/admin/roles`.
- **`shared_key_missing`** — the shared OpenAI key has not been bootstrapped. Tell the user to ask an administrator to provision `psd-agent-creds/{env}/shared/openai_api_key` from the AI Studio settings table value.
- **`upstream_error`** — OpenAI returned non-2xx. Surface the status and a brief message; do not retry automatically.

## Operational Notes

- Always reads the OpenAI key via `psd-credentials/get.js --user <email> --shared --name openai_api_key`. The `--shared` flag skips user-scoped lookups to ensure the district-funded key is always used. Never reads from environment variables.
- Uploads to `s3://$WORKSPACE_BUCKET/images/<email>/<uuid>.png` with `image/png` content type.
- Presigned URL TTL: 3600s. Re-generate via this skill if a longer-lived link is needed (we do not extend TTLs).

## Known limitation: presigned URLs returning `InvalidToken` in chat

When the skill runs inside the AgentCore runtime, the presigned URL is signed with the runtime's STS session credentials and embeds an `X-Amz-Security-Token` query parameter. Some chat clients (observed: Google Chat link-preview fetcher) mishandle the URL-encoded characters in the security token, producing `InvalidToken: The provided token is malformed or otherwise invalid` when the user clicks the URL — even though the underlying object is intact in S3.

The agent should not retry generating the URL when this happens — the failure is structural to session-credentialed presigning, not a per-invocation flake. Tracked in the follow-up issue noted in the PR description; fix path is to stop returning STS-signed URLs and instead either return a public URL from a dedicated public-read prefix, or have the agent-router (long-lived role) re-sign with its own credentials before posting to chat.
