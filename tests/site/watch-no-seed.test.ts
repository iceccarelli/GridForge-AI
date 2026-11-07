/**
 * GUARD: a Hall Watch page or route never reads another engagement's intake.
 *
 * A "seed" (offer the watch the intake of the buyer's Density Screen) was built and REMOVED: it joined watch -> project link ->
 * deliverable intake, but /api/checkout accepts a project's SHARE token for hall_watch and the webhook links the new watch to the
 * owner's project, so any share-link holder who bought a watch could read the owner's intake (including DSO and queue note, which
 * the share link itself hides). Doing it safely needs the attach authority recorded in the checkout/webhook path (payment code),
 * so it cannot come back without that design. This test fails if a watch-token path starts reading deliverables or project links.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (["node_modules", ".next", ".git"].includes(f)) continue;
    const full = join(dir, f);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(full);
  }
  return out;
}

describe("static: no watch-token path reads deliverables or project links", () => {
  const files = [...walk("lib"), ...walk("app"), ...walk("components")];
  // A file is on a watch-token path if it lives under the watch page/route or resolves a watch by its token.
  const onWatchPath = (f: string, src: string) => /^app\/(api\/)?watch\//.test(f.replace(/\\/g, "/")) || /\bgetWatch\s*\(/.test(src);
  const reachesIntake = /getByToken|getByIntakeToken|getById|deliverableBySession|rest\/v1\/deliverables|["'`]deliverables["'`]|linksFor\s*\(|projectLinks\s*\(|project_links|@\/lib\/deliverables|@\/lib\/projects["']|seedForWatch|IntakeSeed/;

  it("the seed module is gone and nothing names it", () => {
    expect(existsSync("lib/project-watch-seed.ts")).toBe(false);
    const named = files.filter((f) => /seedForWatch|IntakeSeed|project-watch-seed/.test(readFileSync(f, "utf8")) && !f.endsWith("watch-no-seed.test.ts"));
    expect(named).toEqual([]);
  });

  it("no module on a watch-token path touches deliverables, project links or the deliverables library", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return onWatchPath(f, src) && reachesIntake.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the watch page and the intake form take exactly the props they took before", () => {
    const page = readFileSync("app/watch/[token]/page.tsx", "utf8");
    expect(page).toMatch(/<EngagementIntake\s+token=\{token\}\s+endpoint=\{`\/api\/watch\/\$\{token\}`\}\s+submitLabel=\{w\.intake \? "Re-solve the hall" : "Start the watch"\}\s*\/>/);
    expect(readFileSync("components/EngagementIntake.tsx", "utf8")).not.toMatch(/\bseed\??:|IntakeSeed|applySeed|intake-seed/);
  });
});

describe("runtime: a project-linked watch is handed no engagement intake", () => {
  let db: PostgrestFake;
  let restore: () => void;
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    db = new PostgrestFake(["watches", "deliverables", "project_links", "watch_notes", "projects"]);
    restore = db.install();
    db.seed("watches", [{ id: U(1), token: "watch-token", status: "active", cadence: "quarterly", email: "buyer@x.example", company: "Buyer Co", intake: null, last_state: null }]);
    db.seed("deliverables", [{ id: U(2), token: "doc", kind: "density_screen", status: "released", intake: { site: { name: "OWNER-HALL" }, grid: { dso: "OWNER-SECRET-DSO", queue_note: "OWNER-SECRET-QUEUE" } } }]);
    db.seed("project_links", [
      { id: "l1", project_id: U(9), object_type: "watch", object_id: U(1) },
      { id: "l2", project_id: U(9), object_type: "deliverable", object_id: U(2) },
    ]);
  });
  afterEach(() => restore());

  it("the page props, serialised, carry none of the owner's intake, and no deliverable or project-link row was read", async () => {
    const { default: Page } = await import("@/app/watch/[token]/page");
    const tree = await Page({ params: Promise.resolve({ token: "watch-token" }) });
    const text = JSON.stringify(tree, (_k, v) => (typeof v === "function" ? "fn" : v)) + renderToStaticMarkup(tree);
    expect(text).not.toMatch(/OWNER-HALL|OWNER-SECRET/);
    expect(db.calls.filter((c) => /deliverables|project_links/.test(c.url))).toEqual([]);
  });
});
