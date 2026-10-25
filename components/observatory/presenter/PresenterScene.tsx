"use client";

// The time driver around PresenterFrame. The frame itself is pure (frameAt over the steps); this decides only which t to show.
//   freeze: t is fixed at the URL's value and nothing runs (frame-exact capture; the server renders the same markup).
//   otherwise: the journey plays on its own clock from t, and holds the last frame when it ends.
// window.__obsSeek(t) is the broadcast tool's fast path: it shows the frame for t and resolves once it has been painted.
import { useEffect, useMemo, useRef, useState } from "react";
import { frameAt, totalDuration } from "@/lib/observatory/journey";
import type { JourneyStep, ScenarioFile } from "@/lib/observatory/types";
import { PresenterFrame } from "@/components/observatory/presenter/PresenterFrame";

declare global {
  interface Window {
    __obsSeek?: (t: number) => Promise<void>;
  }
}

export function PresenterScene({ file, steps, initialT, freeze, captions }: { file: ScenarioFile; steps: JourneyStep[]; initialT: number; freeze: boolean; captions: boolean }) {
  const total = useMemo(() => totalDuration(steps), [steps]);
  const [t, setT] = useState(Math.min(initialT, total));
  const origin = useRef({ at: 0, t: Math.min(initialT, total) });
  const waiters = useRef<(() => void)[]>([]);
  const shown = useRef(t);

  useEffect(() => {
    window.__obsSeek = (nt: number) =>
      new Promise<void>((resolve) => {
        const c = Math.min(Math.max(Number.isFinite(nt) ? nt : 0, 0), total);
        origin.current = { at: performance.now(), t: c };
        if (c === shown.current) {
          // Already showing this frame: no render will follow, so release after the next paint.
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          return;
        }
        waiters.current.push(resolve);
        setT(c);
      });
    return () => {
      delete window.__obsSeek;
    };
  }, [total]);

  useEffect(() => {
    if (freeze) return;
    origin.current = { at: performance.now(), t: origin.current.t };
    let raf = 0;
    const tick = () => {
      const next = Math.min(total, origin.current.t + (performance.now() - origin.current.at) / 1000);
      setT(next);
      if (next < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [freeze, total]);

  // After each paint of a new t: publish it, and release anyone waiting for a seek to land.
  useEffect(() => {
    shown.current = t;
    document.documentElement.dataset.t = t.toFixed(3);
    document.documentElement.dataset.ready = "1";
    if (waiters.current.length === 0) return;
    const done = waiters.current.splice(0);
    requestAnimationFrame(() => requestAnimationFrame(() => done.forEach((r) => r())));
  }, [t]);

  return <PresenterFrame file={file} steps={steps} frame={frameAt(steps, t)} captions={captions} />;
}
