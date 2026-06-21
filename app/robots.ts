import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = "https://gridforge-ai.vercel.app";
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/api/"] },
    sitemap: `${base}/sitemap.xml`,
  };
}
