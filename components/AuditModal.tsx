"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X, ArrowRight, ArrowLeft, ShieldCheck, Check, Gauge } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { AUDIT_EVENT, type AuditPrefill, type AuditOpenDetail } from "@/lib/ui";
import {
  leadSchema,
  type LeadInput,
  SERVICE_OPTIONS,
  scoreLead,
  parseCapacityMW,
} from "@/lib/lead";

const STEPS = [
  { key: "project", title: "The site", fields: ["capacity", "location", "urgency", "gridStatus"] },
  { key: "needs", title: "What you need", fields: ["services", "message"] },
  { key: "contact", title: "Where to reach you", fields: ["name", "company", "email"] },
] as const;

type FieldName = keyof LeadInput;

/** Build a prefilled message + defaults from a tool's scenario state. */
function applyPrefill(p?: AuditPrefill): Partial<LeadInput> {
  if (!p) return {};
  const out: Partial<LeadInput> = {};
  if (typeof p.capacityMW === "number") out.capacity = `${p.capacityMW} MW`;
  if (p.location) out.location = p.location;
  if (p.service) out.services = [p.service];

  // Compose an honest one-line scenario summary from whatever the tool passed.
  if (p.summary) {
    out.message = p.summary;
  } else {
    const bits: string[] = [];
    if (typeof p.capacityMW === "number") bits.push(`${p.capacityMW} MW target`);
    if (typeof p.firmPct === "number") bits.push(`${p.firmPct}% firm`);
    if (typeof p.renewablePct === "number") bits.push(`${p.renewablePct}% renewable`);
    if (p.fuel) bits.push(`${p.fuel} firming`);
    if (p.scenario) bits.push(`${p.scenario} workload`);
    if (bits.length) out.message = `Modeled scenario: ${bits.join(", ")}. `;
  }
  return out;
}

