import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://gridforge-ai.vercel.app";
  const now = new Date();
  return [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/qualify`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/infrastructure`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/intelligence`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/legal/privacy`, lastModified: now, priority: 0.3 },
    { url: `${base}/legal/terms`, lastModified: now, priority: 0.3 },
    { url: `${base}/legal/security`, lastModified: now, priority: 0.3 },
  ];
}
