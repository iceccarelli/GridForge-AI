"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, ArrowRight } from "lucide-react";
import { m, AnimatePresence } from "framer-motion";
import { commissionDensityScreen, DENSITY_SCREEN_CTA } from "@/lib/ui";
import { NAV_LINKS, QUALIFY_LINK } from "@/lib/nav";

export function Navbar() {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
      window.location.href = "/" + href;
    }
  };

  return (
    <>
      <nav
        className={`fixed top-0 inset-x-0 z-50 transition-shadow ${
          scrolled ? "nav-glass shadow-[0_8px_30px_-20px_rgba(0,0,0,0.9)]" : "nav-glass"
        }`}
      >
        <div className="max-w-7xl mx-auto px-5 sm:px-6 h-16 sm:h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <Logo />
            <div className="leading-none">
              <div className="font-semibold text-lg sm:text-xl tracking-tight">
                Time<span className="text-power"> to Power</span>
              </div>
              <div className="data text-[9px] text-faint tracking-[0.18em] mt-0.5">
                POWERED BY GRIDFORGE ENGINE
              </div>
            </div>
          </Link>

          <div className="hidden lg:flex items-center gap-7 text-sm font-medium">
            {NAV_LINKS.map((link) =>
              link.hash ? (
                <button
                  key={link.href}
                  onClick={() => scrollTo(link.href)}
                  className="text-mute hover:text-white transition-colors"
                >
                  {link.label}
                </button>
              ) : (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-mute hover:text-white transition-colors"
                >
                  {link.label}
                </Link>
              )
            )}
          </div>

          <div className="hidden lg:flex items-center gap-3">
            <Link
              href={QUALIFY_LINK.href}
              className="text-mute hover:text-white text-sm font-medium whitespace-nowrap transition-colors"
            >
              {QUALIFY_LINK.label}
            </Link>
            <button
              onClick={() => commissionDensityScreen({ context: "navbar" })}
              className="btn-primary px-5 py-2.5 rounded-full text-sm flex items-center gap-2 whitespace-nowrap"
              title={DENSITY_SCREEN_CTA}
            >
              {DENSITY_SCREEN_CTA} <ArrowRight size={15} />
            </button>
          </div>

          <button
            onClick={() => setIsOpen(!isOpen)}
            className="lg:hidden p-2 text-mute hover:text-white"
            aria-label="Toggle menu"
            aria-expanded={isOpen}
          >
            {isOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        <AnimatePresence>
          {isOpen && (
            <m.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="lg:hidden border-t border-line bg-ink overflow-hidden"
            >
              <div className="px-6 py-7 flex flex-col gap-5 text-lg">
                {NAV_LINKS.map((link) => (
                  <button
                    key={link.href}
                    onClick={() => scrollTo(link.href)}
                    className="text-left text-ghost/90 hover:text-white py-1"
                  >
                    {link.label}
                  </button>
                ))}
                <div className="pt-4 border-t border-line flex flex-col gap-3">
                  <button
                    onClick={() => {
                      setIsOpen(false);
                      commissionDensityScreen({ context: "mobile-nav" });
                    }}
                    className="btn-primary w-full py-3.5 rounded-xl text-base text-center"
                  >
                    {DENSITY_SCREEN_CTA}
                  </button>
                  <Link
                    href={QUALIFY_LINK.href}
                    onClick={() => setIsOpen(false)}
                    className="btn-ghost w-full py-3 rounded-xl text-base border border-line text-center"
                  >
                    {QUALIFY_LINK.label}
                  </Link>
                  <Link
                    href="/dashboard"
                    onClick={() => setIsOpen(false)}
                    className="text-center text-xs text-mute hover:text-white transition-colors py-1"
                  >
                    Client portal
                  </Link>
                </div>
              </div>
            </m.div>
          )}
        </AnimatePresence>
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