export function AuditModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] = useState<string>("general");
  const [prefill, setPrefill] = useState<AuditPrefill | undefined>();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<null | { tier: string; score: number }>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    trigger,
    watch,
    setValue,
    getValues,
  } = useForm<LeadInput>({
    resolver: zodResolver(leadSchema),
    defaultValues: { urgency: "90days", gridStatus: "unknown", services: [] },
    mode: "onTouched",
  });

  // Open handler — receive context + prefill, reset to a clean first step.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AuditOpenDetail>).detail ?? {};
      setContext(detail.context ?? "general");
      setPrefill(detail.prefill);
      setStep(0);
      setDone(null);
      reset({ urgency: "90days", gridStatus: "unknown", services: [], ...applyPrefill(detail.prefill) });
      setIsOpen(true);
    };
    window.addEventListener(AUDIT_EVENT, handler);
    return () => window.removeEventListener(AUDIT_EVENT, handler);
  }, [reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedServices = watch("services") ?? [];
  const capacityLive = watch("capacity");
  const liveMW = useMemo(() => parseCapacityMW(capacityLive), [capacityLive]);

  const next = async () => {
    const ok = await trigger([...STEPS[step].fields] as FieldName[]);
    if (ok) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const toggleService = (svc: string) => {
    const cur = getValues("services") ?? [];
    setValue(
      "services",
      cur.includes(svc) ? cur.filter((s) => s !== svc) : [...cur, svc],
      { shouldValidate: true }
    );
  };

  const onSubmit = async (data: LeadInput) => {
    const { score, tier } = scoreLead(data);
    const payload = {
      ...data,
      context,
      source: "gridforge.ai",
      capacityMW: parseCapacityMW(data.capacity),
      prefill: prefill ?? null,
    };
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setDone({ tier, score });
      reset();
    } catch {
      toast.error("That didn't go through.", {
        description: "Email power@gridforge.ai directly and we'll pick it up.",
        duration: 8000,
      });
    }
  };

  const pct = Math.round(((step + 1) / STEPS.length) * 100);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4"
          onClick={() => setIsOpen(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ ease: [0.23, 1, 0.32, 1], duration: 0.3 }}
            className="glass w-full max-w-2xl rounded-2xl overflow-hidden max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Request a power audit"
          >
            {/* Header */}
            <div className="px-7 pt-7 pb-5 border-b border-line flex justify-between items-start">
              <div>
                <div className="eyebrow mb-1">{done ? "REQUEST RECEIVED" : "START HERE"}</div>
                <h3 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                  {done ? "We've got your scenario" : "Request a Power Audit"}
                </h3>
                {!done && (
                  <p className="text-mute mt-1 text-sm">
                    Tell us about the site. You&apos;ll get a real engineer&apos;s read — not a sales call.
                  </p>
                )}
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-mute hover:text-white p-2 -mr-2"
                aria-label="Close"
              >
                <X size={22} />
              </button>
            </div>

            {done ? (
              <Confirmation tier={done.tier} mw={liveMW} onClose={() => setIsOpen(false)} />
            ) : (
              <>
                {/* Progress */}
                <div className="px-7 pt-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="eyebrow text-[10px] text-mute">
                      Step {step + 1} of {STEPS.length} · {STEPS[step].title}
                    </span>
                    {liveMW !== null && (
                      <span className="font-mono text-[11px] text-power flex items-center gap-1">
                        <Gauge size={12} /> {liveMW} MW
                      </span>
                    )}
                  </div>
                  <div className="h-1 rounded-full bg-line overflow-hidden">
                    <motion.div
                      className="h-full bg-power"
                      initial={false}
                      animate={{ width: `${pct}%` }}
                      transition={{ ease: [0.23, 1, 0.32, 1], duration: 0.4 }}
                    />
                  </div>
                </div>

                <form onSubmit={handleSubmit(onSubmit)} className="p-7 pt-5">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={step}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -16 }}
                      transition={{ duration: 0.22 }}
                      className="space-y-5 min-h-[260px]"
                    >
                      {step === 0 && (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <Field label="Target capacity" error={errors.capacity?.message}>
                              <input {...register("capacity")} className="field w-full px-4 py-3 rounded-xl" placeholder="e.g. 48 MW" />
                            </Field>
                            <Field label="Site location" error={errors.location?.message}>
                              <input {...register("location")} className="field w-full px-4 py-3 rounded-xl" placeholder="e.g. Dallas, TX / ERCOT" />
                            </Field>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <Field label="Timeline" error={errors.urgency?.message}>
                              <select {...register("urgency")} className="field w-full px-4 py-3 rounded-xl">
                                <option value="immediate">Immediate — site selected</option>
                                <option value="90days">This quarter</option>
                                <option value="exploratory">Exploratory</option>
                              </select>
                            </Field>
                            <Field label="Grid / interconnection status" error={errors.gridStatus?.message}>
                              <select {...register("gridStatus")} className="field w-full px-4 py-3 rounded-xl">
                                <option value="no_application">No application yet</option>
                                <option value="in_queue">In the queue</option>
                                <option value="study_phase">In study phase</option>
                                <option value="offer_received">Have an offer</option>
                                <option value="unknown">Not sure</option>
                              </select>
                            </Field>
                          </div>
                        </>
                      )}

                      {step === 1 && (
                        <>
                          <div>
                            <label className="eyebrow text-[10px] block mb-2 text-mute">
                              What do you need? (select all that apply)
                            </label>
                            <div className="grid grid-cols-1 gap-2">
                              {SERVICE_OPTIONS.map((svc) => {
                                const on = selectedServices.includes(svc);
                                return (
                                  <button
                                    type="button"
                                    key={svc}
                                    onClick={() => toggleService(svc)}
                                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left text-sm transition-colors ${
                                      on
                                        ? "border-power/60 bg-power/10 text-ghost"
                                        : "border-line bg-panel-2/40 text-mute hover:border-line/80"
                                    }`}
                                  >
                                    <span
                                      className={`flex items-center justify-center w-5 h-5 rounded-md border shrink-0 ${
                                        on ? "border-power bg-power text-ink" : "border-faint"
                                      }`}
                                    >
                                      {on && <Check size={13} strokeWidth={3} />}
                                    </span>
                                    {svc}
                                  </button>
                                );
                              })}
                            </div>
                            {errors.services && (
                              <p className="text-flag text-xs mt-1.5">{errors.services.message}</p>
                            )}
                          </div>
                          <Field label="What are you trying to power?" error={errors.message?.message}>
                            <textarea
                              {...register("message")}
                              rows={4}
                              className="field w-full px-4 py-3 rounded-xl resize-y min-h-[104px]"
                              placeholder="48 MW AI training cluster, interconnection quoted at 30+ months, exploring behind-the-meter hybrid + BESS for spiky inference loads…"
                            />
                          </Field>
                        </>
                      )}

                      {step === 2 && (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <Field label="Name" error={errors.name?.message}>
                              <input {...register("name")} className="field w-full px-4 py-3 rounded-xl" placeholder="Your name" />
                            </Field>
                            <Field label="Company" error={errors.company?.message}>
                              <input {...register("company")} className="field w-full px-4 py-3 rounded-xl" placeholder="Company / organization" />
                            </Field>
                          </div>
                          <Field label="Work email" error={errors.email?.message}>
                            <input type="email" {...register("email")} className="field w-full px-4 py-3 rounded-xl" placeholder="you@company.com" />
                          </Field>
                          <div className="text-xs text-faint flex items-center gap-2 pt-1">
                            <ShieldCheck size={14} className="text-verified" />
                            Held in confidence. NDA available on request.
                          </div>
                        </>
                      )}
                    </motion.div>
                  </AnimatePresence>

                  {/* Nav */}
                  <div className="flex items-center justify-between gap-4 pt-6 mt-5 border-t border-line">
                    {step > 0 ? (
                      <button type="button" onClick={back} className="btn-secondary px-5 py-3 rounded-xl text-sm flex items-center gap-2">
                        <ArrowLeft size={16} /> Back
                      </button>
                    ) : (
                      <span className="text-xs text-faint">Takes about 60 seconds.</span>
                    )}

                    {step < STEPS.length - 1 ? (
                      <button type="button" onClick={next} className="btn-primary px-7 py-3 rounded-xl text-sm flex items-center gap-2">
                        Continue <ArrowRight size={16} />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="btn-primary px-8 py-3.5 rounded-xl text-sm disabled:opacity-60 flex items-center gap-2"
                      >
                        {isSubmitting ? "Sending…" : "Send request"}
                        {!isSubmitting && <ArrowRight size={16} />}
                      </button>
                    )}
                  </div>
                </form>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Post-submit confirmation. Note: tier/score drive the *internal* routing and
 *  the founder notification — we never show a buyer a "score". We only set
 *  honest expectations about response time. */
function Confirmation({
  tier,
  mw,
  onClose,
}: {
  tier: string;
  mw: number | null;
  onClose: () => void;
}) {
  const fast = tier === "hot";
  return (
    <div className="p-7">
      <div className="flex items-center gap-3 mb-4">
        <span className="flex items-center justify-center w-11 h-11 rounded-full bg-verified/15 text-verified">
          <Check size={22} strokeWidth={2.5} />
        </span>
        <div>
          <p className="text-ghost font-medium">
            Request received{mw ? ` for your ${mw} MW site` : ""}.
          </p>
          <p className="text-mute text-sm">A real engineer reviews this — no autoresponder loop.</p>
        </div>
      </div>
      <ol className="space-y-3 text-sm text-mute border-l border-line pl-5 ml-1">
        <li>
          <span className="text-ghost">What happens next:</span>{" "}
          {fast
            ? "this looks time-sensitive, so we'll come back to you within one business day with a first read and a scoping-call link."
            : "we'll review the site and follow up within one business day."}
        </li>
        <li>The first call is a 15-minute technical scoping conversation — no pitch.</li>
        <li>NDA available before you share anything site-specific.</li>
      </ol>
      <div className="flex justify-end pt-6">
        <button onClick={onClose} className="btn-primary px-7 py-3 rounded-xl text-sm">
          Close
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="eyebrow text-[10px] block mb-2 text-mute">{label}</label>
      {children}
      {error && <p className="text-flag text-xs mt-1.5">{error}</p>}
    </div>
  );
}
