---
name: psd-media
summary: Inspect and convert video and audio with ffmpeg — check a file, or convert it for Facebook, Instagram, the web, or audio-only MP3.
description: Probe a media file (codec, resolution, frame rate, duration, audio channels) or convert it with a named preset. Use when the user uploads or points at a video or audio file and asks whether it will work somewhere, asks to convert, compress, re-encode, or fix a video, wants an MP4 for social media, or wants the audio pulled out of a video. Handles .mov, .mp4, .avi, .mkv, .webm, .m4a, .wav and anything else ffmpeg reads.
allowed-tools: Bash(node:*)
---

# psd-media

Answer "will this video work?" and "convert it so it does".

```bash
# What IS this file?
node /opt/psd-skills/psd-media/media.js --probe --file /tmp/clip.mov

# Make it work for Facebook / Instagram / YouTube
node /opt/psd-skills/psd-media/media.js --convert --file /tmp/clip.mov \
  --out /tmp/clip.mp4 --preset social-mp4
```

## Probe first when the question is "will this work"

`--probe` returns codec, resolution, frame rate, pixel format, duration and
audio layout. Answer from those facts rather than guessing from the extension —
a `.mov` can contain almost anything, and the extension tells you nothing about
whether an uploader will accept it.

```json
{
  "action": "probe", "file": "/tmp/clip.mov", "bytes": 3559763,
  "durationSeconds": 2.0, "formatName": "mov,mp4,m4a",
  "video": { "codec": "prores", "width": 640, "height": 480, "fps": 30, "pixelFormat": "yuv422p10le" },
  "audio": { "codec": "pcm_s16le", "channels": 1, "sampleRate": 44100 }
}
```

That example needs converting: ProRes and PCM are editing formats, not upload
formats.

## Presets

| preset | output | for |
|---|---|---|
| `social-mp4` | `.mp4` | Facebook, Instagram, YouTube. H.264 High / yuv420p + AAC, `+faststart` |
| `web-mp4` | `.mp4` | same, capped at 720p — embedding in a page or email |
| `audio-mp3` | `.mp3` | audio only; any video is discarded |

There is no raw-ffmpeg-arguments option, deliberately. If a request genuinely
needs a shape none of these cover, say so rather than improvising.

**Why `social-mp4` is specified the way it is:** `yuv420p` and `+faststart` are
the two settings whose absence makes an upload fail or be rejected as corrupt,
and they are the reason "it's already an MP4" is not the same as "it will
upload". Worth saying to a user who asks why their file needed converting.

## Limits

- Input: **512 MB**.
- A long transcode has to finish inside the turn. Minutes of 1080p are fine;
  an hour of 4K is not — probe first and say so if it looks marginal.

## After it runs

The output is a **local file**. Not shared, not published, no link.

- To hand over a link, publish it deliberately with `psd-publish-file`.
- To transcribe it, `psd-transcribe` takes the file directly — no need to
  convert first unless the extension is one Transcribe does not accept.

## Errors

| `error` | meaning |
|---|---|
| `bad_args` | missing/invalid flag, unknown preset, or wrong output extension |
| `too_large` | input over 512 MB |
| `media_failed` | ffmpeg or ffprobe failed; the message carries its diagnostic |

A `bad_args` naming a preset mismatch is usually the output extension: `.mp4`
for the video presets, `.mp3` for `audio-mp3`.
