"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { loadSupabase, mayHaveSession } from "@/components/supabase-lazy";
import { CONFIRM_EMAIL_TEXT } from "@/lib/portal-links";
import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import {
  DATA_ORIGINS, DATA_ORIGIN_MEANING, EXPECTED_HALL_FIELDS, ORIGINS, ORIGINS_CAPPED_AT_E3, ORIGINS_NEEDING_A_SOURCE, ORIGIN_MEANING,
  type DataOrigin, type Origin,
} from "@/lib/site-registry-fields";

// The workspace behind /account/sites. Presentation only: every list and table is the server's answer, and every action is re-checked there
// (the address is verified, membership and role are checked by the route and again inside the database). Hiding a button protects nothing.

type Org = { id: string; name: string; role: "owner" | "editor" | "viewer"; memberId?: string; addedBy?: string; addedAt?: string };
type Hall = { id: string; siteId: string; label: string };
type Site = { id: string; orgId: string; orgName?: string; name: string; country: string | null; dataOrigin: DataOrigin; halls?: Hall[] };
type Input = {
  id: string; fieldPath: string; value: number | string | boolean | null; unit: string | null; evidenceClass: string; origin: Origin; asOf: string; recordedBy: string;
  superseded?: boolean; recordedAt?: string;
  source: { kind: string; id: string; filename: string | null; reviewStatus: string | null } | null;
};
type Event = {
  occurredAt: string; kind: string; summary: string; origin: string; evidenceClass: string | null; basis: string; superseded: boolean; projectId?: string | null;
  sourceTable?: string; sourceId?: string; subject?: string;
};

type Phase = "loading" | "unconfirmed" | "unavailable" | "ready";
type Msg = { ok: boolean; text: string } | null;

const CLASS_NAME = Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c.code, c.verb]));
const day = (iso: string) => iso.slice(0, 10);
const fieldBox = "w-full bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none disabled:opacity-50";
const button = "rounded-lg bg-power text-ink px-4 py-2 text-sm font-semibold disabled:opacity-40 hover:bg-power/90 transition-all inline-flex items-center gap-2";

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const { data } = await (await loadSupabase()).auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Two stable live regions, so a message is announced when it appears: errors in role="alert" (which also takes focus, so a keyboard user lands
 *  on what went wrong), success in role="status". */
function Alert({ msg, forwardRef }: { msg: Msg; forwardRef: React.RefObject<HTMLParagraphElement> }) {
  return (
    <>
      <p ref={forwardRef} role="alert" tabIndex={-1} className={msg && !msg.ok ? "text-[13px] mt-3 outline-none text-red-400" : "sr-only"}>{msg && !msg.ok ? msg.text : ""}</p>
      <p role="status" className={msg?.ok ? "text-[13px] mt-3 text-power" : "sr-only"}>{msg?.ok ? msg.text : ""}</p>
    </>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] text-mute mb-1">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="data text-[10px] text-faint mt-1">{hint}</p>}
    </div>
  );
}

function useForm() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const fail = (text: string) => { setMsg({ ok: false, text }); setTimeout(() => alertRef.current?.focus(), 0); };
  return { busy, setBusy, msg, setMsg, alertRef, fail };
}

