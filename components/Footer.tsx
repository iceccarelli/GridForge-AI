"use client";

import Link from "next/link";
import { Logo } from "@/components/Navbar";
import { commissionDensityScreen, DENSITY_SCREEN_CTA } from "@/lib/ui";
import { SITE } from "@/lib/site";
import { usePathname } from "next/navigation";
import { FOOTER_GROUPS, QUALIFY_LINK, paidCtaAllowed } from "@/lib/nav";

// X (Twitter) glyph — lucide's Twitter icon is the old bird; use the wordmark.
function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LinkedinIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.35V9h3.414v1.561h.049c.476-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286ZM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124Zm1.782 13.019H3.555V9h3.564v11.452ZM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003Z" />
    </svg>
  );
}

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.387.6.11.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.333-5.466-5.931 0-1.31.467-2.381 1.235-3.221-.123-.303-.535-1.523.117-3.176 0 0 1.008-.322 3.3 1.23a11.5 11.5 0 0 1 6.006 0c2.289-1.552 3.294-1.23 3.294-1.23.653 1.653.242 2.873.12 3.176.77.84 1.233 1.911 1.233 3.221 0 4.61-2.806 5.628-5.479 5.921.43.372.814 1.102.814 2.222 0 1.604-.015 2.896-.015 3.286 0 .32.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
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
  { icon: LinkedinIcon, href: SITE.social.linkedin, label: "LinkedIn" },
  { icon: XIcon, href: SITE.social.x, label: "X" },
  { icon: GithubIcon, href: SITE.repo, label: "GitHub" },
].filter((s) => s.href);

export function Footer() {
  const showPaid = paidCtaAllowed(usePathname());
  return (
    <footer className="bg-[#060912] border-t border-line pt-16 pb-28 lg:pb-24">
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
              We tell the owner of an existing AI hall how much useful compute it
              can support, what blocks it, what fixes it, what the fix costs, and
              the time to full capacity, with its evidence class. No equipment to
              sell.
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
                  className="w-11 h-11 rounded-lg border border-line hover:border-power/50 flex items-center justify-center text-mute hover:text-power transition-all hover:bg-white/5"
                >
                  <Icon size={16} />
                </a>
              ))}
            </div>
          </div>

          {FOOTER_GROUPS.map((group) => (
            <div key={group.heading} className="lg:col-span-2">
              <div className="eyebrow text-mute mb-4">{group.heading}</div>
              <div className="text-sm text-mute">
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
          <div className="min-w-0 break-words text-sm">
            <a href={`mailto:${SITE.email}`} className="inline-flex min-h-11 items-center text-power underline">
              {SITE.email}
            </a>
            <span className="text-faint mx-2">·</span>
            <span className="text-mute">{SITE.baseLocation}</span>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-5">
            <Link href={QUALIFY_LINK.href} className="btn-primary btn-shape min-h-11 sm:whitespace-nowrap">
              {QUALIFY_LINK.label}
            </Link>
            {showPaid && (
              <button
                onClick={() => commissionDensityScreen({ context: "footer" })}
                className="btn-tertiary min-h-11 sm:whitespace-nowrap"
                title={DENSITY_SCREEN_CTA}
              >
                {DENSITY_SCREEN_CTA}
              </button>
            )}
          </div>
        </div>

        <div className="mt-10 pt-7 border-t border-line flex flex-col md:flex-row justify-between items-center gap-y-4 text-xs text-faint">
          <div className="text-center md:text-left">
            © {new Date().getFullYear()} Time to Power. Powered by GridForge
            Engine. Engineering by {SITE.founder}.
          </div>
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            <Link href="/legal/privacy" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-white transition-colors">Privacy</Link>
            <Link href="/legal/terms" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-white transition-colors">Terms</Link>
            <Link href="/legal/security" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-white transition-colors">Security</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="flex min-h-11 items-center hover:text-white transition-colors">
      {children}
    </Link>
  );
}
