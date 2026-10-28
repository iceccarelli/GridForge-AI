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
| `publish --adapter A ... --approve CODE [--approve-public] [--accept-argv-exposure]` | runs the supervisor in the foreground; `local` needs no code, everything else does, plus `--approve-public` and the argv acknowledgement (below) |
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

## YouTube: what is verified, and what is not

Without YouTube credentials nothing changes: no platform API is called, the state stays `starting` with `verified:false`, and the tool says
"live status cannot be verified for youtube in this build".

With read-only YouTube credentials the youtube adapter has a **verifier** (`src/youtube-api.mjs`), and "live" becomes reachable, on
YouTube's own word. It asks the YouTube Data API (scope `youtube.readonly`; it can neither create nor change anything) whether the channel
has exactly ONE active broadcast, whether that broadcast is `live` (not `testing` / `liveStarting`), whether its bound stream is `active`
with health `good` or `ok`, and what its privacy is. Anything else fails closed and the reason is the status detail: no credentials, an
API refusal, more than one active broadcast (it cannot tell which one this encoder feeds), a privacy different from `--visibility`
(change it in Studio), an inactive or unhealthy stream. Answers are cached for 30 s (120 s after an error), which keeps a round-the-clock
stream near 5,800 of the default 10,000 daily quota units.

One-time setup (the Google side is yours; this tool never holds a write scope):

1. Google Cloud console: create a project, enable **YouTube Data API v3**, create an OAuth client of type **TVs and Limited Input devices**.
2. `export OBS_YOUTUBE_OAUTH_CLIENT_ID=... ; read -rs OBS_YOUTUBE_OAUTH_CLIENT_SECRET; export OBS_YOUTUBE_OAUTH_CLIENT_SECRET`
3. `obs youtube-auth` prints a URL and a code; approve it with the channel's Google account. The refresh token is written to the state
   directory (0600) and never printed; export the `OBS_YOUTUBE_OAUTH_REFRESH_TOKEN_FILE=...` line it names.
4. `obs youtube-check [--visibility unlisted]` asks once and exits 0 (CONFIRMED by YouTube, with the evidence) or 1 (NOT confirmed, why).
   Before anyone has gone live it says "no active YouTube broadcast", which is the correct answer.

A half-set configuration is refused (exit 2) rather than silently downgraded. What the verifier does NOT do: create or transition a
broadcast, set privacy, read viewer counts or chat, or call any other platform (Kick and generic RTMP still have no verifier).

## What is NOT done

Kick and generic RTMP: no platform API is called and no verifier exists, so they never reach `live`. For every platform the operator
still creates the channel, enables live streaming, copies the stream key into a secret store exposed as the variables above, sets the
broadcast's privacy in the platform (this tool cannot), runs `prepare`, `publish`, and watches the platform's own dashboard.

## Known exposure: the stream key is on ffmpeg's command line (NOT solved)

ffmpeg takes its output URL as an argument, so the ingest URL, which carries the stream key, is readable from the
process table (`/proc/<pid>/cmdline`, `ps`) for as long as the stream runs. This tool does not remove that. Anything running
as the same OS user can read it; other users can too unless `/proc` is mounted with `hidepid=1` or higher (and `hidepid`
never hides it from the same user). Therefore:

- `prepare` lists the exposure in the plan notes;
- `publish` for rtmp / youtube / kick refuses to start without `--accept-argv-exposure`, unless `/proc` is mounted with
  `hidepid>=1` (detected from `/proc/mounts`). The check runs before the approval code is spent;
- run the broadcaster as a dedicated user or in a container with nothing else in it, and rotate the stream key after use.

Everything else about the key is contained: it comes only from the environment / 0600 `*_FILE` files, is redacted in every
log, status file and manifest, is not in plan.json (the plan fingerprint is an HMAC keyed by the unstored approval code),
and neither Chromium nor ffmpeg receives the tool's environment (only PATH, HOME, locale, display variables and `PLAYWRIGHT_*`).

## Other hardening, stated plainly

- **Visibility is not controlled by this tool** for rtmp / youtube / kick, so all three count as PUBLIC: `--approve-public`
  is required whatever `--visibility` says.
- **Scene guard.** Default allow-list: `/observatory/presenter` (and the fixture `/stage`) on localhost, any port, and
  `https://timetopower.ai/observatory/presenter`. The deny list covers every path in `app/robots.ts` `PRIVATE_PATHS` plus
  checkout/billing/login/power; a test parses that file. Main-frame navigations stay on the scene's own origin and path
  prefix. **Redirects are refused** (Chromium follows redirect hops without routing them, so the tool fetches pages itself with
  redirects off): give the final URL. A scene that navigates itself elsewhere makes the recording fail instead of capturing an
  error page. Page requests to other origins, `/api`, and every WebSocket are blocked; WebRTC may not use non-proxied UDP.
- **Chromium's sandbox stays ON** unless the tool runs as uid 0 (typical in containers) or `OBS_NO_SANDBOX=1` is set.
- **Media files.** `--source-file` / `--slate-file` must be MP4/MOV; the approval is bound to their resolved path and sha256, the
  tool copies them into the state dir and checks the copy, and ffmpeg reads inputs with `-protocol_whitelist` and a forced demuxer.
  The slate is regenerated for every run.
- **State directory** must be a real directory owned by you with mode 0700 (it is refused otherwise); the approval code file is
  created 0600 with O_EXCL|O_NOFOLLOW and the lifetime is capped at 1 hour.
- **Orphans.** Encoder pids are recorded with their start time and run id. `stop`, `status`, `health` and the next `publish`
  find and kill an encoder left by a SIGKILLed supervisor, and report it. A pid is only killed if its start time and the exact
  `observatory-broadcast run <runId> ` command-line marker both match (a recycled pid is left alone and reported).
- `--hls` refuses an existing output directory unless it carries this tool's marker file.

Tests: `npx vitest run tests/site/observatory-broadcast`. Fixtures: `fixtures/stage.html` (stand-in stage honouring
`?t=<s>&freeze=1`), `fixtures/cues.json`, `fixtures/serve.mjs` (localhost server).
