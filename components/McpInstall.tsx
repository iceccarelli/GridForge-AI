"use client";

import { useState } from "react";
import { Check, Copy, Plug } from "lucide-react";
import { AVAILABILITY_UNCONFIRMED, NOT_YET_AVAILABLE } from "@/lib/payg-pricing";
import type { Availability } from "@/lib/engine-capabilities";

/**
 * Adding the engine to an AI client, in one paste.
 *
 * gridforge_qualify is free and needs no key, so the distance between "an operator
 * has a question about their hall" and "an operator has a real engineering answer
 * with the binding constraint named" is one config block. That is the whole
 * distribution argument: the paid tiers sell because the free one already answered
 * something true.
 */
const TABS = {
  "Claude Code": `claude mcp add --transport http gridforge {ENGINE}/mcp`,
  "Claude Desktop": `{
  "mcpServers": {
    "gridforge": {
      "type": "http",
      "url": "{ENGINE}/mcp"
    }
  }
}`,
  "With a key": `{
  "mcpServers": {
    "gridforge": {
      "type": "http",
      "url": "{ENGINE}/mcp",
      "headers": {
        "x-api-key": "YOUR_KEY",
        "X-GridForge-Project": "my-project"
      }
    }
  }
}`,
  "Claude Code + key": `claude mcp add --transport http gridforge {ENGINE}/mcp \\
  --header "x-api-key: $GRIDFORGE_KEY" \\
  --header "X-GridForge-Project: my-project"`,
  curl: `curl -s -X POST {ENGINE}/mcp \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"gridforge_qualify","arguments":{
         "contracted_MW":12,"current_site_peak_MW":7.4,
         "current_it_load_MW":4.9,"busway_ampacity_A":400,
         "tapoff_max_A":63,"plant_supply_C":6,
         "positions_available":180}}}'`,
} as const;

type Tab = keyof typeof TABS;

export default function McpInstall({ engine, availability = "available" }: { engine: string; availability?: Availability }) {
  const [tab, setTab] = useState<Tab>("Claude Code");
  const [copied, setCopied] = useState(false);
  const snippet = TABS[tab].replaceAll("{ENGINE}", engine);

  // The page passes what the deployed engine serves (/mcp and /v1/qualify). A snippet that would point a client at an
  // endpoint the engine does not serve is not shown.
  if (availability !== "available") {
    return (
      <div className="rounded border border-line bg-panel-2 p-6" data-availability={availability}>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ghost">
          <Plug className="h-4 w-4 text-power" /> Add it to your AI client
        </h2>
        <p role="status" className="mt-2 max-w-3xl text-sm text-mute">
          {availability === "unknown" ? AVAILABILITY_UNCONFIRMED : NOT_YET_AVAILABLE}. No install snippet is shown until the
          deployed engine confirms it serves the MCP endpoint.
        </p>
      </div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* selection and manual copy still works */
    }
  }

  return (
    <div className="rounded border border-line bg-panel-2 p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ghost">
        <Plug className="h-4 w-4 text-power" /> Add it to your AI client
      </h2>
      <p className="mt-2 max-w-3xl text-sm text-mute">
        The free qualifier works over MCP with no key and no account. Paste one of these
        and ask your assistant whether a hall can take GB300 racks — it will come back with
        the constraint that binds first, the rack count as found, and which item sets the
        energisation date.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={t === tab}
            onClick={() => setTab(t)}
            className={`min-h-11 rounded border px-3 py-1.5 font-mono text-xs transition-colors ${
              t === tab
                ? "border-power/60 bg-power/10 text-power"
                : "border-line text-mute hover:text-ghost"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="relative mt-3">
        <pre className="overflow-x-auto rounded bg-ink p-4 font-mono text-[11px] leading-relaxed text-mute">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy the ${tab} snippet`}
          className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded border border-line bg-panel px-2.5 py-1 text-xs text-mute hover:text-ghost"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="mt-3 text-[11px] text-faint">
        <span className="font-mono text-mute">X-GridForge-Project</span> is optional: up to 64 characters of letters,
        digits and <span className="font-mono text-mute">. _ : -</span>. When the engine records it, your usage can be
        read back per project; a value outside that set is ignored, not rejected. Without a key, only the free
        qualifier answers. Every other tool asks for one.
      </p>
      <p className="mt-3 text-[11px] text-faint">
        The handshake tells the model not to present a modelled figure as a property of a
        physical asset, and every result carries our calibration state. An E0 number loose
        in an agent loop is more dangerous than one in a board pack — nobody downstream
        reads the footnote.
      </p>
    </div>
  );
}
