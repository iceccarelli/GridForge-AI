"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { PAYG } from "@/lib/products";
import { eurExact, estimateOperation, type ToolRate } from "@/lib/payg-pricing";

/**
 * Copy-pasteable setup, in the order that costs nothing first.
 *
 * 1. GET /v1/estimate is public, free and never metered: what an operation will cost before you run it.
 * 2. GET /v1/usage needs your key and is also free: it proves the key works and shows the meter.
 * 3. Only then a first paid call, with the units and price printed next to it (taken from the same
 *    tools.json the rate card reads), an Idempotency-Key so a retry is never charged twice, and a project
 *    header so the usage can be attributed.
 *
 * The key is a shell variable, never a literal: this page never has it.
 */
export default function SetupSnippets({ engine, rates }: { engine: string; rates: ToolRate[] }) {
  const paid = rates.filter((r) => r.units > 0).sort((a, b) => a.units - b.units);
  const screen = rates.find((r) => r.endpoint === "/v1/screen") ?? null;
  const est = screen ? estimateOperation(screen, 1) : null;
  const firstPaid = paid[0] ?? null;

  const steps: { title: string; note: string; code: string }[] = [
    {
      title: "1. Ask what it will cost (free, no key)",
      note: "Public and never metered.",
      code: `curl -s "${engine}/v1/estimate?endpoint=${(firstPaid ?? { endpoint: "/v1/study" }).endpoint}"`,
    },
    {
      title: "2. Check your key and your meter (free)",
      note: "Needs your key, costs zero units. If this returns your usage, the key works.",
      code: `export GRIDFORGE_KEY='paste-your-key-here'\n\ncurl -s ${engine}/v1/usage \\\n  -H "x-api-key: $GRIDFORGE_KEY"`,
    },
  ];
  if (screen && est) {
    steps.push({
      title: `3. Make your first paid call (${est.units} unit${est.units === 1 ? "" : "s"}${est.units > 0 ? `, ${eurExact(est.cents)} on pay-as-you-go` : ""})`,
      note:
        "The Idempotency-Key makes a retry free: a repeat of the same key is never charged twice. " +
        "The project header is optional and lets you attribute usage. A rejected or failed call is refunded. " +
        "my-intake.json is your intake document: the engine refuses an empty one, and a refused call is not charged. " +
        "GET /v1/intake/template returns the blank form with every field.",
      code:
        `curl -s -X POST ${engine}/v1/screen \\\n` +
        `  -H "x-api-key: $GRIDFORGE_KEY" \\\n` +
        `  -H "content-type: application/json" \\\n` +
        `  -H "Idempotency-Key: first-call-001" \\\n` +
        `  -H "X-GridForge-Project: my-project" \\\n` +
        `  -d @my-intake.json`,
    });
  }

  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-5 sm:p-6" aria-labelledby="setup-heading">
      <h2 id="setup-heading" className="text-lg font-semibold text-ghost">
        Check your setup, then make a first call
      </h2>
      <p className="mt-2 text-sm text-mute">
        Steps 1 and 2 cost nothing. Step 3 spends units, up to your cap
        {` (the free allowance is ${PAYG.freeAllowanceUnits} units a month)`}. When a call would go over, the
        engine answers 402 and does no work.
      </p>
      <div className="mt-4 space-y-5">
        {steps.map((s) => (
          <Block key={s.title} {...s} />
        ))}
      </div>
    </section>
  );
}

function Block({ title, note, code }: { title: string; note: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the snippet is visible and selectable either way */
    }
  }
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-ghost">{title}</h3>
      <p className="mt-1 text-xs text-mute">{note}</p>
      <div className="relative mt-2">
        <pre className="overflow-x-auto rounded bg-ink p-4 pr-20 font-mono text-[11px] leading-relaxed text-mute">{code}</pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy: ${title}`}
          className="absolute right-2 top-2 inline-flex min-h-9 items-center gap-1.5 rounded border border-line bg-panel px-2.5 py-1 text-xs text-mute hover:text-ghost"
        >
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
