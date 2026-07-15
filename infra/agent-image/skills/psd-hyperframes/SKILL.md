---
name: psd-hyperframes
summary: Compose a short video by writing HTML/CSS/JS and render it to a shareable MP4 (HyperFrames + headless render Lambda).
description: Turn a described scene into a short MP4 video. Write an HTML/CSS/JS composition (title cards, motion graphics, animated text/shapes) and get back a shareable HTTPS link. Use when asked to make/create/generate a short video, motion graphic, animated title card, or video clip.
allowed-tools: Bash(node:*)
---

# psd-hyperframes

Compose a **short video** by writing a self-contained HTML/CSS/JS scene, then render it
to an **MP4** and get back a shareable HTTPS URL. Built on
[HyperFrames](https://hyperframes.heygen.com/) (Apache-2.0): the renderer seeks each frame
in headless Chromium and encodes with FFmpeg, so the same composition always produces the
same video.

The render itself runs in a dedicated **`hyperframes-render` Lambda** (Chromium + FFmpeg live
there, not in this agent image). This skill only helps you compose the scene, invokes that
Lambda synchronously, and returns the MP4 URL — same delivery + reply contract as
`psd-image-gen` and `psd-tts`. The MP4 is uploaded to the workspace bucket's public
`public-images/<email>/` prefix and returned as an unsigned, public-by-link HTTPS URL (the
UUID in the path makes it unguessable — same model as Google Drive "anyone with the link").

**Identity.** Requires `--user <caller-email>`. Pass the email verbatim from the
`[caller: Name <email>]` header of the user turn — it scopes the S3 upload path.

## Limits (v1)

- **Duration:** ≤ 60 seconds of output video. Split longer stories into multiple clips.
- **Frame rate:** 1–60 fps (default 30).
- **Dimensions:** 16–3840 px per side (default 1920×1080). Set them in the composition's
  viewport/CSS **and** pass `--width`/`--height` so the cap can be enforced.

Simple and working beats configurable — v1 targets a single "HTML/CSS/JS → MP4" path.

## How to author a composition

A composition is one standard HTML document. Three rules make it renderable:

1. **Viewport matches your dimensions** — `<meta name="viewport" content="width=1920, height=1080" />`.
2. **A root element carries `data-composition-id` and `data-duration`** (total seconds):
   `<div id="stage" data-composition-id="promo" data-duration="6" data-width="1920" data-height="1080">`.
3. **Every timed element uses `class="clip"`** (which starts `visibility: hidden`) plus
   `data-start` and `data-duration` (seconds). The framework toggles visibility from those
   attributes — never toggle `visibility` yourself.

**Animate with plain CSS `@keyframes`** (recommended — no external scripts, fully
deterministic, nothing to download). HyperFrames' CSS runtime adapter seeks WAAPI animations
frame-by-frame. Example scene (3 s title card):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0b1f3a; font-family: system-ui, sans-serif; }
      #stage { position: relative; width: 1920px; height: 1080px; display: flex; align-items: center; justify-content: center;
               background: linear-gradient(135deg, #0b1f3a, #1d5aa8); }
      .clip { position: absolute; inset: 0; visibility: hidden; display: flex; align-items: center; justify-content: center; }
      #title { color: #ffd34d; font-size: 132px; font-weight: 800; animation: rise 3s ease-out both; }
      @keyframes rise {
        0%   { opacity: 0; transform: translateY(90px) scale(.9); }
        35%  { opacity: 1; transform: translateY(0) scale(1); }
        100% { opacity: 1; transform: translateY(0) scale(1.04); }
      }
    </style>
  </head>
  <body>
    <div id="stage" data-composition-id="promo" data-duration="3" data-width="1920" data-height="1080">
      <div id="title" class="clip" data-start="0" data-duration="3">Peninsula School District</div>
    </div>
  </body>
</html>
```

For complex timelines you may instead load GSAP from a CDN and register a paused timeline on
`window.__timelines["<composition-id>"]` (HyperFrames' GSAP adapter drives it). CSS keyframes
are preferred for reliability.

**Workflow:** write the composition to a file in the workspace (e.g. `scene.html`), then pass
its path with `--file`. Small scenes can be passed inline with `--html`.

## Usage

```bash
node /opt/psd-skills/psd-hyperframes/render.js \
  --user <email> \
  --file scene.html \
  --duration 3 \
  [--css-file extra.css] [--js-file extra.js] \
  [--fps 30] [--width 1920] [--height 1080]
```

- `--file <path>` — the composition HTML (or `--html "<inline html>"`).
- `--css-file` / `--js-file` — optional extra CSS/JS injected into the composition
  (`<style>` before `</head>`, `<script>` before `</body>`). Prefer inlining directly in the
  HTML; these exist for convenience.
- `--duration <seconds>` — **required**; must match the composition's `data-duration` and be ≤ 60.

Returns JSON: `{ "url": "…", "s3Key": "public-images/<email>/<uuid>.mp4", "bytes": N, "fps": 30, "durationSeconds": 3, "width": 1920, "height": 1080, "sharing": "public-by-link" }`.

## Required Reply Format

After the skill returns a result with a `url`, your **next chat message MUST contain the bare
`url` on a line by itself** (Google Chat renders it as a downloadable/playable link):

- ✅ Correct:
  ```
  Here's your video:
  https://psd-agents-dev-…​.s3.us-east-1.amazonaws.com/public-images/<email>/<uuid>.mp4
  ```
- ❌ Wrong: describing the video without pasting the URL — the user cannot see the tool result.
- ❌ Wrong: wrapping the URL in `[label](url)` or `**bold**` — Google Chat corrupts these for
  long S3 URLs. Bare URL only.
- ❌ Wrong: re-rendering or presigning the returned URL. It is already public-by-link with
  HTTP 200; do not touch it.

## Errors

- **`bad_args`** — missing/invalid `--user`, no composition, bad `--duration`/`--fps`/dimensions,
  a valueless `--css-file`/`--js-file`, a combined html+css+js payload over the 4 MB cap, or a
  composition whose declared `data-duration` exceeds the 60 s cap or whose root
  `data-width`/`data-height` exceeds the 3840 px cap. Fix and retry.
- **`misconfigured`** — the render function name (`HYPERFRAMES_RENDER_FUNCTION`) is not injected.
  Ask an administrator to redeploy the agent platform.
- **`invoke_failed`** — the render Lambda could not be invoked (permissions/throttling). Retry
  once; if it persists, report it.
- **`render_failed`** — the render Lambda ran but produced no video (composition error, Chromium
  crash, or a scene too heavy for the timeout). Simplify the scene or lower `--fps`, then retry.

## Operational Notes

- Renders synchronously via the AWS SDK (`lambda:InvokeFunction` on the render function ARN
  only) using the AgentCore execution-role credentials — no API key.
- The MP4 lands at `s3://$WORKSPACE_BUCKET/public-images/<email>/<uuid>.mp4` with `video/mp4`
  content type; the `public-images/` prefix has a bucket-policy ALLOW for `s3:GetObject` to
  `Principal: *`. Other prefixes stay private.
- The returned URL is unsigned and does not expire — anyone with the link can fetch until the
  object is deleted.
- `--dry-run` is a diagnostic flag (renders without uploading, returns a local path + byte
  count) used by the standalone render smoke; users don't need it.
