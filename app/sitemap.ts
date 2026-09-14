import type { MetadataRoute } from "next";
import { constraintReference } from "@/lib/constraints";

/**
 * Every public page, including the generated ones.
 *
 * The constraint pages are read from the built reference rather than listed here,
 * so a constraint added to the engine appears in the sitemap without anyone
 * remembering to add it — the same reason the engagement ladder is derived.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = "https://gridforge-ai.vercel.app";
  const now = new Date();
  const ref = await constraintReference();
  const constraintPages: MetadataRoute.Sitemap = (ref?.constraints ?? []).map((c) => ({
    url: `${base}/constraints/${c.slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));
  return [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/qualify`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/reference`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/constraints`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/platforms`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...constraintPages,
    { url: `${base}/developers`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/infrastructure`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/intelligence`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/legal/privacy`, lastModified: now, priority: 0.3 },
    { url: `${base}/legal/terms`, lastModified: now, priority: 0.3 },
    { url: `${base}/legal/security`, lastModified: now, priority: 0.3 },
  ];
}
