import { RtmpAdapter, ARGV_EXPOSURE_NOTE } from "./rtmp.mjs";

/**
 * YouTube Live adapter (RTMPS ingest) - INCREMENTAL, TODAY:
 *   does:     read OBS_YOUTUBE_STREAM_KEY (or _FILE) and optional OBS_YOUTUBE_INGEST_URL, validate them, run local preflight,
 *             and push the encoded stream to the ingest with the shared RTMP output stage.
 *   does NOT: create/transition a broadcast, set privacy, or read viewer counts. Without YouTube OAuth credentials it also does not
 *             call the YouTube Data API, so status() stays `configured_unverified` / `starting` and `verified:false`
 *             ("live status cannot be verified for youtube in this build"). "live" is reachable only through the injected verifier.
 *   WITH credentials (OBS_YOUTUBE_OAUTH_*, see youtube-api.mjs) the CLI injects a read-only verifier: after the operator takes the
 *             broadcast live in YouTube Studio, YouTube's own answer (broadcast live, stream active and healthy, privacy as declared)
 *             is the evidence for "live".
 *
 * The default ingest is YouTube's documented RTMPS address; nothing connects to it in this build's tests or preflight.
 */
export const YOUTUBE_DEFAULT_INGEST = "rtmps://a.rtmps.youtube.com:443/live2";

export const VISIBILITY_CHECKED_NOTE = "this tool cannot SET the platform-side visibility (do that in YouTube Studio), so publishing counts as PUBLIC and needs --approve-public; once the broadcast is live, a privacy that differs from --visibility keeps the state out of live and says so";
export const API_CHECK_NOTE = "live status is confirmed by read-only YouTube Data API calls (youtube.readonly; broadcast state, stream health, privacy; cached 30 s); viewer counts are not read, and a running encoder alone is never reported as live";

export class YouTubeAdapter extends RtmpAdapter {
  /** @param {import("./base.mjs").AdapterDeps} [deps] */
  constructor(deps = {}) {
    super(deps, {
      name: "youtube",
      urlVar: "OBS_YOUTUBE_INGEST_URL",
      keyVar: "OBS_YOUTUBE_STREAM_KEY",
      keyRequired: true,
      defaultUrl: YOUTUBE_DEFAULT_INGEST,
      label: "YouTube Live",
      notes: [
        "visibility is a property of the YouTube broadcast (YouTube Studio); this build cannot set or verify it, so the plan's visibility is only the operator's declared intent",
        "the YouTube API is not called: stream health, broadcast state and the public watch URL are unchecked",
      ],
    });
  }

  platformNotes() {
    if (!this.canVerify) return super.platformNotes();
    return [ARGV_EXPOSURE_NOTE, VISIBILITY_CHECKED_NOTE, API_CHECK_NOTE];
  }
}
