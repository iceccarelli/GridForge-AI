/// <reference types="vite/client" />
/**
 * Every indexable page's <title> and meta description stay inside what a search result shows.
 *
 * A result shows about 60 characters of title and about 160 of description; past that it is cut mid-word, and the cut is where the
 * specific words usually are. The title measured here is the title as RENDERED: a page title is wrapped by the root layout's template
 * ("%s · Time to Power"), unless it is `{ absolute }`, so the limit applies to the wrapped string.
 *
 * The pages are the sitemap's: the set a crawler is told about. Each URL is resolved to its page module and its real
 * `metadata` / `generateMetadata` is evaluated, so a title built from the catalogue (a price line, a product name) is measured as it
 * renders, not as the source text reads.
 */
import { describe, expect, it, vi } from "vitest";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/site";

// The root layout loads its fonts through next/font, which only exists inside the Next compiler; its metadata is what is wanted here.
vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 160;

/**
 * Intentional exceptions: path -> reason. A page belongs here only when its metadata is owned somewhere this test's author did not
 * touch. The list is checked in the other direction too: an entry whose page is now inside the limits fails, so the list cannot rot.
 */
export const EXCEPTIONS: Record<string, string> = {
};

type Meta = { title?: unknown; description?: unknown };
type PageModule = { metadata?: Meta; generateMetadata?: (a: { params: Promise<Record<string, string>> }) => Promise<Meta> };

const pageModules = import.meta.glob<PageModule>("../../app/**/page.tsx");
const layoutModule = () => import("@/app/layout") as Promise<{ metadata: { description: string; title: { default: string; template: string } } }>;

/** The page file and params that serve a URL path, matching `[x]` directories as parameters. */
function resolve(pathname: string): { key: string; params: Record<string, string> } | null {
  const segs = pathname.split("/").filter(Boolean);
  for (const key of Object.keys(pageModules)) {
    const dirs = key.replace("../../app/", "").replace(/\/?page\.tsx$/, "").split("/").filter(Boolean);
    if (dirs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    dirs.forEach((d, i) => {
      const m = /^\[(\w+)\]$/.exec(d);
      if (m) params[m[1]] = segs[i];
      else if (d !== segs[i]) ok = false;
    });
    if (ok) return { key, params };
  }
  return null;
}

async function rendered(pathname: string): Promise<{ title: string; description: string } | null> {
  const hit = resolve(pathname);
  if (!hit) return null;
  const mod = await pageModules[hit.key]();
  const meta: Meta = mod.generateMetadata ? await mod.generateMetadata({ params: Promise.resolve(hit.params) }) : (mod.metadata ?? {});
  const { title: rootTitle, description: rootDescription } = (await layoutModule()).metadata;
  let title: string;
  const t = meta.title as undefined | string | { absolute?: string; default?: string };
  if (t === undefined) title = rootTitle.default;
  else if (typeof t === "string") title = rootTitle.template.replace("%s", t);
  else title = t.absolute ?? (t.default ? t.default : rootTitle.default);
  return { title, description: typeof meta.description === "string" ? meta.description : rootDescription };
}

/** The sitemap's Next pages. The published sample documents (/reference/*.html) are static files, not pages; tests/site/reference-pages.test.ts measures their heads. */
async function nextPages(): Promise<string[]> {
  return (await sitemap()).map((u) => new URL(u.url).pathname.replace(/\/$/, "") || "/").filter((p) => !p.endsWith(".html"));
}

describe("title and description length on every sitemap page", () => {
  it("every sitemap URL resolves to a page that declares metadata", async () => {
    const urls = await nextPages();
    expect(urls.length).toBeGreaterThan(40);
    const unresolved = urls.filter((p) => !resolve(p));
    expect(unresolved).toEqual([]);
  });

  it("titles are at most 60 characters and descriptions at most 160, as rendered", async () => {
    const urls = await nextPages();
    const rows: string[] = [];
    const over: string[] = [];
    for (const p of urls) {
      const r = await rendered(p);
      if (!r) continue;
      rows.push(`${p}\t${r.title.length}\t${r.description.length}\t${r.title}`);
      if (p in EXCEPTIONS) continue;
      if (r.title.length > TITLE_MAX) over.push(`${p}: title ${r.title.length} > ${TITLE_MAX}: ${r.title}`);
      if (r.description.length > DESCRIPTION_MAX) over.push(`${p}: description ${r.description.length} > ${DESCRIPTION_MAX}`);
      if (r.description.length < 50) over.push(`${p}: description is ${r.description.length} characters: too short to say anything specific`);
    }
    if (process.env.GF_DUMP_META) console.log(rows.join("\n"));
    expect(over).toEqual([]);
  });

  it("an exception that is no longer needed is removed", async () => {
    for (const [p, why] of Object.entries(EXCEPTIONS)) {
      const r = await rendered(p);
      expect(r, p).not.toBeNull();
      expect(why.length, `${p}: say why`).toBeGreaterThan(20);
      expect(r!.title.length > TITLE_MAX || r!.description.length > DESCRIPTION_MAX, `${p} is within the limits now: delete its exception`).toBe(true);
    }
  });

  it("measures the host the site is served from", () => {
    expect(SITE_URL).toMatch(/^https:\/\//);
  });
});
