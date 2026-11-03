import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

// Install metadata and the icons a phone or a crawler asks for. It claims no offline or push capability: `display` stays "browser".
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.tagline,
    start_url: "/",
    display: "browser",
    background_color: "#070B14",
    theme_color: "#070B14",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
