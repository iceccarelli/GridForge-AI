import { RtmpAdapter } from "./rtmp.mjs";

/**
 * Kick adapter (RTMPS ingest) - INCREMENTAL, TODAY:
 *   does:     read OBS_KICK_INGEST_URL and OBS_KICK_STREAM_KEY (both required, each also as *_FILE), validate, run local
 *             preflight, and push to the ingest with the shared RTMP output stage.
 *   does NOT: call any Kick API, check channel state, or confirm viewers can see the stream. Kick ingest endpoints are
 *             per-channel values the operator copies from the Kick creator dashboard; this tool does not guess or embed one.
 *             status() stays `configured_unverified` / `starting` with `verified:false`; "live status cannot be verified
 *             for kick in this build".
 */
export class KickAdapter extends RtmpAdapter {
  /** @param {import("./base.mjs").AdapterDeps} [deps] */
  constructor(deps = {}) {
    super(deps, {
      name: "kick",
      urlVar: "OBS_KICK_INGEST_URL",
      keyVar: "OBS_KICK_STREAM_KEY",
      keyRequired: true,
      defaultUrl: null,
      label: "Kick",
      notes: [
        "Kick has no unlisted/private broadcast state this tool can set; a Kick stream is public once the channel is live, so visibility 'public' semantics apply regardless of the declared value",
        "no Kick API is called: channel state and ingest acceptance are unchecked",
      ],
    });
  }
}