export default function SitesWorkspace() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [hallId, setHallId] = useState<string | null>(null);

  // Two requests load the page: the organisations, and the sites WITH their halls. After a write the page updates from the write's own answer.
  const load = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([api("/api/orgs"), api("/api/sites")]);
      if (o.status === 401 || s.status === 401) { router.replace("/account/login"); return; }
      if (o.status === 403 || s.status === 403) { setPhase("unconfirmed"); return; }
      if (!o.body.ok || !s.body.ok) { setPhase("unavailable"); return; }
      setOrgs(o.body.orgs); setSites(s.body.sites); setPhase("ready");
    } catch { setPhase("unavailable"); }
  }, [router]);

  useEffect(() => {
    if (!mayHaveSession()) { router.replace("/account/login"); return; }
    loadSupabase().then((sb) => sb.auth.getSession()).then(({ data }) => {
      const e = data.session?.user?.email ?? null;
      if (!e) { router.replace("/account/login"); return; }
      setEmail(e);
      void load();
    }).catch(() => setPhase("unavailable"));
  }, [router, load]);

  const addedOrg = (o: { id: string; name: string }) => setOrgs((prev) => [...prev, { id: o.id, name: o.name, role: "owner" as const, addedBy: email?.toLowerCase() }].sort((x, y) => x.name.localeCompare(y.name)));
  const addedSite = (site: Site) => setSites((prev) => [...prev, { ...site, halls: site.halls ?? [] }]);
  const addedHall = (hall: Hall) => setSites((prev) => prev.map((x) => (x.id === hall.siteId ? { ...x, halls: [...(x.halls ?? []), hall].sort((a, b) => a.label.localeCompare(b.label)) } : x)));
  async function leave(org: Org) {
    if (!org.memberId || !window.confirm(`Leave ${org.name}? You lose access to its sites, halls and figures at once.`)) return null;
    const r = await api(`/api/orgs/${org.id}/members?id=${org.memberId}`, { method: "DELETE" }).catch(() => null);
    if (!r) return "Could not reach the server. Nothing was changed.";
    if (!r.body.ok) return r.body.error ?? "That did not work.";
    setOrgs((prev) => prev.filter((x) => x.id !== org.id));
    setSites((prev) => prev.filter((x) => x.orgId !== org.id));
    setHallId(null);
    return null;
  }

  if (phase === "loading") return <div className="flex justify-center pt-24" role="status" aria-label="Loading"><Loader2 className="animate-spin text-power" /></div>;

  const header = (
    <div className="mb-8">
      <div className="eyebrow text-power mb-2">Sites and halls</div>
      <h1 className="text-3xl font-semibold tracking-tight">What is recorded about your halls</h1>
      <p className="text-mute text-sm mt-1">{email} · <Link href="/account" className="underline hover:text-white">Back to your account</Link></p>
    </div>
  );

  if (phase === "unconfirmed") {
    return <>{header}<p role="alert" className="rounded-lg border border-queue/40 bg-queue/10 px-4 py-3 text-[13px]">{CONFIRM_EMAIL_TEXT}</p></>;
  }
  if (phase === "unavailable") {
    return <>{header}<p role="alert" className="rounded-lg border border-line bg-panel px-4 py-3 text-[13px] text-mute">We could not load your registry just now. Nothing has been changed. Reload in a moment.</p></>;
  }

  const roleIn = (orgId: string) => orgs.find((o) => o.id === orgId)?.role;
  const canWrite = (orgId: string) => ["owner", "editor"].includes(roleIn(orgId) ?? "");
  const selectedHall = hallId ? sites.flatMap((x) => x.halls ?? []).find((h) => h.id === hallId) : undefined;
  const selectedSite = selectedHall ? sites.find((s) => s.id === selectedHall.siteId) : undefined;

  return (
    <>
      {header}
      <section aria-labelledby="honesty" className="rounded-[var(--radius)] border border-line bg-panel p-5 mb-8">
        <h2 id="honesty" className="text-sm font-semibold mb-2">How to read these figures</h2>
        <p className="text-mute text-[13px]">
          Every figure here was typed in by a person at your organisation. Its <strong className="text-white">origin</strong> (measured, observed, vendor, quotation,
          modelled, assumed or missing) and its <strong className="text-white">evidence class</strong> (E0 to E7) are that person&apos;s declaration; nothing on this page
          checks them against the real hall. A figure is shown as measured only when its origin says so and a source file is attached, and even then the file may not
          have been reviewed. A figure nobody has recorded is shown as <em>missing</em>, not left blank, and a correction never overwrites: the earlier figure stays in the history.
        </p>
      </section>

      <NewOrg onCreated={addedOrg} />

      {orgs.length === 0 && <p className="text-mute text-[13px] mb-8">You are not in an organisation yet. Create one above; you become its owner and can add the people you work with.</p>}

      {orgs.map((o) => (
        <section key={o.id} aria-labelledby={`org-${o.id}`} className="mb-10">
          {o.addedBy && o.addedBy !== email?.toLowerCase() && <AddedNotice org={o} onLeave={leave} />}
          <h2 id={`org-${o.id}`} className="text-xl font-semibold tracking-tight">{o.name} <span className="data text-[10px] uppercase text-faint align-middle">your role: {o.role}</span></h2>
          <ul className="mt-4 space-y-4">
            {sites.filter((s) => s.orgId === o.id).map((s) => (
              <li key={s.id} className="rounded-[var(--radius)] border border-line bg-panel p-5">
                <h3 className="font-semibold">{s.name} <span className="data text-[10px] uppercase text-faint">{s.country ?? "no country"}</span></h3>
                <p className="data text-[10px] text-faint mt-0.5" title={DATA_ORIGIN_MEANING[s.dataOrigin]}>Data kind: {s.dataOrigin}. {DATA_ORIGIN_MEANING[s.dataOrigin]}</p>
                <ul className="flex flex-wrap gap-2 mt-3" aria-label={`Halls at ${s.name}`}>
                  {(s.halls ?? []).map((h) => (
                    <li key={h.id}>
                      <button type="button" onClick={() => setHallId(h.id)} aria-pressed={hallId === h.id}
                        className={`rounded-lg border px-3 py-1.5 text-[13px] ${hallId === h.id ? "border-power text-power" : "border-line text-mute hover:text-white"}`}>{h.label}</button>
                    </li>
                  ))}
                  {(s.halls ?? []).length === 0 && <li className="text-mute text-[13px]">No halls yet.</li>}
                </ul>
                {canWrite(o.id) && <NewHall site={s} onCreated={addedHall} />}
              </li>
            ))}
            {sites.filter((s) => s.orgId === o.id).length === 0 && <li className="text-mute text-[13px]">No sites yet.</li>}
          </ul>
          {canWrite(o.id) ? <NewSite org={o} onCreated={addedSite} /> : <p className="text-mute text-[13px] mt-3">You can read this organisation&apos;s registry. Only an editor or owner can change it.</p>}
        </section>
      ))}

      {selectedHall && selectedSite && (
        <HallPanel key={selectedHall.id} hall={selectedHall} site={selectedSite} canWrite={canWrite(selectedSite.orgId)} isOwner={roleIn(selectedSite.orgId) === "owner"} />
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------- forms

/** Tells a person they were ADDED to an organisation (there is no acceptance step) and lets them leave. */
export function AddedNotice({ org, onLeave }: { org: Org; onLeave: (o: Org) => Promise<string | null> }) {
  const f = useForm();
  async function go() {
    f.setBusy(true); f.setMsg(null);
    const err = await onLeave(org);
    f.setBusy(false);
    if (err) f.fail(err);
  }
  return (
    <div className="mb-3 rounded-lg border border-line bg-panel px-4 py-3 text-[13px]" role="group" aria-label={`You were added to ${org.name}`}>
      <p className="text-mute">
        Added by <span className="text-white">{org.addedBy}</span> to <span className="text-white">{org.name}</span>{org.addedAt ? ` on ${org.addedAt.slice(0, 10)}` : ""} as {org.role}.
        You did not have to accept; you can see what they record here, and you can leave at any time.
      </p>
      <button type="button" onClick={go} disabled={f.busy} className="mt-2 rounded-lg border border-line px-3 py-1.5 text-[13px] text-mute hover:text-white disabled:opacity-40">Leave {org.name}</button>
      <Alert msg={f.msg} forwardRef={f.alertRef} />
    </div>
  );
}

export function NewOrg({ onCreated }: { onCreated: (o: { id: string; name: string }) => void }) {
  const f = useForm();
  const [name, setName] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return f.fail("Give the organisation a name.");
    f.setBusy(true); f.setMsg(null);
    const r = await api("/api/orgs", { method: "POST", body: { name } }).catch(() => null);
    f.setBusy(false);
    if (!r) return f.fail("Could not reach the server. Nothing was saved.");
    if (r.body.ok) { setName(""); f.setMsg({ ok: true, text: "Organisation created. You are its owner." }); onCreated(r.body.org); } else f.fail(r.body.error ?? "That did not work.");
  }
  return (
    <form onSubmit={submit} noValidate aria-labelledby="new-org-title" className="mb-8 flex flex-wrap items-end gap-3">
      <h2 id="new-org-title" className="sr-only">Create an organisation</h2>
      <div className="flex-1 min-w-[14rem]"><Field id="new-org-name" label="New organisation"><input id="new-org-name" className={fieldBox} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="organization" /></Field></div>
      <button type="submit" disabled={f.busy} className={button}>{f.busy ? <Loader2 size={14} className="animate-spin" /> : "Create organisation"}</button>
      <div className="basis-full"><Alert msg={f.msg} forwardRef={f.alertRef} /></div>
    </form>
  );
}

export function NewSite({ org, onCreated }: { org: Org; onCreated: (s: Site) => void }) {
  const f = useForm();
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [dataOrigin, setDataOrigin] = useState<DataOrigin | "">("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return f.fail("Give the site a name.");
    if (!dataOrigin) return f.fail("Say whether this site holds production, test or synthetic data.");
    if (country.trim() && !/^[A-Za-z]{2}$/.test(country.trim())) return f.fail("Use a two-letter country code, for example DE, or leave it empty.");
    f.setBusy(true); f.setMsg(null);
    const r = await api("/api/sites", { method: "POST", body: { orgId: org.id, name, country: country.trim() || null, dataOrigin } }).catch(() => null);
    f.setBusy(false);
    if (!r) return f.fail("Could not reach the server. Nothing was saved.");
    if (r.body.ok) { setName(""); setCountry(""); setDataOrigin(""); f.setMsg({ ok: true, text: "Site added." }); onCreated({ ...r.body.site, orgName: org.name }); } else f.fail(r.body.error ?? "That did not work.");
  }
  const p = `new-site-${org.id}`;
  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${p}-title`} className="mt-4 rounded-lg border border-line p-4 grid gap-3 sm:grid-cols-4 items-start">
      <h3 id={`${p}-title`} className="sm:col-span-4 text-sm font-semibold">Add a site to {org.name}</h3>
      <Field id={`${p}-name`} label="Site name"><input id={`${p}-name`} className={fieldBox} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
      <Field id={`${p}-country`} label="Country (optional)" hint="Two letters, for example DE."><input id={`${p}-country`} className={fieldBox} value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} /></Field>
      <div className="sm:col-span-2">
        <Field id={`${p}-origin`} label="What kind of data does this site hold?" hint={dataOrigin ? DATA_ORIGIN_MEANING[dataOrigin] : "Required. It cannot be changed later."}>
          <select id={`${p}-origin`} className={fieldBox} value={dataOrigin} onChange={(e) => setDataOrigin(e.target.value as DataOrigin | "")} aria-describedby={`${p}-origin-hint`} aria-required="true">
            <option value="">Choose…</option>
            {DATA_ORIGINS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
      </div>
      <div className="sm:col-span-4"><button type="submit" disabled={f.busy} className={button}>{f.busy ? <Loader2 size={14} className="animate-spin" /> : "Add site"}</button><Alert msg={f.msg} forwardRef={f.alertRef} /></div>
    </form>
  );
}

export function NewHall({ site, onCreated }: { site: Site; onCreated: (h: Hall) => void }) {
  const f = useForm();
  const [label, setLabel] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return f.fail("Give the hall a label.");
    f.setBusy(true); f.setMsg(null);
    const r = await api(`/api/sites/${site.id}/halls`, { method: "POST", body: { label } }).catch(() => null);
    f.setBusy(false);
    if (!r) return f.fail("Could not reach the server. Nothing was saved.");
    if (r.body.ok) { setLabel(""); f.setMsg({ ok: true, text: "Hall added." }); onCreated(r.body.hall); } else f.fail(r.body.error ?? "That did not work.");
  }
  return (
    <form onSubmit={submit} noValidate aria-label={`Add a hall to ${site.name}`} className="mt-4 flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[12rem]"><Field id={`new-hall-${site.id}`} label="New hall label"><input id={`new-hall-${site.id}`} className={fieldBox} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} /></Field></div>
      <button type="submit" disabled={f.busy} className={button}>{f.busy ? <Loader2 size={14} className="animate-spin" /> : "Add hall"}</button>
      <div className="basis-full"><Alert msg={f.msg} forwardRef={f.alertRef} /></div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------- one hall

const PAGE = 30;

function HallPanel({ hall, site, canWrite, isOwner }: { hall: Hall; site: Site; canWrite: boolean; isOwner: boolean }) {
  const [inputs, setInputs] = useState<Input[] | null>(null);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [older, setOlder] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    try {
      const t = await api(`/api/halls/${hall.id}/timeline?limit=${PAGE}`);
      if (t.body.ok) { setEvents(t.body.events); setNextCursor(t.body.truncated ? t.body.nextCursor : null); } else setEvents((e) => e ?? []);
    } catch { setEvents((e) => e ?? []); }
  }, [hall.id]);

  // On opening a hall: its current figures and the newest page of its timeline. Nothing else is reloaded afterwards except the timeline's first page.
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const [i] = await Promise.all([api(`/api/halls/${hall.id}/inputs`), loadTimeline()]);
        if (!on) return;
        if (!i.body.ok) { setError(i.body.error ?? "Could not load this hall."); return; }
        setError(null); setInputs(i.body.inputs);
      } catch { if (on) setError("Could not reach the server."); }
    })();
    return () => { on = false; };
  }, [hall.id, loadTimeline]);

  /** The write's own answer updates the table; only the timeline's first page is fetched again. */
  function recorded(input: Input) {
    setInputs((prev) => [...(prev ?? []).filter((x) => x.fieldPath !== input.fieldPath), input].sort((a, b) => a.fieldPath.localeCompare(b.fieldPath)));
    void loadTimeline();
  }

  async function loadOlder() {
    if (!nextCursor) return;
    setOlder({ busy: true, error: null });
    try {
      const t = await api(`/api/halls/${hall.id}/timeline?limit=${PAGE}&cursor=${encodeURIComponent(nextCursor)}`);
      if (!t.body.ok) { setOlder({ busy: false, error: t.body.error ?? "Could not load older events." }); return; }
      setEvents((e) => [...(e ?? []), ...t.body.events]);
      setNextCursor(t.body.truncated ? t.body.nextCursor : null);
      setOlder({ busy: false, error: null });
    } catch { setOlder({ busy: false, error: "Could not reach the server." }); }
  }

  async function detach(projectId: string): Promise<string | null> {
    if (!window.confirm("Detach this project from the hall? Its log stops appearing here; the attachment and this detachment stay in the history.")) return null;
    const r = await api(`/api/halls/${hall.id}/projects?project=${projectId}`, { method: "DELETE" }).catch(() => null);
    if (!r) return "Could not reach the server. Nothing was changed.";
    if (!r.body.ok) return r.body.error ?? "That did not work.";
    await loadTimeline();
    return null;
  }

  return (
    <section aria-labelledby="hall-title" className="rounded-[var(--radius)] border border-line bg-panel p-6">
      <h2 id="hall-title" className="text-xl font-semibold tracking-tight">{hall.label} <span className="data text-[10px] uppercase text-faint align-middle">at {site.name} · {site.dataOrigin} data</span></h2>
      {error && <p role="alert" className="text-red-400 text-[13px] mt-3">{error}</p>}
      {inputs === null && !error && <Loader2 className="animate-spin text-power mt-4" size={18} aria-label="Loading" />}
      {inputs && <InputsTable inputs={inputs} onHistory={setHistoryFor} />}
      {inputs && historyFor && <FieldHistory hall={hall} path={historyFor} onClose={() => setHistoryFor(null)} />}
      {inputs && canWrite && <RecordInput hall={hall} current={inputs} onRecorded={recorded} />}
      {canWrite && <AttachProject hall={hall} onDone={loadTimeline} />}
      {events && (
        <Timeline events={events} more={nextCursor !== null} onOlder={loadOlder} older={older} onDetach={isOwner ? detach : undefined} />
      )}
    </section>
  );
}

function valueText(i: Input): string {
  if (i.origin === "missing" || i.value === null) return "missing";
  return `${String(i.value)}${i.unit ? " " + i.unit : ""}`;
}

/** What the origin cell says: a figure's origin is the recorder's declaration, so it reads "declared measured", not "measured". */
export function originText(o: Origin): string {
  return o === "missing" ? "missing" : `declared ${o}`;
}

export function sourceText(i: Input): string {
  if (!i.source) return i.origin === "missing" ? "none (missing)" : "no file cited";
  const name = i.source.filename ?? "a file";
  // A purchased engagement's file has no review step at all; a project file has a live review status.
  if (i.source.kind === "intake_evidence") return `${name} (file not reviewable)`;
  const review = i.source.reviewStatus === "verified" ? "file reviewed and verified" : i.source.reviewStatus === "rejected" ? "file rejected" : "file not yet reviewed";
  return `${name} (${review})`;
}

export function InputsTable({ inputs, onHistory }: { inputs: Input[]; onHistory?: (path: string) => void }) {
  const byPath = new Map(inputs.map((i) => [i.fieldPath, i]));
  const expected = EXPECTED_HALL_FIELDS.map((f) => ({ path: f.path, label: f.label, input: byPath.get(f.path) ?? null }));
  const others = inputs.filter((i) => !EXPECTED_HALL_FIELDS.some((f) => f.path === i.fieldPath)).map((i) => ({ path: i.fieldPath, label: "", input: i }));
  const cell = "px-3 py-2 align-top text-[13px]";
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left border-collapse">
        <caption className="text-left text-mute text-[12px] mb-2">
          Current figures. Origin and class are declared by the person who recorded the figure, not verified by this page.
        </caption>
        <thead>
          <tr className="border-b border-line text-faint data text-[10px] uppercase">
            {["Field", "Value", "Origin", "Declared class", "As of", "Source", "Recorded by"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-normal">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {[...expected, ...others].map(({ path, label, input: i }) => (
            <tr key={path}>
              <th scope="row" className={`${cell} font-normal text-white`}>
                {label ? <>{label}<span className="block data text-[10px] text-faint">{path}</span></> : path}
                {i && onHistory && <button type="button" onClick={() => onHistory(path)} aria-label={`History of ${path}`} className="block mt-1 text-[11px] text-mute underline hover:text-white">History</button>}
              </th>
              {i ? (
                <>
                  <td className={`${cell} ${i.origin === "missing" ? "text-queue" : "text-white"}`}>{valueText(i)}</td>
                  <td className={cell}>{originText(i.origin)}</td>
                  <td className={cell}>{i.evidenceClass} <span className="text-faint">({CLASS_NAME[i.evidenceClass] ?? "?"})</span></td>
                  <td className={cell}>{i.asOf}</td>
                  <td className={cell}>{sourceText(i)}</td>
                  <td className={cell}>{i.recordedBy}</td>
                </>
              ) : (
                <>
                  <td className={`${cell} text-queue`}>missing</td>
                  <td className={`${cell} text-queue`}>missing</td>
                  <td className={`${cell} text-faint`}>none: nothing recorded</td>
                  <td className={`${cell} text-faint`}>not recorded</td>
                  <td className={`${cell} text-faint`}>none</td>
                  <td className={`${cell} text-faint`}>not recorded</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every claim ever made about ONE field, newest first: a correction never overwrites, so the earlier figures are here. */
export function FieldHistory({ hall, path, onClose }: { hall: Hall; path: string; onClose: () => void }) {
  const [rows, setRows] = useState<Input[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let on = true;
    setRows(null); setError(null);
    api(`/api/halls/${hall.id}/inputs?history=1&field=${encodeURIComponent(path)}`).then((r) => {
      if (!on) return;
      if (!r.body.ok) { setError(r.body.error ?? "Could not load the history."); return; }
      setRows(r.body.inputs); setTruncated(Boolean(r.body.truncated));
      setTimeout(() => head.current?.focus(), 0);
    }).catch(() => on && setError("Could not reach the server."));
    return () => { on = false; };
  }, [hall.id, path]);
  return (
    <section aria-labelledby="history-title" className="mt-5 rounded-lg border border-line p-4">
      <h3 id="history-title" ref={head} tabIndex={-1} className="text-sm font-semibold outline-none">History of {path}</h3>
      {error && <p role="alert" className="text-red-400 text-[13px] mt-2">{error}</p>}
      {!rows && !error && <Loader2 className="animate-spin text-power mt-2" size={16} aria-label="Loading" />}
      {rows && (
        <ol className="mt-2 divide-y divide-line/60 text-[13px]">
          {rows.map((i) => (
            <li key={i.id} className="py-2">
              <span className={i.superseded ? "text-faint line-through" : "text-white"}>{valueText(i)}</span>{" "}
              <span className="text-mute">{originText(i.origin)} · declared class {i.evidenceClass} · as of {i.asOf} · {sourceText(i)} · recorded by {i.recordedBy}</span>
              {i.superseded ? <span className="data text-[10px] text-faint"> · replaced by a later figure</span> : <span className="data text-[10px] text-power"> · current</span>}
            </li>
          ))}
        </ol>
      )}
      {truncated && <p className="data text-[10px] text-faint mt-2">Older claims of this field are not shown.</p>}
      <button type="button" onClick={onClose} className="mt-3 text-[12px] text-mute underline hover:text-white">Close history</button>
    </section>
  );
}

export function RecordInput({ hall, current, onRecorded }: { hall: Hall; current: Input[]; onRecorded: (i: Input) => void }) {
  const f = useForm();
  const today = new Date().toISOString().slice(0, 10);
  const [path, setPath] = useState("");
  const [origin, setOrigin] = useState<Origin>("assumed");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [cls, setCls] = useState("E0");
  const [asOf, setAsOf] = useState(today);
  const [srcKind, setSrcKind] = useState<"none" | "project" | "intake">("none");
  const [srcId, setSrcId] = useState("");
  const replaces = current.find((i) => i.fieldPath === path.trim());
  const capped = ORIGINS_CAPPED_AT_E3.includes(origin);
  const needsSource = ORIGINS_NEEDING_A_SOURCE.includes(origin);

  /** Choosing a field fills in its usual unit (or the unit of the figure it would replace), so a correction does not silently lose it. */
  function onPath(next: string) {
    setPath(next);
    const p = next.trim();
    const known = current.find((i) => i.fieldPath === p)?.unit ?? EXPECTED_HALL_FIELDS.find((x) => x.path === p)?.unit ?? "";
    if (known && origin !== "missing") setUnit(known);
  }

  function onOrigin(o: Origin) {
    setOrigin(o);
    if (o === "missing") { setValue(""); setUnit(""); setCls("E0"); setSrcKind("none"); setSrcId(""); }
    if (ORIGINS_CAPPED_AT_E3.includes(o) && cls > "E3") setCls("E3");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = path.trim();
    if (!p) return f.fail("Say which field this is, for example grid.firm_capacity_MVA.");
    let v: number | string | null = null;
    if (origin !== "missing") {
      if (!value.trim()) return f.fail("Give a value, or choose the origin “missing”.");
      v = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim()) ? Number(value.trim()) : value.trim();
    }
    if (unit.trim() && typeof v !== "number") return f.fail("A unit belongs only to a number.");
    if (needsSource && (srcKind === "none" || !srcId.trim())) return f.fail(`A ${origin} figure needs a source file: choose its kind and paste its id.`);
    if (!asOf) return f.fail("Say what date the figure is as of.");
    f.setBusy(true); f.setMsg(null);
    const r = await api(`/api/halls/${hall.id}/inputs`, {
      method: "POST",
      body: {
        fieldPath: p, value: v, unit: unit.trim() || null, evidenceClass: cls, origin, asOf,
        projectEvidenceId: srcKind === "project" ? srcId.trim() : null, intakeEvidenceFileId: srcKind === "intake" ? srcId.trim() : null,
        supersedes: replaces?.id ?? null,
      },
    }).catch(() => null);
    f.setBusy(false);
    if (!r) return f.fail("Could not reach the server. Nothing was saved.");
    if (r.body.ok) {
      f.setMsg({ ok: true, text: replaces ? "Correction recorded. The earlier figure stays in the history." : "Figure recorded." });
      setValue(""); setUnit(""); setSrcId(""); setSrcKind("none");
      if (r.body.input) onRecorded(r.body.input);
    } else {
      const issue = Array.isArray(r.body.issues) && r.body.issues[0] ? ` ${r.body.issues[0].field}: ${r.body.issues[0].message}` : "";
      f.fail((r.body.error ?? "That did not work.") + issue);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="record-title" className="mt-8 rounded-lg border border-line p-4 grid gap-3 sm:grid-cols-2 items-start">
      <h3 id="record-title" className="sm:col-span-2 text-sm font-semibold">Record a figure</h3>
      <Field id="rec-path" label="Field" hint={replaces ? `This field already has a value (${valueText(replaces)}). Your entry will replace it; the earlier figure stays in the history.` : "An intake path. Pick one or type your own."}>
        <input id="rec-path" list="rec-paths" className={fieldBox} value={path} onChange={(e) => onPath(e.target.value)} aria-describedby="rec-path-hint" aria-required="true" autoComplete="off" />
        <datalist id="rec-paths">{EXPECTED_HALL_FIELDS.map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}</datalist>
      </Field>
      <Field id="rec-origin" label="Origin" hint={ORIGIN_MEANING[origin]}>
        <select id="rec-origin" className={fieldBox} value={origin} onChange={(e) => onOrigin(e.target.value as Origin)} aria-describedby="rec-origin-hint">
          {ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
      <Field id="rec-value" label="Value" hint={origin === "missing" ? "A missing input has no value." : "A number, or a short text."}>
        <input id="rec-value" className={fieldBox} value={value} onChange={(e) => setValue(e.target.value)} disabled={origin === "missing"} aria-describedby="rec-value-hint" inputMode="decimal" autoComplete="off" />
      </Field>
      <Field id="rec-unit" label="Unit (optional)"><input id="rec-unit" className={fieldBox} value={unit} onChange={(e) => setUnit(e.target.value)} disabled={origin === "missing"} maxLength={24} autoComplete="off" /></Field>
      <Field id="rec-class" label="Declared evidence class (your declaration)" hint={origin === "missing" ? "A missing input is class E0." : capped ? "An assumed or modelled figure cannot claim a class above E3." : "What has been done to this number. Declared by you, not checked here. Above E3 needs a reviewed and verified project file."}>
        <select id="rec-class" className={fieldBox} value={cls} onChange={(e) => setCls(e.target.value)} disabled={origin === "missing"} aria-describedby="rec-class-hint">
          {EVIDENCE_CLASSES.map((c) => <option key={c.code} value={c.code} disabled={capped && c.code > "E3"}>{c.code} · {c.verb}</option>)}
        </select>
      </Field>
      <Field id="rec-asof" label="As of (date the figure is true for)"><input id="rec-asof" type="date" className={fieldBox} value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} aria-required="true" /></Field>
      <Field id="rec-src-kind" label="Source file" hint={needsSource ? `A ${origin} figure needs one.` : "Optional."}>
        <select id="rec-src-kind" className={fieldBox} value={srcKind} onChange={(e) => setSrcKind(e.target.value as "none" | "project" | "intake")} disabled={origin === "missing"} aria-describedby="rec-src-kind-hint">
          <option value="none">No file</option>
          <option value="project">A file of a project attached to this hall</option>
          <option value="intake">A file from an engagement I bought</option>
        </select>
      </Field>
      <Field id="rec-src-id" label="Source file id"><input id="rec-src-id" className={fieldBox} value={srcId} onChange={(e) => setSrcId(e.target.value)} disabled={srcKind === "none" || origin === "missing"} autoComplete="off" /></Field>
      <div className="sm:col-span-2"><button type="submit" disabled={f.busy} className={button}>{f.busy ? <Loader2 size={14} className="animate-spin" /> : replaces ? "Record a correction" : "Record figure"}</button><Alert msg={f.msg} forwardRef={f.alertRef} /></div>
    </form>
  );
}

export function AttachProject({ hall, onDone }: { hall: Hall; onDone: () => Promise<void> }) {
  const f = useForm();
  const [token, setToken] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (token.trim().length < 8) return f.fail("Paste the project's link token.");
    f.setBusy(true); f.setMsg(null);
    const r = await api(`/api/halls/${hall.id}/projects`, { method: "POST", body: { projectToken: token.trim() } }).catch(() => null);
    f.setBusy(false);
    if (!r) return f.fail("Could not reach the server. Nothing was saved.");
    if (r.body.ok) { setToken(""); f.setMsg({ ok: true, text: r.body.alreadyAttached ? `${r.body.projectName} was already attached.` : `${r.body.projectName} attached. Its history now appears below.` }); await onDone(); } else f.fail(r.body.error ?? "That did not work.");
  }
  return (
    <form onSubmit={submit} noValidate aria-labelledby="attach-title" className="mt-6 flex flex-wrap items-end gap-3">
      <h3 id="attach-title" className="basis-full text-sm font-semibold">Attach a project</h3>
      <div className="flex-1 min-w-[14rem]"><Field id="attach-token" label="Project link token" hint="A project belongs to one hall, for good."><input id="attach-token" type="password" className={fieldBox} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" aria-describedby="attach-token-hint" /></Field></div>
      <button type="submit" disabled={f.busy} className={button}>{f.busy ? <Loader2 size={14} className="animate-spin" /> : "Attach project"}</button>
      <div className="basis-full"><Alert msg={f.msg} forwardRef={f.alertRef} /></div>
    </form>
  );
}

export function Timeline({ events, more, onOlder, older, onDetach }: {
  events: Event[]; more?: boolean; onOlder?: () => void; older?: { busy: boolean; error: string | null }; onDetach?: (projectId: string) => Promise<string | null>;
}) {
  const f = useForm();
  const olderRef = useRef<HTMLButtonElement>(null);
  // Newest first, so the first attach/detach line seen for a project says whether it is attached NOW (as far as the loaded events show).
  const attachedNow = new Set<string>();
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.projectId || seen.has(e.projectId) || !["project_attached", "project_detached"].includes(e.kind)) continue;
    seen.add(e.projectId);
    if (e.kind === "project_attached") attachedNow.add(e.projectId);
  }
  async function detach(id: string) {
    f.setBusy(true); f.setMsg(null);
    const err = onDetach ? await onDetach(id) : null;
    f.setBusy(false);
    if (err) f.fail(err);
  }
  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold mb-2">Timeline</h3>
      {events.length === 0 ? <p className="text-mute text-[13px]">Nothing has happened at this hall yet.</p> : (
        <ol className="divide-y divide-line/60 rounded-lg border border-line">
          {events.map((e, n) => (
            <li key={`${e.sourceTable ?? ""}${e.sourceId ?? ""}${e.subject ?? ""}${n}`} className="px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <time dateTime={e.occurredAt} className="data text-[10px] text-faint">{day(e.occurredAt)}</time>
                <span className={e.superseded ? "text-faint line-through" : "text-white"}>{e.summary}</span>
                {e.superseded && <span className="data text-[10px] text-faint">replaced by a later figure</span>}
                {onDetach && e.kind === "project_attached" && e.projectId && attachedNow.has(e.projectId) && (
                  <button type="button" disabled={f.busy} onClick={() => void detach(e.projectId as string)} className="text-[11px] text-mute underline hover:text-white disabled:opacity-40">Detach this project</button>
                )}
              </div>
              <p className="data text-[10px] text-faint mt-0.5">{e.origin}{e.evidenceClass ? ` · declared class ${e.evidenceClass}` : ""} · {e.basis}</p>
            </li>
          ))}
        </ol>
      )}
      {more && (
        <div className="mt-3" role="group" aria-label="Older events">
          <p className="text-mute text-[12px]" id="older-note">Older events are not shown. This is the newest {events.length}.</p>
          <button ref={olderRef} type="button" onClick={onOlder} disabled={older?.busy} aria-describedby="older-note" className="mt-2 rounded-lg border border-line px-3 py-1.5 text-[13px] text-mute hover:text-white disabled:opacity-40">
            {older?.busy ? <Loader2 size={14} className="animate-spin" /> : "Load older events"}
          </button>
          <p role="alert" className={older?.error ? "text-red-400 text-[13px] mt-2" : "sr-only"}>{older?.error ?? ""}</p>
        </div>
      )}
      <Alert msg={f.msg} forwardRef={f.alertRef} />
    </div>
  );
}
