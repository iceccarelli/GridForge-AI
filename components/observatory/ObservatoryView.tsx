// The whole /observatory page as a pure function of what the server loaded, so it can be rendered in tests with fixtures.
// Degradation rules: a scenario file that is missing or malformed means the page says the demonstration data cannot be shown
// and renders NO figures from it; a failed live-context read means each market/grid panel says it is unavailable and why.
import Link from "next/link";
import type { ScenarioFile } from "@/lib/observatory/types";
import { ContextPanel, type ContextState } from "@/components/observatory/ContextPanel";
import { FunnelCta } from "@/components/observatory/FunnelCta";
import { ObservatoryExplorer } from "@/components/observatory/ObservatoryExplorer";

export type FileState = { ok: true; file: ScenarioFile } | { ok: false };

export function ObservatoryView({ fileState, contextState, now }: { fileState: FileState; contextState: ContextState; now: Date }) {
  const usable = fileState.ok && fileState.file.scenarios.length > 0;
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-24 pt-24 sm:px-6 sm:pt-28">
      <a
        href="#observatory"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-power focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Skip to the observatory
      </a>

      <header className="mb-8 max-w-3xl">
        <p className="eyebrow">GridForge Observatory</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-5xl">What limits an AI hall, stage by stage</h1>
        <p className="mt-4 text-base text-mute sm:text-lg">
          An invented hall, followed from the grid connection to the rack. The same engine that powers the free qualifier says which stage binds, how many racks it allows, and what
          each way of relieving it does to rack count, time and cost. Every figure carries its evidence class.
        </p>
      </header>

      <div id="observatory" tabIndex={-1} className="scroll-mt-28 outline-none">
        {usable ? (
          <ObservatoryExplorer
            file={(fileState as { ok: true; file: ScenarioFile }).file}
            contextSlot={<ContextPanel state={contextState} now={now} />}
            ctaSlot={<FunnelCta />}
          />
        ) : (
          <>
            <div role="alert" className="rounded-xl border border-flag/50 bg-flag/5 p-6" data-observatory="data-unavailable">
              <h2 className="text-lg font-semibold text-ghost">The demonstration data cannot be shown</h2>
              <p className="mt-2 max-w-2xl text-sm text-mute">
                The scenario data for this page is missing or failed its checks, so nothing from it is displayed rather than a partial picture. This is a fault on our side, not
                something about your hall.
              </p>
              <p className="mt-3 text-sm">
                <Link href="/qualify" className="text-power underline underline-offset-4">
                  Run the free qualifier on your hall
                </Link>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
