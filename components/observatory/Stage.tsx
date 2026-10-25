"use client";

// The stage frame: a fixed-height box (so switching 2D/3D never moves the page), the 2D/3D toggle, and the one place that
// decides whether the three.js chunk is ever requested. Before the browser has been probed, and for every visitor the rule
// sends to 2D, only Stage2D is mounted and no 3D code is downloaded.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage2D } from "@/components/observatory/Stage2D";
import { INITIAL_DECISION, decideStage, type StageDecision, type StageSignals } from "@/components/observatory/stage-mode";
import { readSignals, readStoredChoice, storeChoice } from "@/components/observatory/stage-signals";
import { splitLabel } from "@/components/observatory/scene-visuals";
import type { SceneModel } from "@/lib/observatory/types";

const Stage3D = dynamic(() => import("@/components/observatory/Stage3D"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-mute" role="status">
      Loading the 3D view…
    </div>
  ),
});

interface Props {
  model: SceneModel;
  /** The stage whose detail is open (highlighted in 2D). */
  selectedId: string | null;
  /** Where the 3D camera is: a stage id, or null for the overview. */
  focusId: string | null;
  onSelect: (id: string | null) => void;
  /** id of the element that holds the full text description. */
  descriptionId: string;
}

export function Stage({ model, selectedId, focusId, onSelect, descriptionId }: Props) {
  const [signals, setSignals] = useState<StageSignals | null>(null);
  const [choice, setChoice] = useState<"2d" | "3d" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const cameraGroupRef = useRef<HTMLDivElement | null>(null);
  const view2dRef = useRef<HTMLButtonElement | null>(null);
  const [refocus, setRefocus] = useState(false);

  useEffect(() => {
    const stored = readStoredChoice();
    setChoice(stored);
    setSignals(readSignals(stored));
    let mq: MediaQueryList | null = null;
    const apply = () => setReduced(Boolean(mq?.matches));
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      apply();
      mq.addEventListener("change", apply);
    } catch {
      /* treated as no preference */
    }
    return () => mq?.removeEventListener("change", apply);
  }, []);

  const decision: StageDecision = useMemo(
    () => (signals ? decideStage({ ...signals, userChoice: choice, contextFailed: failure !== null }) : INITIAL_DECISION),
    [signals, choice, failure],
  );
  const mode = decision.mode;

  const pick = useCallback((v: "2d" | "3d") => {
    setChoice(v);
    storeChoice(v);
  }, []);
  const onFail = useCallback((reason: string) => {
    // If keyboard focus is on a camera button, that group is about to unmount: remember, and hand focus to the 2D toggle.
    if (cameraGroupRef.current && cameraGroupRef.current.contains(document.activeElement)) setRefocus(true);
    setFailure(reason);
  }, []);
  useEffect(() => {
    if (refocus && failure !== null) {
      view2dRef.current?.focus();
      setRefocus(false);
    }
  }, [refocus, failure]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Stage view" className="inline-flex overflow-hidden rounded-full border border-line">
          {(["2d", "3d"] as const).map((v) => {
            const pressed = mode === v;
            const disabled = v === "3d" && !decision.canUse3d;
            return (
              <button
                key={v}
                ref={v === "2d" ? view2dRef : undefined}
                type="button"
                aria-pressed={pressed}
                disabled={disabled}
                onClick={() => pick(v)}
                className={`px-4 py-1.5 font-mono text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  pressed ? "bg-power text-ink" : "bg-panel text-mute hover:text-ghost"
                }`}
              >
                {v === "2d" ? "2D view" : "3D view"}
              </button>
            );
          })}
        </div>
        {decision.reason ? (
          <p className="text-xs text-mute" role="status">
            {decision.reason}
          </p>
        ) : null}
      </div>

      <div
        className={`relative overflow-hidden rounded-xl border border-line bg-panel ${
          mode === "3d" ? "h-[460px] md:h-[700px] lg:h-[760px]" : "md:h-[700px] lg:h-[760px]"
        }`}
        data-stage-mode={mode}
      >
        {mode === "3d" ? (
          <div
            role="img"
            aria-label="3D view of the power path and rack rows. The same information is in the text description and the stage table."
            aria-describedby={descriptionId}
            className="absolute inset-0"
          >
            <Stage3D model={model} selectedId={focusId} reducedMotion={reduced} onFail={onFail} />
          </div>
        ) : (
          <div className="p-2 md:flex md:h-full md:items-start md:p-3">
            <Stage2D model={model} selectedId={selectedId} onSelect={onSelect} describedBy={descriptionId} />
          </div>
        )}
      </div>

      {mode === "3d" ? (
        <div ref={cameraGroupRef} role="group" aria-label="Move the camera to a stage" className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-pressed={focusId === null}
            className="rounded-full border border-line px-3 py-1 text-xs text-mute hover:text-ghost aria-pressed:border-power aria-pressed:text-power"
          >
            Overview
          </button>
          {model.nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(n.id)}
              aria-pressed={focusId === n.id}
              className="rounded-full border border-line px-3 py-1 text-xs text-mute hover:text-ghost aria-pressed:border-power aria-pressed:text-power"
            >
              {splitLabel(n.label).title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
