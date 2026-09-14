import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApiAccount, signingConfigured } from "@/lib/api-access";
import { PRODUCTS, type ProductId } from "@/lib/products";
import ApiKeyPanel from "@/components/ApiKeyPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your API access | GridForge AI",
  robots: { index: false, follow: false },
};

/**
 * The customer's API account.
 *
 * Token in the URL, same as /deliverable and /watch. No password, nothing to
 * reset, and no key stored anywhere we could read back — the key is shown once,
 * at the moment it is minted, and after that this page can only tell you which id
 * is live and when it expires.
 */
export default async function ApiAccessPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const row = await getApiAccount(token);
  if (!row) notFound();

  const product = PRODUCTS[row.plan as ProductId];
  const engine = process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev";

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          API access · {row.account}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
          {product?.name ?? row.plan}
        </h1>
        <p className="mt-3 text-mute">
          {row.monthly_units.toLocaleString("en-IE")} units a month. A constraint screen is 1
          unit, a full solve is 5, a portfolio run is 1 per hall. The free qualifier stays free
          and never touches your allowance.
        </p>
      </header>

      {row.status !== "active" ? (
        <div className="mt-6 rounded border border-flag/40 bg-flag/10 p-4 text-sm text-ghost">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-flag">
            {row.status === "past_due" ? "Payment failed" : "Subscription cancelled"}
          </span>
          <p className="mt-1 text-mute">
            {row.status === "past_due"
              ? "Your last invoice did not clear. The current key keeps working until it expires; update the card to keep it renewing."
              : "This subscription has ended. The live key has been revoked and no new one will be issued."}
          </p>
        </div>
      ) : null}

      <ApiKeyPanel
        token={token}
        engine={engine}
        hasKey={Boolean(row.key_id)}
        keyId={row.key_id}
        expires={row.key_expires_at}
        cancelled={row.status === "cancelled"}
        signingConfigured={signingConfigured()}
      />

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <Box title="What you are billed for">
          <ul className="mt-2 space-y-1 text-sm text-mute">
            <li>/v1/qualify — 0 units (free, no key needed)</li>
            <li>/v1/screen — 1 unit</li>
            <li>/v1/portfolio — 1 unit per hall in the request</li>
            <li>/v1/diff — 2 units</li>
            <li>/v1/proposal — 2 units</li>
            <li>/v1/deck — 3 units</li>
            <li>/v1/study — 5 units</li>
          </ul>
          <p className="mt-3 text-[11px] text-faint">
            Live usage:{" "}
            <span className="font-mono text-ghost">GET {engine}/v1/usage</span> with your key.
            Over the allowance the engine returns 402, not 429 — buy more rather than retry.
          </p>
        </Box>
        <Box title="What this is not">
          <p className="mt-2 text-sm text-mute">
            API responses are screening-mode output. There is no named signatory, no issued
            status and no professional indemnity behind them — those belong to an engagement,
            and the difference is stated on every response you get back.
          </p>
          <p className="mt-3 text-sm text-mute">
            Every number carries an evidence class E0–E7 and a provenance digest, and every
            response carries our calibration state. Inside an agent loop that matters more than
            it does in a board pack: nobody downstream reads the footnote.
          </p>
        </Box>
      </section>

      <section className="mt-8 rounded border border-line bg-panel-2 p-6">
        <h2 className="text-lg font-semibold text-ghost">Point something at it</h2>
        <pre className="mt-4 overflow-x-auto rounded bg-ink p-4 font-mono text-[11px] leading-relaxed text-mute">
{`# schemas, in OpenAI function shape and MCP shape
curl -s ${engine}/v1/tools

# a full solve — 5 units
curl -s -X POST ${engine}/v1/study \\
  -H "x-api-key: $GRIDFORGE_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"intake": { ... }}'

# what you have spent this month
curl -s ${engine}/v1/usage -H "x-api-key: $GRIDFORGE_KEY"`}
        </pre>
      </section>
    </main>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-line bg-panel-2 p-5">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">{title}</h3>
      {children}
    </div>
  );
}
