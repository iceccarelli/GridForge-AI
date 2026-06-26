"use client";
import { LazyMotion, domAnimation } from "framer-motion";

// Loads only the domAnimation feature set (~half of framer-motion). All motion
// components must use the lightweight `m.` namespace instead of `motion.`.
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation} strict>{children}</LazyMotion>;
}
