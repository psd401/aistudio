---
name: psd-hyperframes
summary: Compose a short video by writing HTML/CSS/JS and render it to an MP4 delivered privately to the requester's Drive (HyperFrames + headless render Lambda).
description: Turn a described scene into a short MP4 video. Write an HTML/CSS/JS composition (title cards, motion graphics, animated text/shapes) and deliver it privately (a Drive file shared with the requester only). Use when asked to make/create/generate a short video, motion graphic, animated title card, or video clip.
allowed-tools: Bash(node:*)
---

# psd-hyperframes

Compose a **short video** by writing a self-contained HTML/CSS/JS scene, then render it
to an **MP4** delivered privately to the requester. Built on
[HyperFrames](https://hyperframes.heygen.com/) (Apache-2.0): the renderer seeks each frame
in headless Chromium and encodes with FFmpeg, so the same composition always produces the
same video.

The render itself runs in a dedicated **`hyperframes-render` Lambda** (Chromium + FFmpeg live
there, not in this agent image). This skill only helps you compose the scene, invokes that
Lambda synchronously, and delivers the MP4 — same delivery + reply contract as
`psd-image-gen` and `psd-tts`. The Lambda stages the MP4 under the bucket's **private**
`agent-renders/` prefix; this skill fetches it and creates it in your agent account's Drive,
shared with the requester alone.

**Private by default, whatever the video shows (#2034).** A public link is an explicit,
user-confirmed exception: see **Public links** below.

**Identity.** Do not pass an email or owner selector. The root relay resolves
the owner from the installed signed invocation context through the trusted web
tier and injects it after the model-facing request has been validated.

## Limits (v1)

- **Duration:** ≤ 180 seconds (3 min) of output video. Split longer stories into multiple clips.
- **Frame rate:** 1–60 fps (default 30).
- **Render budget:** total frames (`fps × duration`) must be ≤ **3600**. Render time scales
  with frames, so a longer scene must use a lower fps — e.g. a full 180s video renders at
  ≤ 20 fps (`180 × 20 = 3600`), the same render cost as a 60s clip at 60 fps. Requests over
  the budget are rejected with the max fps for that duration.
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

> **Rendering takes MINUTES, not seconds. Run it in the background.**
>
> Observed in production: 180–430 seconds per render, for scenes only a few
> seconds long. The render seeks every frame in headless Chromium and then
> encodes with FFmpeg, so wall time scales with `fps × duration`, not with how
> short the video is.
>
> A foreground call will be killed by the tool timeout long before the render
> finishes. The Lambda keeps running and still bills, you get an error, and
> retrying just starts another multi-minute render — on 2026-08-10 a user
> burned six attempts and ~28 minutes this way and never got a video.
>
> **Start it in the background, then poll:**
>
> ```bash
> # 1. Start it — returns immediately with a handle.
> node /opt/psd-skills/psd-hyperframes/render.js --file scene.html --duration 3 \
>   > /home/node/.openclaw/work/hyperframes-out.json 2>/home/node/.openclaw/work/hyperframes-err.log &
>
> # 2. Poll every ~30s until the JSON lands. Budget 3-7 minutes.
> #    Tell the user it is rendering BEFORE you start waiting.
> cat /home/node/.openclaw/work/hyperframes-out.json
> ```
>
> Say "this takes a few minutes, I'll post the link when it's done" in the turn
> you start the render. Do not go silent, and do not start a second render
> because the first looks stuck — it is not stuck, it is encoding.
>
> Lower `--fps` (24, or 15 for static title cards) to cut render time roughly
> proportionally. `--fps 15` on a 6-second card is about a quarter the work of
> `--fps 60`.

```bash
node /opt/psd-skills/psd-hyperframes/render.js \
  --file scene.html \
  --duration 3 \
  [--css-file extra.css] [--js-file extra.js] \
  [--audio-file <narration.mp3>] \
  [--fps 30] [--width 1920] [--height 1080] \
  [--name "<Drive file name>"] [--to drive | public] [--public-confirmed]
```

- `--file <path>` — the composition HTML (or `--html "<inline html>"`).
- `--css-file` / `--js-file` — optional extra CSS/JS injected into the composition
  (`<style>` before `</head>`, `<script>` before `</body>`). Prefer inlining directly in the
  HTML; these exist for convenience.
- `--audio-file <path.mp3>` — optional narration made with `psd-tts --to file` (see **Audio** below).
  `--audio-url <https-url>` still works for a track that is already hosted.
- `--name` — the Drive file name (default `Video <date time>`).
- `--to drive` (default) — private Drive file. `--to public --public-confirmed` — see **Public links**.
- `--duration <seconds>` — **required**; must match the composition's `data-duration`, be ≤ 180,
  and keep `fps × duration ≤ 3600` (lower `--fps` for a long scene).

Returns JSON (default): `{ "url": "<Drive link>", "driveFileId": "…", "fileName": "Video 2026-11-11 0605.mp4", "sharing": "private-shared-with-caller", "sharedWith": "<caller>", "expires": "never", "bytes": N, "fps": 30, "durationSeconds": 3, "width": 1920, "height": 1080 }`.

## Public links (opt-in, user-confirmed)

Only make a public video when the user asks for one **and** confirms after you tell them, in
plain words, that **anyone who gets the link can play it without signing in, for 30 days**.
Then pass `--to public --public-confirmed`. `--to public` alone returns
`public_needs_confirmation` before anything is rendered. Never add `--public-confirmed` on your
own judgment — it asserts the user said yes in this conversation. "Share it with the team" is
**not** a request for a public link: deliver privately and share the Drive file with the named
people (psd-workspace).

## Required Reply Format

**This is the single most important step — do not skip it.** After the skill returns a `url`, your
**very next chat message MUST paste the bare `url` on a line by itself** so the user gets a
clickable/playable link. If the HTTPS `url` is not in your reply, the user got nothing.

- ✅ Correct:
  ```
  Here's your video (a private file in your Drive):
  https://drive.google.com/file/d/<id>/view
  ```
- ❌ Wrong: telling the user where it's saved ("it's in your Drive", the container path)
  instead of pasting the HTTPS `url` — that is NOT a clickable link, and the user cannot see the
  tool result. Paste the `url`, don't describe it.
- ❌ Wrong: wrapping the URL in `[label](url)` or `**bold**` — Google Chat corrupts these for
  long URLs. Bare URL only.
- ❌ Wrong: re-rendering, presigning, or re-publishing the returned URL to make it public.

## Audio (narration / music)

hyperframes has **no separate audio input** — audio comes from an `<audio>` element in the
composition, which hyperframes muxes into the MP4. Easiest path:

1. Write the narration script, then call **psd-tts** with `--to file --out <path.mp3>` — it
   writes the MP3 locally and uploads nothing. Pick a voice/engine that fits the piece:
   - `--engine long-form` (en-US: Danielle, Gregory, Patrick, Ruth) — best for narrating a script.
   - `--engine generative` (default; **Ruth** = warm female, **Matthew** = clear male; also
     Danielle, Joanna, Salli, Stephen, Tiffany, en-GB Amy/Brian) — most natural/expressive.
   - `--engine neural` for the widest voice/language coverage.
   - Full list: psd-tts `references/voices.md`.
2. Pass that file here as `--audio-file <path.mp3>`. The skill inlines it as a `data:audio/mpeg`
   URI and injects `<audio src="…" data-start="0" data-duration="<your --duration>"
   data-track-index="0" data-volume="1">` into the composition root; hyperframes pads/trims the
   clip to the video length. The inline limit is 2 MiB (several minutes of speech).

Notes:
- `--audio-url` must be an `https://` URL (or a `data:audio/…` URI); the render Lambda fetches it.
  Use it only for a track that is already hosted (licensed music). Do not make narration public
  just to get a URL — use `--audio-file`.
- Advanced: you can hand-author the `<audio>` element in the composition yourself instead of
  `--audio-url` — the element contract is identical (`data-start`/`data-duration`/`data-track-index`/`data-volume`).

## Errors

- **`bad_args`** — no composition, bad `--duration`/`--fps`/dimensions,
  a valueless `--css-file`/`--js-file`, an `--audio-url` that isn't `https://` / `data:audio/`,
  a combined html+css+js payload over the 4 MiB cap, a JSON-escaped request over
  Lambda's 6 MiB synchronous invocation cap, or a
  composition whose declared `data-duration` exceeds the 180 s cap or whose root
  `data-width`/`data-height` exceeds the 3840 px cap. Fix and retry.
- **`invoke_failed`** — the fixed relay or render Lambda could not complete the invocation
  (runtime configuration, permissions, throttling, or transport failure). Retry once; if it
  persists, report it.
- **`render_failed`** — the render Lambda ran but produced no video (composition error, Chromium
  crash, or a scene too heavy for the timeout). Simplify the scene or lower `--fps`, then retry.
- **`public_needs_confirmation`** — `--to public` without `--public-confirmed`. Nothing was
  rendered. Deliver privately (omit `--to public`), or ask the user and only on their yes re-run
  with both flags.
- **`download_failed` / `share_failed` / `create_failed` / `delivery_failed`** — the video rendered
  but could not be delivered to Drive. Nothing became public. Retry once; never fall back to a
  public link.

## Operational Notes

- Renders synchronously through a root-owned, fixed-operation loopback relay. The relay's
  AWS SDK has `lambda:InvokeFunction` on the configured render function ARN only; the
  model-facing subprocess receives neither reusable AgentCore credentials nor an API key.
- The trusted render function writes the MP4 under the signed caller's PRIVATE
  `agent-renders/` prefix (deleted after 1 day by the `expire-agent-renders` lifecycle rule)
  and returns a 15-minute presigned GET that this skill consumes immediately; it is never
  shown to the user. The model role has no S3 authority.
- The delivered Drive file does not expire. A public link (`--to public --public-confirmed`)
  is deleted by the `expire-public-artifacts` lifecycle rule 30 days after it is written.
- `--dry-run` is a diagnostic flag (renders without uploading or delivering, returns a local path + byte
  count) used by the standalone render smoke; users don't need it.
