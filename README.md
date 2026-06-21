# GridForge AI

**Speed to Power for AI Data Centers** — a marketing + lead-generation site for a founder-led, pilot-stage behind-the-meter power engineering practice.

GridForge AI helps AI data-center developers bypass multi-year grid interconnection queues with on-site hybrid microgrids, DC distribution, and a physics-informed energy management system (EMS). This repository is the public website: it explains the niche, presents the real sellable engineering services, captures qualified leads, and includes an interactive (sample-data) dashboard preview.

---

## A note on honesty

This site is written to persuade **without fabricating a track record.** It is a real engineering practice at pilot stage, and the copy says so. Specifically:

- Every market figure (68 GW demand, ~2,600 GW in interconnection queues, 5–8 year waits, etc.) is **a claim about the market**, sourced from public 2025–2026 research (RAND, FERC/LBNL, IEA, DOE). None of them are presented as GridForge's own results.
- The "Reference Architectures" section presents **engineering designs**, explicitly labeled *reference designs — not delivered customer projects.*
- The dashboard is clearly labeled **Interactive preview — sample data.**
- There are no fake customers, no fabricated efficiency stats, no invented partnerships or patents.

This is deliberate. The buyers in this niche are sophisticated infrastructure and energy people who will check claims, and false advertising carries real legal exposure (FTC, Competition Act, EU). The persuasion here comes from genuine market data and engineering depth, not invented proof. **Please keep it that way** as the practice grows — replace reference designs with real case studies only once they are real.

---

## Tech stack

- **Next.js 15.1.0** (App Router) + **React 18** + **TypeScript**
- **Tailwind CSS 3** with a custom "instrumentation / blueprint" design system
- **Framer Motion** for the signature *Time to Power* animation
- **react-hook-form** + **zod** for the audit-request form
- **sonner** for toasts
- **lucide-react** for icons
- Fonts: **Inter** (body) + **JetBrains Mono** (all data/numbers/eyebrows), via `next/font`

## Project structure

```
app/
  layout.tsx            Root layout, fonts, metadata, mounts Navbar/Footer/AuditModal
  page.tsx              Honest homepage (hero, market reality, problem, approach,
                        services, reference architectures, tech, founder, FAQ, CTA)
  dashboard/page.tsx    Sample-data dashboard preview (sessionStorage demo auth)
  api/audit/route.ts    Lead-capture API (Resend if configured, else server log)
  legal/{privacy,terms,security}/page.tsx
  not-found.tsx · robots.ts · sitemap.ts · globals.css
components/
  Navbar.tsx            Working CTAs + demo client-portal login
  Footer.tsx
  TimeToPower.tsx       Signature animated grid-queue vs on-site comparison
  AuditModal.tsx        Mounted once; opens via the `gridforge:open-audit` event
  LegalShell.tsx
lib/
  site.ts               SINGLE SOURCE OF TRUTH for all content/market data
  ui.ts                 openAudit() — global event so every CTA works
public/
  icon.svg · og.png
```

Every call-to-action on the site calls `openAudit()` (from `lib/ui.ts`), which dispatches a window event the single mounted `AuditModal` listens for. To change any copy or market figure, edit **`lib/site.ts`**.

---

## Local development

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build (must pass before deploy)
npm run typecheck    # tsc --noEmit
```

Node 18.18+ or 20+ recommended.

## Environment variables

Nothing is required to build or deploy. All env vars are **optional** and only enable live lead delivery / analytics. Copy `.env.example` to `.env.local` to set them locally, or add them in Vercel → Project → Settings → Environment Variables.

| Variable | Purpose | If unset |
| --- | --- | --- |
| `NEXT_PUBLIC_FORMSPREE_ID` | Audit form posts leads straight to Formspree (simplest path to a live inbox). | Form falls back to the `/api/audit` route. |
| `RESEND_API_KEY` | `/api/audit` emails leads via Resend. | Route logs the lead server-side and returns success (no email sent). |
| `LEAD_TO_EMAIL` | Destination address for Resend lead emails. | Required alongside `RESEND_API_KEY`. |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | Enables privacy-friendly Plausible analytics. | No analytics. |

**To start collecting real leads immediately:** create a form at [formspree.io](https://formspree.io), then set `NEXT_PUBLIC_FORMSPREE_ID` in Vercel and redeploy. That's the only thing standing between this site and a working sales funnel.

## Demo client portal

The "Client portal" button opens a demo login. Credentials (sample data only):

```
email:    demo@gridforge.ai
password: demo2026
```

---

## Deploy

### Push to GitHub

```bash
git init
git add -A
git commit -m "GridForge AI — honest rebuild"
git remote add origin git@github.com:iceccarelli/GridForge-AI.git
git branch -M main
git push -u origin main
```

### Vercel

1. Import the `iceccarelli/GridForge-AI` repo at [vercel.com/new](https://vercel.com/new).
2. Framework preset: **Next.js** (auto-detected). No build settings to change.
3. (Optional) Add the env vars above to enable live leads.
4. Deploy. Default URL: `https://gridforge-ai.vercel.app`.

---

## License & ownership

© GridForge AI · Founder: [Vincenzo Grimaldi](https://igrimaldi.engineering) · Frankfurt, DE · Toronto, CA

Legal pages (`/legal/*`) are honest templates and flag where real entity details and counsel review are still required before relying on them.
