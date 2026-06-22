#!/usr/bin/env bash
# ============================================================================
# GridForge-AI — increment 3: modular system configurator
# Requires increments 1 + 2. No new npm deps. Run from repo root, clean tree.
# ============================================================================
set -euo pipefail
[ -f package.json ] && [ -f lib/site.ts ] || { echo "✗ Run from the GridForge-AI repo root."; exit 1; }
grep -q "export const CONFIG_VARIANTS" lib/site.ts || { echo "✗ Increment 1 missing (CONFIG_VARIANTS)."; exit 1; }
[ -f components/TimeToPowerComparator.tsx ] || { echo "✗ Increment 2 missing. Apply/commit the comparator first."; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then echo "✗ Working tree not clean. Commit increment 2 first."; exit 1; fi
PATCH="$(mktemp)"
cat > "$PATCH" << 'GRIDFORGE_CFG_EOF_3310'
diff --git a/app/page.tsx b/app/page.tsx
index ef5a7d9..4624d41 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -17,6 +17,7 @@ import { openAudit } from "@/lib/ui";
 import { TimeToPower } from "@/components/TimeToPower";
 import { LoadSimulator } from "@/components/LoadSimulator";
 import { TimeToPowerComparator } from "@/components/TimeToPowerComparator";
+import { ConfigStudio } from "@/components/ConfigStudio";
 import {
   MARKET_STATS,
   PROBLEM_CARDS,
@@ -417,6 +418,20 @@ export default function Home() {
         </div>
       </section>
 
+      {/* ============== CONFIGURATOR ============== */}
+      <section id="configure" className="max-w-5xl mx-auto px-6 py-20">
+        <div className="max-w-2xl mb-10">
+          <div className="eyebrow mb-3">MATCH A DESIGN TO YOUR SITE</div>
+          <h2 className="section-title">Which reference fits your build?</h2>
+          <p className="text-mute text-[15px] leading-relaxed mt-4">
+            Dial in your target capacity and firm/renewable balance. It maps you
+            to a reference variant with an honest first-power timeline and a
+            phasing plan — a starting point for the conversation, not a quote.
+          </p>
+        </div>
+        <ConfigStudio />
+      </section>
+
       {/* ============== TECHNOLOGY ============== */}
       <section id="technology" className="max-w-5xl mx-auto px-6 py-20">
         <div className="max-w-2xl mb-12">
diff --git a/components/ConfigStudio.tsx b/components/ConfigStudio.tsx
new file mode 100644
index 0000000..f592611
--- /dev/null
+++ b/components/ConfigStudio.tsx
@@ -0,0 +1,171 @@
+"use client";
+
+import React, { useMemo, useState } from "react";
+import { motion, AnimatePresence } from "framer-motion";
+import { Boxes, Clock, Layers, Fuel } from "lucide-react";
+import { CONFIG_VARIANTS } from "@/lib/site";
+import { openAudit } from "@/lib/ui";
+
+/**
+ * Modular System Configurator.
+ *
+ * Maps a prospect's target capacity and firm/renewable preference to one of the
+ * REF-01 reference variants, with an honest deploy timeline and a phasing plan.
+ * Variant selection is by capacity envelope (mwMax); the firm-mix description
+ * adapts to the preference inputs. Everything is INDICATIVE planning output,
+ * labeled as such — the real design comes from a Feasibility Study.
+ */
+export function ConfigStudio() {
+  const [mw, setMW] = useState<number>(80);
+  const [firmPct, setFirmPct] = useState<number>(80);
+  const [fuel, setFuel] = useState<"gas" | "fuelcell" | "balanced">("balanced");
+
+  const result = useMemo(() => {
+    const variant =
+      CONFIG_VARIANTS.find((v) => mw <= v.mwMax) ?? CONFIG_VARIANTS[CONFIG_VARIANTS.length - 1];
+    const phaseSize = 40;
+    const phases = Math.max(1, Math.ceil(mw / phaseSize));
+    const perPhase = Math.round(mw / phases);
+
+    const firmLabel =
+      fuel === "gas" ? "gas-forward" : fuel === "fuelcell" ? "fuel-cell-forward" : "balanced gas + fuel cell";
+    const renewPct = 100 - firmPct;
+    const mix =
+      `~${firmPct}% firm (${firmLabel}) · ~${renewPct}% renewable + BESS for transients`;
+
+    return { variant, phases, perPhase, mix, renewPct };
+  }, [mw, firmPct, fuel]);
+
+  return (
+    <div className="panel p-6 sm:p-8 relative overflow-hidden">
+      <div className="scanline absolute inset-0 pointer-events-none" />
+
+      <div className="flex flex-wrap items-end justify-between gap-4 mb-7 relative">
+        <div>
+          <div className="eyebrow">FIG. 03 — CONFIGURE A REFERENCE SYSTEM</div>
+          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
+            Size it for your site.
+          </h3>
+        </div>
+        <span className="pill pill-progress shrink-0">INDICATIVE PLANNING OUTPUT</span>
+      </div>
+
+      <div className="grid lg:grid-cols-[1fr_1.1fr] gap-8">
+        {/* Inputs */}
+        <div className="space-y-6">
+          <Slider
+            label="Target capacity" value={mw} unit="MW"
+            min={10} max={250} step={5} onChange={setMW}
+          />
+          <Slider
+            label="Firm generation share" value={firmPct} unit="%"
+            min={50} max={100} step={5} onChange={setFirmPct}
+          />
+          <div>
+            <div className="text-sm text-ghost mb-2">Fuel preference</div>
+            <div className="grid grid-cols-3 gap-2">
+              {([
+                ["gas", "Gas-forward"],
+                ["balanced", "Balanced"],
+                ["fuelcell", "Fuel-cell"],
+              ] as const).map(([k, label]) => (
+                <button
+                  key={k}
+                  onClick={() => setFuel(k)}
+                  className={`px-2 py-2 rounded-lg text-xs font-semibold transition border ${
+                    fuel === k
+                      ? "border-power text-power bg-power/10"
+                      : "border-line text-mute hover:text-ghost"
+                  }`}
+                >
+                  {label}
+                </button>
+              ))}
+            </div>
+          </div>
+        </div>
+
+        {/* Output */}
+        <div className="relative">
+          <AnimatePresence mode="wait">
+            <motion.div
+              key={result.variant.code}
+              initial={{ opacity: 0, y: 8 }}
+              animate={{ opacity: 1, y: 0 }}
+              exit={{ opacity: 0, y: -8 }}
+              transition={{ duration: 0.25 }}
+              className="rounded-xl border border-power/30 bg-[#070b14] p-6 h-full"
+            >
+              <div className="flex items-center justify-between mb-1">
+                <span className="data text-power text-sm">{result.variant.code}</span>
+                <span className="pill pill-progress">RECOMMENDED</span>
+              </div>
+              <div className="text-lg font-semibold tracking-tight mb-5">{result.variant.name}</div>
+
+              <div className="space-y-4">
+                <Spec icon={Clock} label="First power" value={`~${result.variant.deployMonths} months`} />
+                <Spec icon={Layers} label="Phasing" value={`${result.phases} × ~${result.perPhase} MW phases`} />
+                <Spec icon={Fuel} label="Firm mix" value={result.mix} />
+                <Spec icon={Boxes} label="Topology" value={result.variant.firmMix} />
+              </div>
+
+              <p className="text-xs text-faint mt-5 leading-relaxed border-t border-line pt-4">
+                {result.variant.note} Capacity is phased so capex tracks the
+                cluster ramp. Indicative only — a Feasibility Study produces the
+                bankable sizing and economics.
+              </p>
+            </motion.div>
+          </AnimatePresence>
+        </div>
+      </div>
+
+      <div className="mt-7 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
+        <p className="text-xs text-faint">
+          Variant selected by capacity envelope; mix adapts to your inputs.
+        </p>
+        <button onClick={() => openAudit("configurator")} className="btn-primary px-4 py-2 rounded-lg text-sm">
+          Get this configuration scoped →
+        </button>
+      </div>
+    </div>
+  );
+}
+
+function Spec({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
+  return (
+    <div className="flex items-start gap-3">
+      <div className="w-8 h-8 rounded-lg bg-power/10 flex items-center justify-center shrink-0 mt-0.5">
+        <Icon className="w-4 h-4 text-power" />
+      </div>
+      <div>
+        <div className="text-[11px] uppercase tracking-wider text-faint data">{label}</div>
+        <div className="text-sm text-ghost mt-0.5">{value}</div>
+      </div>
+    </div>
+  );
+}
+
+function Slider({
+  label, value, unit, min, max, step, onChange,
+}: {
+  label: string; value: number; unit: string;
+  min: number; max: number; step: number; onChange: (v: number) => void;
+}) {
+  return (
+    <label className="block">
+      <div className="flex items-center justify-between mb-2">
+        <span className="text-sm text-ghost">{label}</span>
+        <span className="data text-power text-sm">
+          {value}
+          <span className="text-faint ml-0.5">{unit}</span>
+        </span>
+      </div>
+      <input
+        type="range" min={min} max={max} step={step} value={value}
+        onChange={(e) => onChange(Number(e.target.value))}
+        className="w-full accent-[#00E5FF] cursor-pointer"
+        aria-label={label}
+      />
+    </label>
+  );
+}
GRIDFORGE_CFG_EOF_3310
echo "→ checking…"; git apply --check "$PATCH"
echo "→ applying…"; git apply "$PATCH"
echo "→ verifying build…"; npm run build
rm -f "$PATCH"
echo ""
echo "✓ Done. Configurator live at #configure (right after Reference Architectures)."
echo "  Then commit:  git add -A && git commit -m 'feat: modular system configurator'"
