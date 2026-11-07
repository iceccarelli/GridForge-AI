"use client";

import { useRef, useState } from "react";

type Fields = "name" | "email" | "company" | "message" | "mw" | "urgency" | "form";
type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string; fields: Partial<Record<Fields, string>>; ref?: string };

const input =
  "mt-1.5 block min-h-11 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-base text-white placeholder:text-faint focus:border-power/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-power/60";

/**
 * The enquiry form on /contact. It posts to /api/contact, which stores the enquiry and sends no email. The page keeps the mailto beside it:
 * if this form cannot save the message, the visitor is told so in words and the address is right there. A saved message is confirmed only after
 * the server says it was saved.
 */
export function ContactForm({ email }: { email: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const summary = useRef<HTMLDivElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind === "sending") return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const body = Object.fromEntries(["name", "email", "company", "message", "mw", "urgency", "hp_contact_ref"].map((k) => [k, String(data.get(k) ?? "")]));
    setState({ kind: "sending" });
    const fail = (message: string, fields: Partial<Record<Fields, string>> = {}, ref?: string) => {
      setState({ kind: "error", message, fields, ref });
      requestAnimationFrame(() => summary.current?.focus());
    };
    try {
      const res = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; fields?: Partial<Record<Fields, string>>; ref?: string };
      if (res.ok && j.ok === true) {
        form.reset();
        setState({ kind: "sent" });
        requestAnimationFrame(() => sentRef.current?.focus());
        return;
      }
      if (res.status === 422 && j.fields) return fail("Some details need another look.", j.fields);
      if (res.status === 429) return fail(`Too many messages from this connection just now. Nothing was sent. Please try again later, or email ${email}.`);
      if (res.status === 413) return fail(`That message is too long to send here. Nothing was sent. Please shorten it, or email ${email}.`);
      // The route's own refusal ("was not saved", with a reference) says what happened and names the address. Any other server error, including
      // the rate-limit guard's generic "temporarily unavailable", is replaced by words that say the message did not go and where to write.
      if (typeof j.ref === "string" && typeof j.error === "string" && j.error) return fail(j.error, {}, j.ref);
      return fail(`Your message was not sent. The service is unavailable just now. Please try again later, or email ${email}.`);
    } catch {
      return fail(`Network error. Nothing was sent. Please try again, or email ${email}.`);
    }
  }

  if (state.kind === "sent") {
    return (
      <div ref={sentRef} tabIndex={-1} role="status" className="rounded-lg border border-verified/40 bg-verified/[0.06] p-5 outline-none focus-visible:ring-2 focus-visible:ring-power/60">
        <p className="font-semibold text-ghost">Your message was saved.</p>
        <p className="mt-2 text-[14px] leading-relaxed text-mute">
          Thank you. We make no promise about when we will reply, and no confirmation email is sent. If something is urgent, say so in an email to{" "}
          <a href={`mailto:${email}`} className="text-power underline">{email}</a>.
        </p>
      </div>
    );
  }

  const errs = state.kind === "error" ? state.fields : {};
  const field = (id: Fields) => ({
    "aria-invalid": errs[id] ? true : undefined,
    "aria-describedby": errs[id] ? `contact-${id}-err` : undefined,
  });
  const err = (id: Fields) =>
    errs[id] ? <p id={`contact-${id}-err`} className="mt-1 text-[13px] text-flag">{errs[id]}</p> : null;

  return (
    <form onSubmit={submit} aria-labelledby="form-h" className="space-y-4">
      <div ref={summary} tabIndex={-1} role="alert" className="outline-none focus-visible:ring-2 focus-visible:ring-power/60">
        {state.kind === "error" && (
          <div className="rounded-lg border border-flag/40 bg-flag/10 p-4 text-[14px] text-ghost">
            <p>{state.message}</p>
            {state.ref && <p className="mt-1 text-mute">Reference {state.ref}.</p>}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="contact-name" className="block text-sm font-medium text-ghost">Your name</label>
        <input id="contact-name" name="name" type="text" required maxLength={120} autoComplete="name" className={input} {...field("name")} />
        {err("name")}
      </div>
      <div>
        <label htmlFor="contact-email" className="block text-sm font-medium text-ghost">Work email</label>
        <input id="contact-email" name="email" type="email" required maxLength={254} autoComplete="email" className={input} {...field("email")} />
        {err("email")}
      </div>
      <div>
        <label htmlFor="contact-company" className="block text-sm font-medium text-ghost">Company</label>
        <input id="contact-company" name="company" type="text" required maxLength={160} autoComplete="organization" className={input} {...field("company")} />
        {err("company")}
      </div>
      <div>
        <label htmlFor="contact-message" className="block text-sm font-medium text-ghost">What is the hall, and what problem are you trying to solve?</label>
        <textarea id="contact-message" name="message" required minLength={10} maxLength={2000} rows={5} className={input} {...field("message")} />
        {err("message")}
      </div>
      <div>
        <label htmlFor="contact-mw" className="block text-sm font-medium text-ghost">
          Contracted capacity in MW <span className="font-normal text-mute">(optional)</span>
        </label>
        <input id="contact-mw" name="mw" type="number" inputMode="decimal" min={0} max={5000} step="any" className={input} {...field("mw")} />
        {err("mw")}
      </div>

      <div>
        <label htmlFor="contact-urgency" className="block text-sm font-medium text-ghost">How soon do you need an answer?</label>
        <select id="contact-urgency" name="urgency" required defaultValue="exploratory" className={input} {...field("urgency")}>
          <option value="immediate">As soon as possible</option>
          <option value="90days">Within about 90 days</option>
          <option value="exploratory">Just exploring</option>
        </select>
        {err("urgency")}
      </div>

      {/* Honeypot: people never see or reach this field. Hidden from assistive technology, out of the tab order, off-screen, and named so that
          browsers and password managers do not offer to fill it. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="contact-hp">Leave this field empty</label>
        <input id="contact-hp" name="hp_contact_ref" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={state.kind === "sending"} className="btn-primary inline-flex min-h-11 items-center justify-center rounded-xl px-6 text-sm disabled:opacity-60">
          {state.kind === "sending" ? "Sending…" : "Send enquiry"}
        </button>
        <p className="text-[13px] leading-relaxed text-mute">
          Stored so we can reply; no email is sent to you. See <a href="/legal/privacy" className="underline">what is stored</a>.
        </p>
      </div>
    </form>
  );
}
