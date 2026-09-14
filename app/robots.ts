import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = "https://gridforge-ai.vercel.app";
  return {
    // Token-addressed pages are private by their URL alone. A crawler that indexes
    // one has published a customer's deliverable, watch or API account to anyone
    // who searches for it.
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/admin",
        "/api/",
        "/api-access/",
        "/deliverable/",
        "/watch/",
        "/intake/",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
