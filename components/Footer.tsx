"use client";

import Link from "next/link";
import { Linkedin, Github, ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/Navbar";
import { openAudit } from "@/lib/ui";
import { SITE } from "@/lib/site";

// X (Twitter) glyph — lucide's Twitter icon is the old bird; use the wordmark.
function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const socials = [
  { icon: Linkedin, href: "https://www.linkedin.com/", label: "LinkedIn" },
  { icon: XIcon, href: "https://x.com/", label: "X" },
  { icon: Github, href: SITE.repo, label: "GitHub" },
];

export function Footer() {
  return (
    <footer className="bg-[#060912] border-t border-line pt-16 pb-10">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-x-8 gap-y-12">
          <div className="lg:col-span-5">
            <div className="flex items-center gap-3 mb-4">
              <Logo size={36} />
              <span className="font-semibold text-2xl tracking-tight">
                GridForge<span className="text-power"> AI</span>
              </span>
            </div>
            <p className="text-mute max-w-sm text-[15px] leading-relaxed">
              Independent power-systems engineering for AI data centers. We close
              the gap between a multi-year grid queue and an energized site.
            </p>
            <p className="data text-xs text-faint mt-4">
              Pilot-stage · founder-led · {SITE.baseLocation}
            </p>
            <div className="mt-6 flex gap-2">
              {socials.map(({ icon: Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="w-9 h-9 rounded-lg border border-line hover:border-power/50 flex items-center justify-center text-mute hover:text-power transition-all hover:bg-white/5"
                >
                  <Icon size={16} />
                </a>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="eyebrow text-mute mb-4">Engineering</div>
            <div className="space-y-3 text-sm text-mute">
              <FooterLink href="/#services">Services</FooterLink>
              <FooterLink href="/#architectures">Architectures</FooterLink>
              <FooterLink href="/#technology">Technology</FooterLink>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="eyebrow text-mute mb-4">Company</div>
            <div className="space-y-3 text-sm text-mute">
              <FooterLink href="/#about">About</FooterLink>
              <FooterLink href="/#faq">FAQ</FooterLink>
              <a
                href={SITE.founderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white transition-colors inline-flex items-center gap-1"
              >
                Founder <ArrowUpRight size={13} />
              </a>
            </div>
          </div>

          <div className="lg:col-span-3">
            <div className="eyebrow text-mute mb-4">Contact</div>
            <div className="space-y-3 text-sm">
              <a href={`mailto:${SITE.email}`} className="block text-power hover:underline">
                {SITE.email}
              </a>
              <div className="text-mute">{SITE.baseLocation}</div>
              <button
                onClick={() => openAudit("footer")}
                className="data text-xs uppercase tracking-[0.12em] font-medium text-power hover:underline inline-flex items-center gap-1"
              >
                Request a power audit →
              </button>
            </div>
          </div>
        </div>

        <div className="mt-14 pt-7 border-t border-line flex flex-col md:flex-row justify-between items-center gap-y-4 text-xs text-faint">
          <div className="text-center md:text-left">
            © {new Date().getFullYear()} GridForge AI. Engineering by{" "}
            {SITE.founder}.
          </div>
          <div className="flex gap-x-6">
            <Link href="/legal/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/legal/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/legal/security" className="hover:text-white transition-colors">Security</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block hover:text-white transition-colors">
      {children}
    </Link>
  );
}
