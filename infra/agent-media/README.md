# agent-media

Container-image Lambda giving the agent three capabilities it kept having to
refuse (#1738). Each traces to a real prod refusal:

| operation | request that failed | what it does |
|---|---|---|
| `html-to-pdf` | nashs, 2026-09-01 — "save this 8.5×11 sign as a PDF" | headless Chromium print-to-PDF, honouring `@page` CSS |
| `media` | kinneyk, 2026-09-01 — a `.mov` to verify for Facebook/Instagram | ffprobe inspection, ffmpeg transcode via named presets |
| `transcribe` | demontek, 2026-09-03 — an `.m4a` to turn into a script | Amazon Transcribe over audio in the owner's workspace |

## Why this is a separate function

Chromium and FFmpeg cannot live in the agent image: the AgentCore Firecracker
overlay-mount snapshotter can't carry that native stack, and the agent image
sits near its 54-layer ceiling. That much is shared with `hyperframes-render`.

It is a **separate function from `hyperframes-render`** despite the overlapping
toolset, and the reason is IAM rather than convenience. That function's role may
write only to `public-images/`. This one reads and writes the owner's **private**
workspace prefix, because a scanned IEP or a staff recording must never become a
public-by-link object. Merging them would widen a production role purely to
avoid a second image.

## Security model

The function never accepts an identity from its caller. The root relay injects
`workspacePrefix` after the trusted web boundary verified the signed invocation
context (`/api/agent/invocation-identity`); the model-facing skill supplies only
workspace-**relative** paths, validated here against absolute forms, `..`
traversal, backslashes and control characters. A caller cannot reach another
owner's workspace because it never states who it is.

Nothing here writes to `public-images/`. Publishing stays a separate, deliberate
act through `psd-publish-file`, which carries its own sensitivity gate.

## Local smoke test (pre-deploy)

The build itself proves the two native tools work — `RUN` probes fail the build
if Chromium can't emit a `%PDF-` or if the static ffmpeg/ffprobe can't execute.
To exercise the handler the way Lambda does:

```bash
cd infra && docker build --platform linux/amd64 -f agent-media/Dockerfile -t agent-media:smoke .
```

```bash
docker run -d --name agent-media-smoke --platform linux/amd64 -p 9077:8080 -e LAMBDA_TASK_ROOT=/var/task agent-media:smoke
```

`LAMBDA_TASK_ROOT` is required: real Lambda sets it, the Runtime Interface
Emulator does not, and without it the RIC exits with `Runtime.PlatformError`
before your event is ever seen.

Then POST an event to
`http://localhost:9077/2015-03-31/functions/function/invocations`.

`html-to-pdf` needs no AWS access at all, so it round-trips locally. Verify the
**geometry**, not just that bytes came back — the original bug produced a
perfectly valid PDF at the wrong size:

```bash
python3 -c "import base64,json,re,urllib.request;e={'operation':'html-to-pdf','workspacePrefix':'smoke-owner01/','userEmail':'smoke@psd401.net','html':'<!doctype html><style>@page{size:8.5in 11in;margin:0}</style><h1>probe</h1>'};r=json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:9077/2015-03-31/functions/function/invocations',data=json.dumps(e).encode(),headers={'Content-Type':'application/json'}),timeout=180).read());p=base64.b64decode(r['pdfBase64']);print(r['status'],r['bytes'],re.findall(rb'/MediaBox[^]]*]',p)[:1])"
```

A US Letter page is **612×792 pt**. Anything else means the `@page` CSS was not
honoured, which is the exact failure this operation exists to fix.

`media` and `transcribe` reach S3 and Transcribe, so they need real credentials
and a deployed workspace bucket. To check the ffmpeg half without AWS, drive the
binaries directly in the running container:

```bash
docker exec agent-media-smoke sh -c '/opt/ffmpeg/ffmpeg -nostdin -y -f lavfi -i testsrc=duration=2:size=640x480:rate=30 -f lavfi -i sine=frequency=440:duration=2 -c:v prores -c:a pcm_s16le /tmp/in.mov && /opt/ffmpeg/ffprobe -v error -print_format json -show_streams /tmp/in.mov'
```

Verified on 2026-09-05 against this image: a ProRes `.mov` through the
`social-mp4` preset produced `h264 High / yuv420p` + `aac` with the `moov` atom
at byte 36, ahead of `mdat` at 3591 — `+faststart` doing its job. That ordering
is what stops Facebook and Instagram rejecting an upload as corrupt, so it is
worth re-checking whenever the preset changes.

## Caps

| cap | value | why |
|---|---|---|
| inline PDF | 4 MB | Lambda's response ceiling is 6 MB and base64 inflates by 4/3 |
| input HTML | 4 MB | same envelope, on the request side |
| input media | 512 MB | a larger transcode won't finish inside the agent turn |
| transcript | 600k chars | keeps one response inside the relay's own bound |

Keep these in sync with each skill's `SKILL.md`.
