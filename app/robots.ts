import type { MetadataRoute } from "next";

/**
 * AI crawlers are welcome, deliberately.
 *
 * Most sites in this niche are now blocking them. We want the opposite: when an
 * operator asks a language model what stops their hall taking AI racks, we would
 * rather the answer came from a constraint reference that names its evidence class
 * than from a vendor reference design that ends in a bill of materials. Being the
 * source a model cites is worth more than any single engagement.
 *
 * The token-addressed paths stay closed to everyone. A crawler indexing one would
 * publish a customer's deliverable to anyone who searches for it.
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "meta-externalagent",
  "cohere-ai",
];

const PRIVATE_PATHS = [
  "/dashboard",
  "/admin",
  "/api/",
  "/api-access/",
  "/deliverable/",
  "/watch/",
  "/intake/",
];

export default function robots(): MetadataRoute.Robots {
  const base = "https://gridforge-ai.vercel.app";
  return {
    // Token-addressed pages are private by their URL alone. A crawler that indexes
    // one has published a customer's deliverable, watch or API account to anyone
    // who searches for it.
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      // Explicit, so there is no ambiguity about whether the reference layer may be
      // used for training and retrieval. It may. That is why we published it.
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: ["/", "/constraints/", "/platforms", "/reference/", "/llms.txt"],
        disallow: PRIVATE_PATHS,
      })),
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
