"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { MOBILE_MENU_BUTTON_ID, OPEN_SCOPING_AGENT_EVENT, scopingAgentAvailable } from "@/lib/nav";

// Only the launcher button is part of every page. The conversation (its state, its markup and its network calls) is a separate chunk
// that is requested when the visitor shows intent: hovering, focusing or pressing the launcher. Before that, no chat code is downloaded
// and nothing is sent to the chat endpoint.
const loadPanel = () => import("@/components/ScopingAgentPanel");
const Panel = dynamic(loadPanel, { ssr: false });

export function ScopingAgent() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [pastHero, setPastHero] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);

  // On mobile, the hero's own CTAs sit in the same bottom-right quadrant the launcher is fixed to. Stay out of the way until the visitor
  // has scrolled past them (StickyMobileCTA does the same).
  useEffect(() => {
    const onScroll = () => setPastHero(window.scrollY > 420);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Below lg the floating launcher is not drawn (it sat over form fields and the call to action at 390 px wide); the mobile menu asks for
  // the assistant with this event instead. The panel's code is still only requested here, on that intent.
  useEffect(() => {
    const open = () => {
      void loadPanel();
      setEverOpened(true);
      setOpen(true);
    };
    window.addEventListener(OPEN_SCOPING_AGENT_EVENT, open);
    return () => window.removeEventListener(OPEN_SCOPING_AGENT_EVENT, open);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to what opened the dialog, after the launcher has been put back in the page. Below lg the launcher is not drawn (its box
    // has no size), so focus goes to the mobile menu's button, which is how the dialog was opened there: never to a hidden element.
    requestAnimationFrame(() => {
      const l = launcher.current;
      if (l && l.getClientRects().length > 0) launcher.current?.focus();
      else document.getElementById(MOBILE_MENU_BUTTON_ID)?.focus();
    });
  }, []);

  // Redundant on the full workspace (the whole page is already this conversation, and on mobile the launcher overlapped its tab bar), and
  // the Observatory is a demonstration page: no assistant launcher over it, and nothing on it that leads to a sale.
  if (!scopingAgentAvailable(pathname)) return null;

  return (
    <>
      {!open && (
        <button
          ref={launcher}
          onClick={() => {
            setEverOpened(true);
            setOpen(true);
          }}
          onPointerEnter={() => void loadPanel()}
          onFocus={() => void loadPanel()}
          className={`fixed z-[60] hidden lg:flex min-h-11 items-center gap-2.5 rounded-full bg-power text-ink pl-4 pr-5 py-3.5 shadow-[0_8px_30px_-6px_rgba(0,229,255,0.5)] hover:scale-105 transition-transform font-medium text-sm bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] right-4 lg:bottom-6 lg:right-6 ${
            pastHero ? "visible" : "invisible"
          } lg:visible`}
          aria-label="Scope my site: open the Time to Power scoping assistant (AI)"
        >
          <MessageSquare size={18} aria-hidden /> Scope my site
        </button>
      )}
      {everOpened && <Panel open={open} onClose={close} />}
    </>
  );
}
