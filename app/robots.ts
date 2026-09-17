import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

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

/**
 * Closed to every crawler, including the friendly ones.
 *
 * Two kinds of thing. The token-addressed pages (/deliverable/, /intake/,
 * /watch/, /api-access/, /q/, /commissioned) are private by their URL alone: a
 * crawler that indexes one has published a customer's engineering opinion, or
 * their intake credential, to anyone who can run a search. The rest (/admin,
 * /account, /dashboard, /api/) are operator and customer surfaces with nothing
 * to offer a search result.
 *
 * /account was missing. It is the Intelligence subscriber's portal and it renders
 * their saved scenarios.
 */
const PRIVATE_PATHS = [
  "/dashboard",
  "/admin",
  "/account",
  "/api/",
  "/api-access/",
  "/deliverable/",
  "/watch/",
  "/intake/",
  "/q/",
  "/commissioned",
];

export default function robots(): MetadataRoute.Robots {
  const base = SITE_URL;
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
