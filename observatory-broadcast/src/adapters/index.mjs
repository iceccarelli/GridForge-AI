import { ObsError } from "../errors.mjs";
import { assertAdapterInterface } from "./base.mjs";
import { LocalSinkAdapter } from "./local-sink.mjs";
import { RtmpAdapter } from "./rtmp.mjs";
import { YouTubeAdapter } from "./youtube.mjs";
import { KickAdapter } from "./kick.mjs";

export { PLATFORM_STATES, BaseAdapter, assertAdapterInterface, readSecret } from "./base.mjs";
export { LocalSinkAdapter, RtmpAdapter, YouTubeAdapter, KickAdapter };

/** Registered adapters. Add a platform here; it must satisfy assertAdapterInterface. */
export const ADAPTER_NAMES = Object.freeze(["local", "rtmp", "youtube", "kick"]);

/**
 * @param {string} name
 * @param {import("./base.mjs").AdapterDeps} [deps]
 */
export function createAdapter(name, deps = {}) {
  switch (name) {
    case "local": return assertAdapterInterface(new LocalSinkAdapter(deps));
    case "rtmp": return assertAdapterInterface(new RtmpAdapter(deps));
    case "youtube": return assertAdapterInterface(new YouTubeAdapter(deps));
    case "kick": return assertAdapterInterface(new KickAdapter(deps));
    default: throw new ObsError("unknown_adapter", `unknown adapter "${name}" (choose: ${ADAPTER_NAMES.join(", ")})`, { exitCode: 2 });
  }
}
