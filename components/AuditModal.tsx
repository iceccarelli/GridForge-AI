"use client";

import React, { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { X, ArrowRight, ShieldCheck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { AUDIT_EVENT } from "@/lib/ui";

const schema = z.object({
  name: z.string().min(2, "Your name"),
  company: z.string().min(2, "Company or organization"),
  email: z.string().email("A valid work email"),
  location: z.string().min(3, "Where is the site?"),
  capacity: z.string().optional(),
  urgency: z.enum(["immediate", "90days", "exploratory"]),
  message: z.string().min(10, "A line or two about the project"),
});
type FormData = z.infer<typeof schema>;

/**
 * Mounted once (in layout). Opens on the `gridforge:open-audit` window event,
 * so every CTA across the site can trigger it. Submits to Formspree when
 * NEXT_PUBLIC_FORMSPREE_ID is configured, otherwise to the /api/audit route —
 * it never silently drops a lead.
 */
export function AuditModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] = useState<string | undefined>();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setContext(detail?.context);
      setIsOpen(true);
    };
    window.addEventListener(AUDIT_EVENT, handler);
    return () => window.removeEventListener(AUDIT_EVENT, handler);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { urgency: "90days" },
  });

  const onSubmit = async (data: FormData) => {
    const payload = { ...data, context: context ?? "general", source: "gridforge.ai" };
    const formspreeId = process.env.NEXT_PUBLIC_FORMSPREE_ID;

    try {
      const endpoint = formspreeId
        ? `https://formspree.io/f/${formspreeId}`
        : "/api/audit";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);

      toast.success("Request received.", {
        description:
          "We'll review your site and follow up within one business day.",
        duration: 6000,
      });
      reset();
      setIsOpen(false);
    } catch {
      toast.error("That didn't go through.", {
        description: `Email us directly at power@gridforge.ai and we'll pick it up.`,
        duration: 8000,
      });
    }
  };

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
            <div className="px-7 pt-7 pb-5 border-b border-line flex justify-between items-start">
              <div>
                <div className="eyebrow mb-1">START HERE</div>
                <h3 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                  Request a Power Audit
                </h3>
                <p className="text-mute mt-1 text-sm">
                  Tell us about the site. You'll get a real engineer's read — not a sales call.
                </p>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-mute hover:text-white p-2 -mr-2"
                aria-label="Close"
              >
                <X size={22} />
              </button>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="p-7 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <Field label="Name" error={errors.name?.message}>
                  <input {...register("name")} className="field w-full px-4 py-3 rounded-xl" placeholder="Your name" />
                </Field>
                <Field label="Company" error={errors.company?.message}>
                  <input {...register("company")} className="field w-full px-4 py-3 rounded-xl" placeholder="Company / organization" />
                </Field>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <Field label="Work email" error={errors.email?.message}>
                  <input type="email" {...register("email")} className="field w-full px-4 py-3 rounded-xl" placeholder="you@company.com" />
                </Field>
                <Field label="Site location" error={errors.location?.message}>
                  <input {...register("location")} className="field w-full px-4 py-3 rounded-xl" placeholder="e.g. Dallas, TX or Frankfurt" />
                </Field>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <Field label="Target capacity (optional)">
                  <input {...register("capacity")} className="field w-full px-4 py-3 rounded-xl" placeholder="e.g. 48 MW" />
                </Field>
                <Field label="Timeline">
                  <select {...register("urgency")} className="field w-full px-4 py-3 rounded-xl">
                    <option value="immediate">Immediate — site selected</option>
                    <option value="90days">This quarter</option>
                    <option value="exploratory">Exploratory</option>
                  </select>
                </Field>
              </div>

              <Field label="What are you trying to power?" error={errors.message?.message}>
                <textarea
                  {...register("message")}
                  rows={4}
                  className="field w-full px-4 py-3 rounded-xl resize-y min-h-[104px]"
                  placeholder="48 MW AI training cluster, interconnection quoted at 30+ months, exploring behind-the-meter hybrid + BESS for spiky inference loads…"
                />
              </Field>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-3 border-t border-line">
                <div className="text-xs text-faint flex items-center gap-2">
                  <ShieldCheck size={14} className="text-verified" />
                  Held in confidence. NDA available on request.
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn-primary px-8 py-3.5 rounded-xl text-sm disabled:opacity-60 flex items-center gap-2 w-full sm:w-auto justify-center"
                >
                  {isSubmitting ? "Sending…" : "Send request"}
                  {!isSubmitting && <ArrowRight size={16} />}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
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
