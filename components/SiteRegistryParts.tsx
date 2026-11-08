"use client";

import { useRef, useState } from "react";

// The small pieces every part of the sites workspace shares: the two live regions, a labelled field, the form state, and the class names.

export type Msg = { ok: boolean; text: string } | null;

export const fieldBox = "w-full bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none disabled:opacity-50";
export const button = "rounded-lg bg-power text-ink px-4 py-2 text-sm font-semibold disabled:opacity-40 hover:bg-power/90 transition-all inline-flex items-center gap-2";
export const quietButton = "rounded-lg border border-line px-3 py-1.5 text-[13px] text-mute hover:text-white disabled:opacity-40 inline-flex items-center gap-2";

/** Two stable live regions, so a message is announced when it appears: errors in role="alert" (which also takes focus, so a keyboard user lands
 *  on what went wrong), success in role="status". */
export function Alert({ msg, forwardRef }: { msg: Msg; forwardRef: React.RefObject<HTMLParagraphElement> }) {
  return (
    <>
      <p ref={forwardRef} role="alert" tabIndex={-1} className={msg && !msg.ok ? "text-[13px] mt-3 outline-none text-red-400" : "sr-only"}>{msg && !msg.ok ? msg.text : ""}</p>
      <p role="status" className={msg?.ok ? "text-[13px] mt-3 text-power" : "sr-only"}>{msg?.ok ? msg.text : ""}</p>
    </>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] text-mute mb-1">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="data text-[10px] text-faint mt-1">{hint}</p>}
    </div>
  );
}

export function useForm() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const fail = (text: string) => { setMsg({ ok: false, text }); setTimeout(() => alertRef.current?.focus(), 0); };
  return { busy, setBusy, msg, setMsg, alertRef, fail };
}
