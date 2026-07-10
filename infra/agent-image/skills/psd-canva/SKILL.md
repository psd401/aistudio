---
name: psd-canva
summary: Act on the caller's own Canva account (list/create designs, upload assets, export to PDF/PNG) via Canva's Connect REST API, per-user OAuth.
description: Work with the caller's Canva account — list and create designs, upload image assets, and export designs to PDF or PNG. Use for Canva, "my Canva designs", create a Canva design, export/download a design as PDF or PNG, upload an image to Canva.
allowed-tools: Bash(node:*)
---

# psd-canva

Act on the calling user's **own** Canva account. Each user authorizes their own
Canva account once (a chat link → browser consent); the skill then acts only on
that caller's account. It calls Canva's Connect REST API
(`https://api.canva.com/rest`) with a per-user OAuth token stored in Secrets
Manager — never a shared Canva account.

## Invoke

    node /opt/psd-skills/psd-canva/run.js --user <caller-email> <subcommand> [flags]

`<caller-email>` is the email in the `[caller: Name <email>]` header of the turn.

| Subcommand | Purpose | Flags |
|---|---|---|
| `whoami` | The connected Canva account's profile | — |
| `list-designs` | List/search the user's designs | `--query` `--ownership any\|owned\|shared` `--sort-by` `--continuation` |
| `create-design` | Create a new design | `--title`, and either `--design-type doc\|whiteboard\|presentation` **or** `--width N --height N` |
| `export` | Export a design to a file (async) | `--design-id <id>` `--format pdf\|png` `--pages 1,2,3` |
| `upload-asset` | Upload a local image/asset (async) | `--file <local-path>` `--name` |

## Auth flow (chat → browser, one time per user)

- On first use (or a revoked token) the skill returns
  `{"status":"needs-auth","consent_chat_hyperlink":"<url|Connect your Canva account>"}`
  and exits 10. **Paste `consent_chat_hyperlink` on its own line**, no markdown,
  then on a separate line ask the user to click it. Do not construct any URL
  yourself (psd-rules Rule 2/9). After they authorize, retry the command.
- Canva rotates the refresh token on **every** call and reusing an old one
  revokes the grant. The skill writes the rotated token back automatically, so
  run **one turn at a time per user** — don't fire concurrent Canva commands for
  the same user.

## Output contract

- **Success (exit 0):** stdout is the Canva REST result JSON.
  - `whoami` → the user's profile (display name).
  - `list-designs` → `{ items: [...], continuation? }`. Pass `continuation` back
    to page.
  - `create-design` → the new design (`design.id`, edit URLs).
  - `export` → the completed job with download `urls` (they **expire quickly** —
    fetch/relay promptly).
  - `upload-asset` → the completed job with the new `asset` (`asset.id`).
- **needs-auth (exit 10):** paste the consent link as above.
- **Errors:** exit 12 (`canva-error`, includes `code`/`http_status`), 14
  (`rate-limited`). Report the error; do not improvise around it.

## Scope & plan notes

- Requested scopes: `design:content:read design:meta:read design:content:write
  asset:read asset:write folder:read profile:read`. **No autofill or
  brand-template** scopes — those APIs are Canva **Enterprise**-gated and the
  district is on **Canva for Education** (out of scope by design).
- **Editing an existing design's contents is not possible** via the Connect
  REST API (that lives in Canva's Apps SDK). `create-design` makes a new blank
  design; there is no element-level edit path.
- Paid-gated PNG options (transparent background, custom resize) are **Pro+** and
  are intentionally not requested; `export` produces a plain render. If Canva
  rejects an export on plan grounds it surfaces as a `canva-error` — relay it.

## Notes

- `export` and `upload-asset` are **async** — the skill starts the job and polls
  until it finishes (or times out at ~90s) before returning.
- `upload-asset` reads a **local file path** and uploads the raw bytes; it does
  not fetch remote URLs.
