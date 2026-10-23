import type { MetadataRoute } from "next";
import { constraintReference } from "@/lib/constraints";
import { SITE_URL } from "@/lib/site";
import pageDates from "@/lib/page-lastmod.json";

/**
 * Every public page, including the generated ones.
 *
 * The constraint pages are read from the built reference rather than listed here,
 * so a constraint added to the engine appears in the sitemap without anyone
 * remembering to add it — the same reason the engagement ladder is derived.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = SITE_URL;
  // The date a page last changed, from scripts/page-lastmod.mjs. A page with no recorded date carries none: the field is
  // omitted rather than stamped with the build time, which would claim a change that did not happen.
  const dates = pageDates.pages as Record<string, { lastmod: string }>;
  const lm = (route: string): { lastModified?: Date } =>
    dates[route] ? { lastModified: new Date(`${dates[route].lastmod}T00:00:00Z`) } : {};
  const ref = await constraintReference();
  const constraintPages: MetadataRoute.Sitemap = (ref?.constraints ?? []).map((c) => ({
    url: `${base}/constraints/${c.slug}`,
    ...lm(`/constraints/${c.slug}`),
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));
  return [
    { url: base, ...lm("/"), changeFrequency: "weekly", priority: 1 },
    { url: `${base}/qualify`, ...lm("/qualify"), changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/reference`, ...lm("/reference"), changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/constraints`, ...lm("/constraints"), changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/platforms`, ...lm("/platforms"), changeFrequency: "monthly", priority: 0.8 },
    ...constraintPages,
    { url: `${base}/developers`, ...lm("/developers"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/power/compare`, ...lm("/power/compare"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/power/deploy`, ...lm("/power/deploy"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/pricing`, ...lm("/pricing"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/intelligence`, ...lm("/intelligence"), changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/legal/privacy`, ...lm("/legal/privacy"), priority: 0.3 },
    { url: `${base}/legal/terms`, ...lm("/legal/terms"), priority: 0.3 },
    { url: `${base}/legal/security`, ...lm("/legal/security"), priority: 0.3 },
  ];
}
