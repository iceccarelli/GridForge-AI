"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X, ArrowRight, ChevronDown } from "lucide-react";
import { commissionDensityScreen, DENSITY_SCREEN_CTA } from "@/lib/ui";
import { NAV_LINKS, QUALIFY_LINK, SIGN_IN_LABEL, SIGN_IN_LINKS, MOBILE_MENU_BUTTON_ID, OPEN_SCOPING_AGENT_EVENT, paidCtaAllowed, scopingAgentAvailable } from "@/lib/nav";

/**
 * One "Sign in" control for the two places an account lives. Each item says what it opens, and no destination is changed. A disclosure
 * (a button that shows a short list of links), not an ARIA menu: while closed its links are not in the tab order, and Escape or a click
 * outside closes it.
 */
function SignInMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  return (
    <div
      ref={wrap}
      className="relative"
      // Tabbing (or clicking) out of the menu closes it, and aria-expanded follows: focus that moves to something outside this wrapper is a
      // departure. relatedTarget is null when focus leaves the window, which closes it too.
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="sign-in-menu"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap text-sm font-medium text-mute transition-colors hover:text-white"
      >
        {SIGN_IN_LABEL} <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <ul id="sign-in-menu" className="absolute right-0 top-full z-50 mt-1 w-72 rounded-xl border border-line bg-panel p-1.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)]">
          {SIGN_IN_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} onClick={() => setOpen(false)} className="block min-h-11 rounded-lg px-3 py-2 hover:bg-white/5">
                <span className="block text-sm font-semibold text-ghost">{l.label}</span>
                <span className="block text-xs leading-snug text-mute">{l.note}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const showPaid = paidCtaAllowed(pathname);
  const showAssistant = scopingAgentAvailable(pathname);
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        // Closing with the keyboard returns the reader to the control that opened the menu, not to the top of the page.
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const scrollTo = (href: string) => {
    setIsOpen(false);
    if (href.startsWith("/")) {
      window.location.href = href;
      return;
    }
    if (href.startsWith("#")) {
      const el = document.querySelector(href);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top, behavior: "smooth" });
        return;
      }
      // not on this page — go home with hash
      router.push("/" + href);
    }
  };

  return (
    <>
      <nav
        aria-label="Primary"
        className={`fixed top-0 inset-x-0 z-50 transition-shadow ${
          scrolled ? "nav-glass shadow-[0_8px_30px_-20px_rgba(0,0,0,0.9)]" : "nav-glass"
        }`}
      >
        <div className="max-w-7xl mx-auto px-5 sm:px-6 min-h-16 sm:min-h-20 flex items-center justify-between gap-3">
          <Link href="/" className="flex min-h-11 min-w-0 items-center gap-3 group">
            <Logo />
            <div className="min-w-0 leading-tight sm:leading-none sm:whitespace-nowrap">
              <div className="font-semibold text-lg sm:text-xl tracking-tight">
                Time<span className="text-power"> to Power</span>
              </div>
              <div className="data text-[9px] text-faint tracking-[0.18em] mt-0.5">
                POWERED BY GRIDFORGE ENGINE
              </div>
            </div>
          </Link>

          <div className="hidden xl:flex items-center gap-6">
            <div className="flex items-center gap-5 text-sm font-medium">
              {NAV_LINKS.map((link) =>
                link.hash ? (
                  <button
                    key={link.href}
                    onClick={() => scrollTo(link.href)}
                    className="whitespace-nowrap text-mute hover:text-white transition-colors"
                  >
                    {link.label}
                  </button>
                ) : (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="whitespace-nowrap text-mute hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                )
              )}
            </div>

            <div className="flex items-center gap-4">
              <Link href={QUALIFY_LINK.href} className="btn-primary btn-shape whitespace-nowrap">
                {QUALIFY_LINK.label} <ArrowRight size={15} aria-hidden />
              </Link>
              {showPaid && (
                <button
                  onClick={() => commissionDensityScreen({ context: "navbar" })}
                  className="btn-tertiary hidden whitespace-nowrap min-[1320px]:inline-flex"
                  title={DENSITY_SCREEN_CTA}
                >
                  {DENSITY_SCREEN_CTA}
                </button>
              )}
              <SignInMenu />
            </div>
          </div>

          <button
            ref={toggleRef}
            id={MOBILE_MENU_BUTTON_ID}
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="xl:hidden inline-flex min-h-11 min-w-11 items-center justify-center p-2 text-mute hover:text-white"
            aria-label="Main menu"
            aria-controls="mobile-nav"
            aria-expanded={isOpen}
          >
            {isOpen ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>

        {isOpen && (
          <div id="mobile-nav" className="mobile-nav-drop xl:hidden border-t border-line bg-ink overflow-hidden">
            <div className="px-6 py-7 flex flex-col gap-5 text-lg">
              {NAV_LINKS.map((link) =>
                link.hash ? (
                  <button
                    key={link.href}
                    type="button"
                    onClick={() => scrollTo(link.href)}
                    className="text-left text-ghost/90 hover:text-white py-1 min-h-11"
                  >
                    {link.label}
                  </button>
                ) : (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setIsOpen(false)}
                    className="block text-left text-ghost/90 hover:text-white py-2 min-h-11"
                  >
                    {link.label}
                  </Link>
                )
              )}
              <div className="pt-4 border-t border-line flex flex-col gap-3">
                <Link
                  href={QUALIFY_LINK.href}
                  onClick={() => setIsOpen(false)}
                  className="btn-primary btn-shape btn-shape-lg w-full"
                >
                  {QUALIFY_LINK.label}
                </Link>
                {showPaid && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      commissionDensityScreen({ context: "mobile-nav" });
                    }}
                    className="btn-tertiary w-full"
                  >
                    {DENSITY_SCREEN_CTA}
                  </button>
                )}
                <div className="border-t border-line pt-3">
                  <div className="data mb-1 text-[10px] uppercase tracking-[0.14em] text-faint">{SIGN_IN_LABEL}</div>
                  {SIGN_IN_LINKS.map((l) => (
                    <Link key={l.href} href={l.href} onClick={() => setIsOpen(false)} className="block min-h-11 py-1.5">
                      <span className="block text-base text-ghost/90">{l.label}</span>
                      <span className="block text-xs leading-snug text-mute">{l.note}</span>
                    </Link>
                  ))}
                </div>
                {showAssistant && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      window.dispatchEvent(new Event(OPEN_SCOPING_AGENT_EVENT));
                    }}
                    className="min-h-11 text-left text-base text-ghost/90 hover:text-white"
                  >
                    Ask the scoping assistant (AI)
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </nav>

    </>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <div
      className="rounded-xl flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg,#00E5FF 0%,#38BDF8 100%)",
      }}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <path
          d="M13 2 L4 14 H11 L9.5 22 L20 9 H12.5 Z"
          fill="#051019"
          stroke="#051019"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
