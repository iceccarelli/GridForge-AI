import type { Metadata } from "next";
import { OG_IMAGES } from "@/lib/site";
import { loadScenarioFile } from "@/lib/observatory/scenario-data";
import { getLiveContext } from "@/lib/observatory/sources";
import type { ContextState } from "@/components/observatory/ContextPanel";
import { ObservatoryView, type FileState } from "@/components/observatory/ObservatoryView";

// Rendered per request, on purpose. Each figure shows when it was actually retrieved, and a statically regenerated page (or a
// feed response held in Next's data cache) would make that timestamp older than it looks. Feed load is bounded instead by the
// five-minute in-process cache in lib/observatory/sources.ts.
export const dynamic = "force-dynamic";

const TITLE = "Observatory: what limits a synthetic AI hall";
const DESCRIPTION =
  "An invented AI hall followed from the grid connection to the rack: which stage binds, how many racks it allows, and what each way of relieving it does to rack count, time and cost. Engine-modelled, with an evidence class on every engine figure (hall inputs and rack rows carry basis tags); nothing is measured at a site.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/observatory" },
  openGraph: { images: OG_IMAGES, title: TITLE, description: DESCRIPTION, url: "/observatory" },
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
  return <ObservatoryView fileState={fileState} contextState={contextState} now={new Date()} />;
}
