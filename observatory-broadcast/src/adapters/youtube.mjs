import { RtmpAdapter } from "./rtmp.mjs";

/**
 * YouTube Live adapter (RTMPS ingest) - INCREMENTAL, TODAY:
 *   does:     read OBS_YOUTUBE_STREAM_KEY (or _FILE) and optional OBS_YOUTUBE_INGEST_URL, validate them, run local preflight,
 *             and push the encoded stream to the ingest with the shared RTMP output stage.
 *   does NOT: call the YouTube Data API, create/transition a broadcast, set privacy, read stream health, or confirm that
 *             viewers can see anything. status() therefore stays `configured_unverified` / `starting` and `verified:false`;
 *             "live status cannot be verified for youtube in this build". "live" is reachable only through an injected verifier.
 *
 * The default ingest is YouTube's documented RTMPS address; nothing connects to it in this build's tests or preflight.
 */
export const YOUTUBE_DEFAULT_INGEST = "rtmps://a.rtmps.youtube.com:443/live2";

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
}
