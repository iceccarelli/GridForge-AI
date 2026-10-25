import type { Metadata } from "next";
import { loadScenarioFile } from "@/lib/observatory/scenario-data";
import { buildJourney } from "@/lib/observatory/journey";
import { parsePresenterParams } from "@/lib/observatory/presenter-params";
import { PresenterScene } from "@/components/observatory/presenter/PresenterScene";

// The scene the broadcast tool records. Everything is decided on the server from the checked-in synthetic scenarios: no feed is
// read, so the recording is reproducible, and the page makes no request of its own. It carries no navigation, account, admin,
// billing or purchase link (the site shell is switched off for this route in components/SiteChrome.tsx), and is not indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Observatory presenter",
  robots: { index: false, follow: false, nocache: true },
};

export default async function PresenterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = parsePresenterParams(await searchParams);
  let file;
  try {
    file = loadScenarioFile();
  } catch (e) {
    console.error("observatory presenter: scenario data rejected", e instanceof Error ? e.message : "error");
    file = null;
  }
  if (!file || file.scenarios.length === 0) {
    return (
      <div role="alert" className="fixed inset-0 z-[100] flex items-center justify-center bg-ink p-8 text-center text-ghost" data-presenter="unavailable">
        <p className="max-w-xl text-lg">The demonstration data is not available, so there is nothing to present.</p>
      </div>
    );
  }
  const steps = buildJourney(file);
  return <PresenterScene file={file} steps={steps} initialT={params.t} freeze={params.freeze} captions={params.captions} />;
}
