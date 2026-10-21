import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApiAccount, keyLife, signingConfigured } from "@/lib/api-access";
import { PAYG } from "@/lib/products";
import { planLabel } from "@/lib/payg-client";
import { eurExact, isFree as isFreeRate, isPerHall, unitSummary } from "@/lib/payg-pricing";
import { readToolRates } from "@/lib/tool-rates";
import ApiKeyPanel from "@/components/ApiKeyPanel";
import McpInstall from "@/components/McpInstall";
import PaygPortal from "@/components/PaygPortal";
import SetupSnippets from "@/components/SetupSnippets";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your API access",
  robots: { index: false, follow: false },
};

/**
 * The customer's API account.
 *
 * Token in the URL, same as /deliverable and /watch. No password, nothing to
 * reset, and no key stored anywhere we could read back: the key is shown once,
 * at the moment it is minted, and after that this page can only tell you which id
 * is live and when it expires.
 *
 * Plan, status and key life are read here, on the server, from the account row. The live meter, last events and
 * settlements are fetched by <PaygPortal> from /api/usage and degrade to "not available" when that route is
 * missing, so this page never draws a figure it did not get.
 */
export default async function ApiAccessPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const row = await getApiAccount(token);
  if (!row) notFound();

  const engine = process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev";
  const rates = await readToolRates();
  const life = keyLife(row);
  const isFree = row.plan === "api_free";
  const isPayg = row.plan === "api_payg";

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-24 pt-28 sm:px-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          API access · {row.account}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">{planLabel(row.plan)}</h1>
        <p className="mt-3 text-mute">
          {isFree
            ? `${PAYG.freeAllowanceUnits} units a month, no card, never invoiced. `
            : isPayg
              ? `Pay as you go at ${eurExact(PAYG.unitPriceCents)} a unit, up to the monthly cap you set. `
              : `${row.monthly_units.toLocaleString("en-IE")} units a month. `}
          {unitSummary(rates)} The free qualifier stays free and never touches your allowance.
        </p>
      </header>

      <ApiKeyPanel
        token={token}
        engine={engine}
        hasKey={Boolean(row.key_id)}
        keyId={row.key_id}
        expires={row.key_expires_at}
        daysLeft={life.days_left}
        needsRotation={life.needs_rotation}
        status={row.status}
        cancelled={row.status === "cancelled"}
        signingConfigured={signingConfigured()}
      />

      <div className="mt-8">
        <PaygPortal token={token} plan={row.plan} status={row.status} monthlyUnits={row.monthly_units} />
      </div>

      <SetupSnippets engine={engine} rates={rates} />

      <section className="mt-8">
        <McpInstall engine={engine} />
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <Box title="What you are billed for">
          {rates.length === 0 ? (
            <p className="mt-2 text-sm text-mute">
              The tool catalogue is not available on this deployment, so no list is shown rather than a guessed one.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-mute">
              {[...rates]
                .sort((a, b) => a.units - b.units)
                .map((r) => (
                  <li key={r.endpoint}>
                    <span className="font-mono text-xs text-ghost">{r.endpoint}</span>:{" "}
                    {isFreeRate(r) ? "0 units (free, no key needed)" : `${r.units} unit${r.units === 1 ? "" : "s"}${isPerHall(r) ? " per hall in the request" : ""}`}
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-faint">
            Read the same numbers from the engine with{" "}
            <span className="break-all font-mono text-ghost">GET {engine}/v1/tools</span>. Live usage:{" "}
            <span className="break-all font-mono text-ghost">GET {engine}/v1/usage</span> with your key. Over your
            allowance or cap the engine returns 402, not 429: the call was refused and not charged.
          </p>
        </Box>
        <Box title="What this is not">
          <p className="mt-2 text-sm text-mute">
            API responses are screening-mode output. There is no named signatory, no issued status and no
            professional indemnity behind them: those belong to an engagement, and the difference is stated on every
            response you get back.
          </p>
          <p className="mt-3 text-sm text-mute">
            Every number carries an evidence class E0 to E7 and a provenance digest, and every response carries the
            engine&apos;s calibration state, including while that record is empty. Inside an agent loop that matters more
            than it does in a board pack: nobody downstream reads the footnote.
          </p>
        </Box>
      </section>
    </main>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded border border-line bg-panel-2 p-5">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">{title}</h3>
      {children}
    </div>
  );
}
