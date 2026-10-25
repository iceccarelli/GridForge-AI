# observatory-broadcast

A self-contained Node ESM tool (no root dependencies, not imported by the Next app) that turns a presenter-mode
Observatory page into a video and, step by step, into a live stream. It never runs inside a Vercel request handler or the
GridForge engine.

```
SCENE            CAPTURE / ENCODE                         PUBLISH
URL in Chromium  Playwright -> ffmpeg -> H.264/AAC MP4    adapter { name, validateConfig, preflight, start, status, stop }
?t=&freeze=1     silent audio, captions, manifest         local sink | rtmp | youtube | kick   (+ supervisor, slate)
```

Playwright is not a dependency: set `PLAYWRIGHT_MODULE` (default `/opt/node-tools/node_modules/playwright`) and `CHROMIUM`
(default `/opt/pw-browsers/chromium`). ffmpeg/ffprobe come from `/usr/bin` (override `OBS_FFMPEG`, `OBS_FFPROBE`).

## Commands (`bin/obs.mjs`)

| command | what it does |
|---|---|
| `record --url U --out F.mp4 [--duration 10 --fps 25 --size 1280x720 --bitrate 2500k --mode stepped\|realtime --cues cues.json \| --vtt f.vtt --captions soft\|burn\|both\|none --hls]` | scene -> MP4 + `.vtt` sidecar + `.manifest.json` |
| `prepare --adapter A (--url U \| --source-file F) [--visibility private\|unlisted\|public]` | local preflight, plan, short-lived code written to `approval-code.txt` (never printed) |
| `publish --adapter A ... --approve CODE [--approve-public]` | runs the supervisor in the foreground; `local` needs no code, everything else does |
| `status`, `health`, `stop` | read/steer the running broadcast through the state dir (JSON status file, lockfile) |
| `slate generate --out F` / `slate on` / `slate off` | build the fallback slate / cut the running broadcast to it / release it |

Ingest URLs and stream keys are never accepted as arguments: `OBS_RTMP_URL [OBS_RTMP_KEY]`,
`OBS_YOUTUBE_STREAM_KEY [OBS_YOUTUBE_INGEST_URL]`, `OBS_KICK_INGEST_URL OBS_KICK_STREAM_KEY` (each also as `*_FILE`
pointing at a 0600 file), `OBS_LOCAL_SINK_DIR`. `OBS_STATE_DIR`, `OBS_ALLOW_URLS` (replaces the default allow-list).

## States

`not_configured | configured_unverified | preflight_failed | ready | starting | live | reconnecting | stopped | fallback_slate`,
always with `verified:true|false`. `live` is produced only by a verification callback that confirmed the ingest (the
local sink's real one checks segment files; a fake in tests). RTMP, YouTube and Kick have none in this build, so they say
"live status cannot be verified for <platform> in this build" and stay `starting`.

## What is NOT done (YouTube / Kick)

No platform API is called anywhere. Not implemented: creating/transitioning a YouTube broadcast, setting its privacy,
reading stream health, a Kick channel check, any `verify` callback. To go live for real an operator must: create the channel
and enable live streaming; copy the stream key (and for Kick the per-channel ingest URL) into a secret store exposed as the
variables above; set the broadcast's privacy in the platform (this tool cannot); run `prepare`, `publish`, then watch the
platform's own dashboard to confirm the stream arrives; and decide whether the build gets a verifier (platform API with its own
credentials) before anyone relies on `status`.

Note: ffmpeg takes the output URL as an argument, so while it runs the ingest URL is visible to the same OS user in the
process table. Run the broadcaster as a dedicated user or in a container.

Tests: `npx vitest run tests/site/observatory-broadcast`. Fixtures: `fixtures/stage.html` (stand-in stage honouring
`?t=<s>&freeze=1`), `fixtures/cues.json`, `fixtures/serve.mjs` (localhost server).
