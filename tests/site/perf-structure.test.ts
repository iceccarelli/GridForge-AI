import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the first-load JavaScript work. They read source, so they run offline and fast; the byte budget itself is
// tests/site/perf-budget.test.ts. Each asserts that a heavy library stays out of the static import graph of the routes that do not
// need it on first paint.

const read = (f: string) => fs.readFileSync(f, "utf8");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "api" ? [] : sourceFiles(p);
    return /\.(tsx?|ts)$/.test(e.name) ? [p] : [];
  });
}

describe("heavy libraries are not in the first load", () => {
  it("the animation library is imported by no page or component (the shell uses CSS)", () => {
    for (const f of [...sourceFiles("app"), ...sourceFiles("components")]) {
      expect(read(f), f).not.toMatch(/from "framer-motion"/);
    }
    expect(fs.existsSync("components/MotionProvider.tsx")).toBe(false);
    expect(read("app/layout.tsx")).not.toContain("MotionProvider");
  });

  it("the workspace charts (recharts) load only when an answer contains a chart block", () => {
    const t = read("components/ai/BlockRenderer.tsx");
    expect(t).not.toMatch(/import \{ (HeadroomLadderCard|TimeToPowerCard) \} from/);
    expect(t).toMatch(/dynamic\(\(\) => import\("\.\/HeadroomLadderCard"\)/);
    expect(t).toMatch(/dynamic\(\(\) => import\("\.\/TimeToPowerCard"\)/);
    expect(t).toMatch(/ssr: false/);
  });

  it("the intelligence live scenario (recharts) mounts through the lazy island, not a static import", () => {
    const t = read("components/IntelligenceClient.tsx");
    expect(t).not.toMatch(/from "@\/components\/LiveScenario"/);
    expect(t).toContain('which="liveScenario"');
    expect(read("components/home/LazyIsland.tsx")).toContain('import("@/components/LiveScenario")');
  });

  it("the Supabase browser client is downloaded only when a session may exist or sign-in is submitted", () => {
    for (const f of ["app/dashboard/page.tsx", "app/account/login/page.tsx", "app/account/page.tsx"]) {
      const t = read(f);
      expect(t, f).not.toMatch(/import \{[^}]*getSupabase[^}]*\} from "@\/lib\/supabase-client"/);
    }
    expect(read("app/dashboard/page.tsx")).toContain("mayHaveSession()");
    expect(read("app/account/page.tsx")).toContain("mayHaveSession()");
    expect(read("components/supabase-lazy.ts")).toContain('import("@/lib/supabase-client")');
  });
});
