// The site's identity as a machine-readable "business card": ONE Organization, ONE Person and ONE WebSite, each with a stable @id, defined
// in full on the home page and /about and REFERENCED by id everywhere else (every Service, Offer, Dataset and article points at the
// same organisation instead of declaring its own copy, which is how a crawler ends up with several "Time to Power" entities).
//
// Built only from facts the repository already holds (lib/site.ts SITE) and shows on the page. Deliberately NOT here, because none of it
// is in the repository and none will be invented: a street address, a telephone number, a founding date, an employee count, ratings or
// reviews, awards, or a social profile (SITE.social is empty on purpose; a profile appears in sameAs only once its URL is filled in).

import { SITE, SITE_URL, siteUrl } from "@/lib/site";

export const ORG_ID = siteUrl("/#organization");
export const WEBSITE_ID = siteUrl("/#website");
export const LOGO_ID = siteUrl("/#logo");
export const FOUNDER_ID = siteUrl("/about#founder");

/** The plain statement of what the company is; the same words are visible on /about and in the home page's metadata. */
export const ORG_DESCRIPTION =
  "Independent power and thermal engineering for AI data centers. We tell the owner of an existing data hall how much AI compute it can carry, which of thirteen electrical, thermal and physical constraints binds first, and what each step of extra density costs. We quote no equipment and take no margin on hardware.";

export const KNOWS_ABOUT = [
  "AI data center rack density",
  "Data hall capacity constraints",
  "Busway ampacity and tap-off ratings",
  "Direct liquid cooling retrofit",
  "Coolant distribution unit capacity at site conditions",
  "Transformer and UPS capacity for AI loads",
  "Grid interconnection queues",
  "Contracted grid capacity utilisation",
  "Data center floor loading",
];

/** Profiles that exist: the product's public repository, plus any social account whose URL has actually been filled in. */
export function sameAsUrls(): string[] {
  return [SITE.repo, ...Object.values(SITE.social)].filter((u) => typeof u === "string" && /^https:\/\//.test(u));
}

/** "Frankfurt, DE · Toronto, CA" as the two places it names. */
export function locations(): { "@type": "Place"; name: string }[] {
  return SITE.baseLocation
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ "@type": "Place" as const, name }));
}

export function organizationNode() {
  return {
    "@type": ["Organization", "ProfessionalService"],
    "@id": ORG_ID,
    name: SITE.name,
    alternateName: SITE.tagline,
    url: SITE_URL,
    email: SITE.email,
    description: ORG_DESCRIPTION,
    logo: { "@type": "ImageObject", "@id": LOGO_ID, url: siteUrl("/logo.png"), width: 512, height: 512 },
    contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: SITE.email, availableLanguage: "en" },
    founder: { "@id": FOUNDER_ID },
    location: locations(),
    areaServed: { "@type": "Place", name: "Worldwide" },
    knowsAbout: KNOWS_ABOUT,
    sameAs: sameAsUrls(),
    mainEntityOfPage: siteUrl("/about"),
  };
}

export function founderNode() {
  return {
    "@type": "Person",
    "@id": FOUNDER_ID,
    name: SITE.founder,
    url: SITE.founderUrl,
    jobTitle: "Founder",
    worksFor: { "@id": ORG_ID },
  };
}

export function websiteNode() {
  return { "@type": "WebSite", "@id": WEBSITE_ID, url: SITE_URL, name: SITE.name, inLanguage: "en", publisher: { "@id": ORG_ID } };
}

/**
 * A reference to the organisation for use inside another node (a Service's provider, a Dataset's creator). The @id ties it to the full
 * node; the name and url make the reference readable on its own, because a crawler reads one page at a time.
 */
export function orgRef() {
  return { "@type": "Organization", "@id": ORG_ID, name: SITE.name, url: SITE_URL };
}

/** The full graph, for the pages that define the entity (home, /about). */
export function entityGraph(): Record<string, unknown> {
  return { "@context": "https://schema.org", "@graph": [organizationNode(), founderNode(), websiteNode()] };
}
