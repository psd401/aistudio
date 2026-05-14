---
name: psd-image-gen
summary: Generate images with OpenAI gpt-image-2 — shared API key, district-funded.
description: Generates an image from a text prompt via OpenAI's gpt-image-2 model, uploads the PNG to a public-by-link S3 prefix, and returns an unsigned HTTPS URL the agent can surface in chat. Uses a shared (district-funded) OpenAI API key from Secrets Manager — usage costs accrue centrally. Restricted by the `skill.image-gen` capability; users without the capability will be refused at invocation time (the skill remains visible in the catalog until OpenClaw supports per-session filtering). Output includes the URL, model, and resolved size; never the API key.
allowed-tools: Bash(node:*)
---

# psd-image-gen

Generate an image from a prompt using OpenAI `gpt-image-2`. The image is uploaded to the workspace S3 bucket under the `public-images/` prefix (granted public `s3:GetObject` by the bucket policy) and returned as an unsigned HTTPS URL — anyone who receives the URL can fetch the image. The UUID in the path makes the link unguessable; the security model matches Google Drive "anyone with the link" sharing. Surface the URL to the user — Google Chat will render it as a download link today (inline rendering is a planned follow-up).

**Identity.** All commands require `--user <caller-email>`. Pass the email verbatim from the `[caller: Name <email>]` header of the user turn.

## Usage

```bash
node /opt/psd-skills/psd-image-gen/generate.js \
  --user <email> \
  --prompt "<image description>" \
  [--image <path-to-reference-image>] \
  [--size 1024x1024 | 1024x1536 | 1536x1024 | auto] \
  [--quality low | medium | high | auto] \
  [--background opaque | transparent | auto]
```

Returns JSON: `{ "url": "...", "s3Key": "public-images/.../...png", "model": "gpt-image-2", "prompt": "...", "size": "...", "mode": "generate"|"edit", "sharing": "public-by-link" }`.

### With a reference image (logo, brand asset, layout)

When the user asks for a flyer / header / social card that must include a PSD logo or other supplied artwork, fetch the asset first (typically via `psd-brand-guidelines`) and pass its local path with `--image`. The skill then calls OpenAI's `/v1/images/edits` endpoint so the model composes around the supplied image rather than hallucinating a similar one.

```bash
node /opt/psd-skills/psd-image-gen/generate.js \
  --user <email> \
  --image /home/node/workspace/brand/psd-logo.png \
  --prompt "School newsletter header with this logo top-left, navy/gold palette, space for a date on the right."
```

Accepted reference-image formats: `.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`. Max 8 MB. Multiple reference images are not supported in this version — pick the single most important asset.

## Required Reply Format

After this skill returns a 2xx result, your **next chat message MUST be the bare `url` value on a line by itself**.

- ✅ Correct:
  ```
  Here you go:
  https://psd-agents-dev-390844780692.s3.us-east-1.amazonaws.com/public-images/<email>/<uuid>.png
  ```
- ❌ Wrong: Describing the image's contents/layers/composition in prose without pasting the URL. The user cannot see the tool result. If the URL is not in your chat reply, the user got nothing.
- ❌ Wrong: Wrapping the URL in `[label](url)` or `**bold**` — Google Chat's renderer corrupts these for long S3 URLs. Bare URL only.
- ❌ Wrong: Re-generating, "fixing," or presigning the returned URL. It is already a public-by-link URL with HTTP 200; do not touch it.

You may add one short sentence of context above or below the URL line ("Here's the infographic.") but the URL line itself is non-negotiable.

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
- Uploads to `s3://$WORKSPACE_BUCKET/public-images/<email>/<uuid>.png` with `image/png` content type. The `public-images/` prefix has a bucket-policy ALLOW for `s3:GetObject` to `Principal: *`; other prefixes in the bucket remain private.
- Returned URL is **unsigned** and does not embed any STS token. It does not expire — anyone who receives the link can fetch until the object is deleted.
- This was a deliberate switch from presigned URLs (PR #934 dev rollout 2026-05-03): presigned URLs signed with AgentCore's STS session credentials produced intermittent `InvalidToken` failures when fetched through chat clients. Unsigned-public-by-link is the structural fix.
