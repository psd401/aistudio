---
name: psd-image-gen
summary: Generate images with OpenAI gpt-image-2.5-flare — shared API key, district-funded.
description: Generate an image from a text prompt (OpenAI gpt-image-2.5-flare) and deliver it privately (a Drive file shared with the requester only). Use for image generation — "make/create/generate a picture or image", logos, illustrations, visuals.
allowed-tools: Bash(node:*)
---

# psd-image-gen

Generate an image from a prompt using OpenAI `gpt-image-2.5-flare`. The PNG is delivered **privately** by default: it is created in your agent account's Drive and shared with the requester alone, as a writer (same path as `psd-publish-file`).

**Private by default, whatever the image shows (#2034).** Every output is private to the person who asked until they deliberately widen it. A public link is an explicit, user-confirmed exception — see **Public links** below.

**Identity.** All commands require `--user <caller-email>`. Pass the email verbatim from the `[caller: Name <email>]` header of the user turn.

## Usage

```bash
node /opt/psd-skills/psd-image-gen/generate.js \
  --user <email> \
  --prompt "<image description>" \
  [--image <path-to-reference-image>] \
  [--size 1024x1024 | 1024x1536 | 1536x1024 | auto] \
  [--quality low | medium | high | auto] \
  [--background opaque | transparent | auto] \
  [--name "<Drive file name>"] \
  [--to drive | file | public] [--out <path.png>] [--public-confirmed]
```

- `--to drive` (default) — private Drive file shared with the requester only.
- `--to file --out <path.png>` — write the PNG locally and upload nothing, to embed it in something else you are building (a deck, a PDF, an Atrium page).
- `--to public --public-confirmed` — unsigned public link; see **Public links**.

Returns JSON (default): `{ "url": "<Drive link>", "driveFileId": "...", "fileName": "Image 2026-11-11 0605.png", "sharing": "private-shared-with-caller", "sharedWith": "<caller>", "expires": "never", "model": "gpt-image-2.5-flare", "prompt": "...", "size": "...", "mode": "generate"|"edit" }`.

## Public links (opt-in, user-confirmed)

Only make a public image when the user asks for one **and** confirms after you tell them, in plain words, that **anyone who gets the link can open it without signing in, for 30 days**. Then pass `--to public --public-confirmed`. `--to public` alone returns `public_needs_confirmation` and generates nothing. Never add `--public-confirmed` on your own judgment or because the image "looks harmless" — it asserts the user said yes in this conversation. "Share it with X" is **not** a request for a public link: deliver privately and share the Drive file with the named people (psd-workspace).

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

After this skill returns a 2xx result with a `url`, your **next chat message MUST be the bare `url` value on a line by itself**.

- ✅ Correct:
  ```
  Here you go (a private file in your Drive):
  https://drive.google.com/file/d/<id>/view
  ```
- ❌ Wrong: Describing the image's contents/layers/composition in prose without pasting the URL. The user cannot see the tool result. If the URL is not in your chat reply, the user got nothing.
- ❌ Wrong: Wrapping the URL in `[label](url)` or `**bold**` — Google Chat's renderer corrupts these for long S3 URLs. Bare URL only.
- ❌ Wrong: Re-generating, "fixing," presigning, or re-publishing the returned URL to make it public. Do not touch it.

You may add one short sentence of context above or below the URL line ("Here's the infographic.") but the URL line itself is non-negotiable.

## Prompting Guidance

- Be specific about subject, composition, lighting, style.
- gpt-image-2.5-flare has strong text rendering — request labels, titles, captions where useful.
- Default `size` is `auto` (model chooses). Specify a size only when aspect ratio matters.
- Default `quality` is `auto`. Use `high` for hero imagery; `low` for thumbnails / iterative drafts to save spend.

## Cost Note

gpt-image-2.5-flare is priced per output token. The shared key bills the district. Prefer fewer high-quality generations over many drafts. If the user iterates rapidly, suggest finalizing the prompt before re-generating.

## Permission Model

This skill enforces the `skill.image-gen` capability at invocation time. The capability is granted via roles in the AI Studio `capabilities` / `role_capabilities` tables (renamed from `tools` / `role_tools` by epic #922 / issue #923; the legacy tables were dropped in migration 084). Migration 075 seeds the capability and grants it to the `administrator` and `staff` roles.

**Catalog visibility caveat.** OpenClaw loads skills statically at container startup, so the skill *appears* in `tools.catalog` for all users. Users without the capability who try to invoke it receive `forbidden_capability` and the call refuses before any OpenAI traffic is sent. Catalog-level filtering (so the skill is invisible to ungranted users) is a planned follow-up once OpenClaw exposes a per-session catalog hook.

## Errors

- **`forbidden_capability`** — caller lacks `skill.image-gen` capability. The skill refuses without spending any OpenAI quota. Tell the user to ask an administrator to grant it via `/admin/roles`.
- **`shared_key_missing`** — the shared OpenAI key has not been bootstrapped. Tell the user to ask an administrator to provision `psd-agent-creds/{env}/shared/openai_api_key` from the AI Studio settings table value.
- **`upstream_error`** — OpenAI returned non-2xx. Surface the status and a brief message; do not retry automatically.
- **`public_needs_confirmation`** — `--to public` without `--public-confirmed`. Nothing was generated. Deliver privately (omit `--to public`), or ask the user and only on their yes re-run with both flags.
- **`share_failed` / `create_failed`** — the Drive delivery failed; nothing became public. Retry once; do not fall back to a public link.

## Operational Notes

- Always uses the fixed `openai-image` operation broker. The OpenAI key stays in the trusted web tier and is never returned to the model process.
- Delivers through the owner-bound broker: by default `deliver-to-drive` (a file in the agent account's Drive, shared with the caller alone); only `--to public --public-confirmed` publishes to the unsigned `public-images/` prefix, whose objects the `expire-public-artifacts` lifecycle rule deletes **30 days** after they are written.
- Private Drive delivery replaced the old default (#2034). Unsigned public links were adopted in #934 only because presigned URLs signed with AgentCore's STS session credentials failed intermittently in chat clients — a transport workaround, never a privacy decision. Drive links avoid that problem without being public.
