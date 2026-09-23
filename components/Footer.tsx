"use client";

import Link from "next/link";
import { Linkedin, Github } from "lucide-react";
import { Logo } from "@/components/Navbar";
import { commissionDensityScreen, DENSITY_SCREEN_CTA } from "@/lib/ui";
import { SITE } from "@/lib/site";
import { FOOTER_GROUPS, QUALIFY_LINK } from "@/lib/nav";

// X (Twitter) glyph — lucide's Twitter icon is the old bird; use the wordmark.
function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/**
 * Only a destination this repository can actually verify goes in the
 * footer. SITE.social holds LinkedIn/X/etc as empty strings until a real
 * account exists — this used to hardcode generic platform homepages
 * (linkedin.com/, x.com/) instead, which look like company links but go
 * nowhere specific. GitHub is always real: it's the repository itself.
 */
const socials = [
  { icon: Linkedin, href: SITE.social.linkedin, label: "LinkedIn" },
  { icon: XIcon, href: SITE.social.x, label: "X" },
  { icon: Github, href: SITE.repo, label: "GitHub" },
].filter((s) => s.href);

export function Footer() {
  return (
    <footer className="bg-[#060912] border-t border-line pt-16 pb-10">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-x-8 gap-y-12">
          <div className="lg:col-span-4">
            <div className="flex items-center gap-3 mb-4">
              <Logo size={36} />
              <span className="font-semibold text-2xl tracking-tight">
                Time<span className="text-power"> to Power</span>
              </span>
            </div>
            <p className="text-mute max-w-sm text-[15px] leading-relaxed">
              We tell the owner of an AI site how much useful compute it can
              actually support, what blocks it, what fixes it, what the fix
              costs, and when the compute can go live. No equipment to sell.
            </p>
            <p className="data text-xs text-faint mt-4">
              Pilot-stage · founder-led · powered by GridForge Engine · {SITE.baseLocation}
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

          {FOOTER_GROUPS.map((group) => (
            <div key={group.heading} className="lg:col-span-2">
              <div className="eyebrow text-mute mb-4">{group.heading}</div>
              <div className="space-y-3 text-sm text-mute">
                {group.links.map((link) => (
                  <FooterLink
                    key={`${group.heading}-${link.href}-${link.label}`}
                    href={link.hash ? `/${link.href}` : link.href}
                  >
                    {link.label}
                  </FooterLink>
                ))}
              </div>
            </div>
          ))}

        </div>

        <div className="mt-14 pt-10 border-t border-line flex flex-col lg:flex-row lg:items-center lg:justify-between gap-y-6">
          <div className="text-sm">
            <a href={`mailto:${SITE.email}`} className="text-power hover:underline">
              {SITE.email}
            </a>
            <span className="text-faint mx-2">·</span>
            <span className="text-mute">{SITE.baseLocation}</span>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-5">
            <FooterLink href={QUALIFY_LINK.href}>{QUALIFY_LINK.label} →</FooterLink>
            <button
              onClick={() => commissionDensityScreen({ context: "footer" })}
              className="btn-primary px-5 py-2.5 rounded-full text-sm whitespace-nowrap"
              title={DENSITY_SCREEN_CTA}
            >
              {DENSITY_SCREEN_CTA}
            </button>
          </div>
        </div>

        <div className="mt-10 pt-7 border-t border-line flex flex-col md:flex-row justify-between items-center gap-y-4 text-xs text-faint">
          <div className="text-center md:text-left">
            © {new Date().getFullYear()} Time to Power. Powered by GridForge
            Engine. Engineering by {SITE.founder}.
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
