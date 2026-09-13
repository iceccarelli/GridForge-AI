"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, ArrowRight } from "lucide-react";
import { m, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { openAudit } from "@/lib/ui";

const navLinks = [
  { href: "#problem", label: "Problem" },
  { href: "#services", label: "Services" },
  { href: "#deploy", label: "Deploy" },
  { href: "/qualify", label: "Qualifier", route: true },
  { href: "/infrastructure", label: "Infrastructure", route: true },
  { href: "/pricing", label: "Pricing", route: true },
  { href: "#architectures", label: "Architectures" },
  { href: "#technology", label: "Technology" },
  { href: "#about", label: "About" },
];

export function Navbar() {
  const [isOpen, setIsOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
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
                GridForge<span className="text-power"> AI</span>
              </div>
              <div className="data text-[9px] text-faint tracking-[0.18em] mt-0.5">
                SPEED TO POWER
              </div>
            </div>
          </Link>

          <div className="hidden lg:flex items-center gap-8 text-sm font-medium">
            {navLinks.map((link) =>
              "route" in link && link.route ? (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-mute hover:text-white transition-colors"
                >
                  {link.label}
                </Link>
              ) : (
                <button
                  key={link.href}
                  onClick={() => scrollTo(link.href)}
                  className="text-mute hover:text-white transition-colors"
                >
                  {link.label}
                </button>
              )
            )}
          </div>

          <div className="hidden lg:flex items-center gap-3">
            <button
              onClick={() => setShowLogin(true)}
              className="btn-ghost px-4 py-2.5 rounded-full text-sm"
            >
              Client portal
            </button>
            <button
              onClick={() => openAudit("navbar")}
              className="btn-primary px-5 py-2.5 rounded-full text-sm flex items-center gap-2"
            >
              Request audit <ArrowRight size={15} />
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
                {navLinks.map((link) => (
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
                      setShowLogin(true);
                    }}
                    className="btn-ghost w-full py-3 rounded-xl text-base border border-line"
                  >
                    Client portal
                  </button>
                  <button
                    onClick={() => {
                      setIsOpen(false);
                      openAudit("mobile-nav");
                    }}
                    className="btn-primary w-full py-3.5 rounded-xl text-base"
                  >
                    Request audit
                  </button>
                </div>
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </nav>

      <AnimatePresence>
        {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      </AnimatePresence>
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

function LoginModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    await new Promise((r) => setTimeout(r, 650));
    if (email === "demo@gridforge.ai" && password === "demo2026") {
      sessionStorage.setItem("gridforge_demo", "true");
      sessionStorage.setItem(
        "gridforge_user",
        JSON.stringify({ email, name: "Sample Client", company: "Demo HyperScale" })
      );
      router.push("/dashboard");
    } else {
      setError("Use the demo credentials below to preview the portal.");
    }
    setLoading(false);
  };

  return (
    <m.div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <m.div
        initial={{ opacity: 0, scale: 0.96, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 18 }}
        transition={{ ease: [0.23, 1, 0.32, 1], duration: 0.22 }}
        className="glass w-full max-w-md rounded-2xl p-7"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Client portal preview"
      >
        <div className="flex justify-between items-start mb-6">
          <div className="flex items-center gap-3">
            <Logo size={32} />
            <div>
              <div className="font-semibold text-xl">Client portal</div>
              <div className="data text-[10px] text-faint tracking-[0.16em] mt-0.5">
                INTERACTIVE PREVIEW
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-mute hover:text-white p-1" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="pill pill-progress inline-block mb-5">SAMPLE DATA — NOT A LIVE ACCOUNT</div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="eyebrow text-[10px] text-mute block mb-2">Work email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="field w-full px-4 py-3 rounded-xl"
              required
            />
          </div>
          <div>
            <label className="eyebrow text-[10px] text-mute block mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="field w-full px-4 py-3 rounded-xl"
              required
            />
          </div>

          {error && (
            <div className="text-queue text-sm bg-queue/10 border border-queue/30 px-4 py-3 rounded-xl">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full py-3.5 rounded-xl text-base disabled:opacity-60"
          >
            {loading ? "Opening preview…" : "Open portal preview"}
          </button>
        </form>

        <div className="mt-5 text-center">
          <p className="text-xs text-faint">
            Demo: <span className="data text-power">demo@gridforge.ai</span> /{" "}
            <span className="data text-power">demo2026</span>
          </p>
        </div>
      </m.div>
    </m.div>
  );
}
