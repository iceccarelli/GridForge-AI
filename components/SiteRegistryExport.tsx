"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, quietButton, useForm } from "@/components/SiteRegistryParts";
import { saveTextFile } from "@/components/site-registry-download";
import {
  DECLARATION, buildExport, exportFileName, exportJson, inputsCsv, readWholeTimeline, timelineCsv, type HallExport,
} from "@/lib/site-registry-export";
import type { RegistryApi, RegistryEvent, RegistryInput } from "@/lib/site-registry-model";

type Kind = "json" | "figures" | "timeline";

// Export of one hall's record for a compliance binder. Any member who can read the hall can export it: the data is fetched through the same read routes the page
// uses (sign-in, membership and allowance are checked there), and the file is built in this page; nothing is sent anywhere.

export default function SiteRegistryExport({ hall, api }: { hall: { id: string; label: string }; api: RegistryApi }) {
  const f = useForm();
  const [which, setWhich] = useState<Kind | null>(null);

  async function go(kind: Kind) {
    f.setBusy(true); f.setMsg(null); setWhich(kind);
    try {
      const i = await api(`/api/halls/${hall.id}/inputs`);
      if (!i.body?.ok || !Array.isArray(i.body.inputs)) { f.fail((i.body?.error ?? "Could not read the hall's figures.") + " Nothing was downloaded."); return; }
      if (i.body.truncated) { f.fail("This hall holds more figures than one read returns, so the export would be incomplete. Nothing was downloaded."); return; }
      const inputs = i.body.inputs as RegistryInput[];
      let events: RegistryEvent[] = [];
      let complete = true;
      let note: string | null = null;
      if (kind !== "figures") {
        const t = await readWholeTimeline(api, hall.id);
        if (t.error && t.events.length === 0) { f.fail(`${t.error} Nothing was downloaded.`); return; }
        events = t.events; complete = t.complete; note = t.note;
      }
      const now = new Date().toISOString();
      const h = i.body.hall ?? {};
      const doc: HallExport = buildExport({
        hall: { id: hall.id, label: String(h.label ?? hall.label), siteName: String(h.siteName ?? ""), dataOrigin: String(h.dataOrigin ?? ""), country: h.country ?? null },
        inputs, eventsNewestFirst: events, timelineComplete: complete, timelineNote: note, exportedAt: now,
      });
      const [name, mime, text] =
        kind === "json" ? [exportFileName(doc.hall.label, "record", "json", now), "application/json", exportJson(doc)]
        : kind === "figures" ? [exportFileName(doc.hall.label, "figures", "csv", now), "text/csv", inputsCsv(doc)]
        : [exportFileName(doc.hall.label, "timeline", "csv", now), "text/csv", timelineCsv(doc)];
      saveTextFile(name, mime, text);
      const what = kind === "figures" ? `${doc.currentInputs.length} current figures` : kind === "timeline" ? `${doc.timeline.length} timeline events` : `${doc.currentInputs.length} current figures and ${doc.timeline.length} timeline events`;
      if (complete) f.setMsg({ ok: true, text: `Downloaded ${name}: ${what}.` });
      else f.fail(`Downloaded ${name} with ${what}, but it is INCOMPLETE: ${note}`);
    } catch {
      f.fail("Could not reach the server. Nothing was downloaded.");
    } finally {
      f.setBusy(false); setWhich(null);
    }
  }

  const btn = (kind: Kind, label: string) => (
    <button type="button" onClick={() => void go(kind)} disabled={f.busy} className={quietButton}>
      {f.busy && which === kind ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}{label}
    </button>
  );

  return (
    <section aria-labelledby="export-title" className="mt-8 rounded-lg border border-line p-4">
      <h3 id="export-title" className="text-sm font-semibold">Export this hall&apos;s record</h3>
      <p className="text-mute text-[13px] mt-1">
        For a compliance binder: the current figures and the timeline, with each figure&apos;s declared origin and class, its source file&apos;s name and review status as of now,
        who recorded it and when, and the figure it replaced. {DECLARATION}
      </p>
      <p className="data text-[10px] text-faint mt-1">The file names the people who recorded figures. It holds no file contents, storage locations or link tokens.</p>
      <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="Export formats">
        {btn("json", "Download JSON (figures and timeline)")}
        {btn("figures", "Download CSV: current figures")}
        {btn("timeline", "Download CSV: timeline")}
      </div>
      <Alert msg={f.msg} forwardRef={f.alertRef} />
    </section>
  );
}
