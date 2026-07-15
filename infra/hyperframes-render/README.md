# hyperframes-render

Container-image AWS Lambda that renders a [HyperFrames](https://hyperframes.heygen.com/)
HTML/CSS/JS composition to an **MP4** (headless Chromium + FFmpeg) and uploads it to the agent
workspace S3 bucket under the public `public-images/<email>/` prefix. This is the render half
of the **`psd-hyperframes`** OpenClaw agent skill (issue #1175).

The native render stack (Chromium/FFmpeg/`hyperframes` CLI) lives **only here** — never in the
agent image, whose AgentCore Firecracker overlay-mount snapshotter cannot carry it. The thin
agent skill (`infra/agent-image/skills/psd-hyperframes/`) invokes this function synchronously
via the AWS SDK.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Debian base (ported from upstream `Dockerfile.render`) + `aws-lambda-ric` + RIE |
| `handler.js` | Lambda handler — validate event → render via `hyperframes` CLI → upload to S3 |
| `entrypoint.sh` | Wires `PRODUCER_HEADLESS_SHELL_PATH`; starts RIC (RIE locally) |
| `handler.test.js` | Unit tests (`bun test`) — validation + dryRun/upload/error paths |
| `sample-events/sample-scene.{html,json}` | A hermetic (pure-CSS) sample scene + invoke event |

## Event contract

```jsonc
{
  "html": "<!doctype html>…",   // required — full composition
  "css": "…",                    // optional — injected before </head>
  "js": "…",                     // optional — injected before </body>
  "durationSeconds": 3,          // required — cap-validated (<= 60)
  "fps": 30,                     // optional — default 30, range 1..60
  "width": 1920, "height": 1080, // optional — metadata + cap check
  "userEmail": "person@psd401.net", // required — scopes the S3 key
  "dryRun": false                // optional — render but skip the S3 upload
}
```

Returns `{ "status":"ok", "url":"https://…/public-images/<email>/<uuid>.mp4", "s3Key":"…",
"bytes":N, … }` or `{ "status":"error", "error":"<code>", "message":"…" }`.

## Local unit tests (no Docker)

```bash
cd infra/hyperframes-render && bun install && bun test
```

## Standalone render smoke (docker run + RIE) — pre-deploy

Produces a playable MP4 from the sample scene with **no S3/AWS** (dryRun), writing it to a
bind-mounted host directory. Run from `infra/hyperframes-render`:

```bash
# 1. Build the image (x86_64 to match the Lambda architecture).
docker build --platform linux/amd64 -t hyperframes-render:smoke .

# 2. Run it with the RIE, mounting a host output dir the dryRun render writes into.
mkdir -p /tmp/hf-out
docker run --rm -p 9000:8080 \
  -e HYPERFRAMES_OUTPUT_DIR=/tmp/out -v /tmp/hf-out:/tmp/out \
  --name hyperframes-render-smoke hyperframes-render:smoke &

# 3. Invoke with the sample event (dryRun:true).
sleep 2
curl -s -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" \
  -d @sample-events/sample-scene.json | tee /tmp/hf-out/result.json

# 4. Verify a playable MP4 was produced.
ls -lh /tmp/hf-out/*.mp4
ffprobe /tmp/hf-out/*.mp4    # should report an h264 video stream

# 5. Stop the container.
docker stop hyperframes-render-smoke
```

## Deploy

The function is a `DockerImageFunction` in `AgentPlatformStack` (construct:
`infra/lib/constructs/compute/hyperframes-render-function.ts`). CDK builds and pushes the image
on deploy. Deploy the agent platform stack via the canonical dev deploy command; then run the
post-deploy end-to-end smoke (agent chat → MP4 link that plays in a browser).
