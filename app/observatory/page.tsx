import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { loadScenarioFile } from "@/lib/observatory/scenario-data";
import { getLiveContext } from "@/lib/observatory/sources";
import type { ContextState } from "@/components/observatory/ContextPanel";
import { ObservatoryView, type FileState } from "@/components/observatory/ObservatoryView";
import { PageJsonLd } from "@/components/PageJsonLd";
import { breadcrumbJsonLd, datasetJsonLd, webPageJsonLd } from "@/lib/jsonld";

// Rendered per request, on purpose. Each figure shows when it was actually retrieved, and a statically regenerated page (or a
// feed response held in Next's data cache) would make that timestamp older than it looks. Feed load is bounded instead by the
// five-minute in-process cache in lib/observatory/sources.ts.
export const dynamic = "force-dynamic";

const TITLE = "Observatory: what limits a synthetic AI hall";
const DESCRIPTION =
  "A synthetic AI hall, grid to rack: what binds, racks allowed, what each relief does to time and cost. Modelled, with an evidence class on every engine figure.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/observatory" },
  twitter: { card: "summary_large_image", images: pageImages("observatory") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("observatory"), title: TITLE, description: DESCRIPTION, url: "/observatory" },
};

const CONTEXT_TIMEOUT_MS = 10_000;

async function readContext(): Promise<ContextState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), CONTEXT_TIMEOUT_MS);
    });
    const context = await Promise.race([getLiveContext(), timeout]);
    return { ok: true, context };
  } catch (e) {
    console.error("observatory: live context unavailable", e instanceof Error ? e.name : "error");
    return { ok: false, reason: e instanceof Error && e.message === "timed out" ? "the request timed out" : "the request failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readFile(): FileState {
  try {
    return { ok: true, file: loadScenarioFile() };
  } catch (e) {
    console.error("observatory: scenario data rejected", e instanceof Error ? e.message : "error");
    return { ok: false };
  }
}

export default async function ObservatoryPage() {
  const fileState = readFile();
  // No point reading the feeds for a page that will not show them.
  const contextState: ContextState = fileState.ok ? await readContext() : { ok: false, reason: "the demonstration data is not available" };
  return (
    <>
      <PageJsonLd
        data={[
          webPageJsonLd("/observatory", TITLE, DESCRIPTION),
          // The scenarios file is invented-hall demonstration data. The description says so; no measurement is implied.
          datasetJsonLd("/observatory", "Observatory scenarios for a synthetic AI hall", "Engine-modelled scenarios for an invented AI hall: racks, binding stage, time and cost per relief. Synthetic; nothing is measured at a site.", {
            path: "/observatory/scenarios.json",
            format: "application/json",
          }),
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Observatory", path: "/observatory" },
          ]),
        ]}
      />
      <ObservatoryView fileState={fileState} contextState={contextState} now={new Date()} />
    </>
  );
}
