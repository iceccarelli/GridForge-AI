import type { Metadata, Viewport } from "next";
import { SITE_URL } from "@/lib/site";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "sonner";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { BackgroundReel } from "@/components/BackgroundReel";
import { ScopingAgent } from "@/components/ScopingAgent";
import { StickyMobileCTA } from "@/components/StickyMobileCTA";
import { SiteChrome } from "@/components/SiteChrome";
import { CheckoutReturnNotice } from "@/components/CheckoutReturnNotice";
import { Suspense } from "react";

// Self-hosted fonts (no build-time network dependency on Google Fonts —
// more robust on Vercel, and the files ship in the repo).
const inter = localFont({
  src: [
    { path: "./fonts/inter-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/inter-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/inter-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/inter-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});

const mono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

// One registry, so the canonical URL cannot drift from the domain that serves it.
const siteUrl = SITE_URL;

// Price and turnaround come from the catalogue, never typed beside the copy.
const SCREEN = PRODUCTS.density_screen;
const SCREEN_PRICE = eurFromCents(SCREEN.amountCents);
const SCREEN_DAYS = SCREEN.turnaroundDays === 5 ? "five" : String(SCREEN.turnaroundDays);

export const viewport: Viewport = { themeColor: "#070B14", colorScheme: "dark" };

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    // 51 characters (a result shows about 60). Pages with their own title are wrapped by the template below.
    default: "Time to Power — AI rack capacity for existing halls",
    template: "%s · Time to Power",
  },
  // 157 characters: a search result shows about 160. States what the product does and nothing else (the price and turnaround are on the page and in the social card).
  description:
    "Capacity analysis for existing data halls: how much AI compute a hall can support, what binds first and what unlocks more, with an evidence class per figure.",
  keywords: [
    "AI data center power capacity",
    "data hall rack density",
    "binding constraint",
    "density screen",
    "colocation retrofit",
    "headroom ladder",
    "time to power",
    "grid interconnection queue",
    "data center feasibility study",
    "GB300 NVL72 retrofit",
  ],
  authors: [{ name: "Vincenzo Grimaldi" }],
  // SVG for browsers that take it, PNG and ICO for the crawlers and apps that do not (Google fetches /favicon.ico; iOS ignores an SVG touch icon).
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    title: "Time to Power — AI rack capacity for existing halls",
    description:
      `How many AI racks can your hall power, and what unlocks more? Evidence-graded capacity analysis for existing halls: the limit that binds first, what relieves it, and the evidence behind every figure. Density Screen: ${SCREEN_PRICE}, ${SCREEN_DAYS} working days from a complete intake.`,
    siteName: "Time to Power",
  },
  // Only the card type: a page that sets its own openGraph title and description would otherwise inherit THIS twitter title, so a shared
  // link would show the homepage text for any page. Without twitter:title the platform uses og:title. The images are the
  // opengraph-image / twitter-image files (app/), generated from each page's own data. No twitter:site or creator: there is no account
  // (SITE.social.x is empty) and one is never invented.
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${mono.variable}`}>
      <body className="font-sans antialiased text-ghost">
        <SiteChrome>
          {/* First focusable thing on every page with the site shell (the bare presenter route carries no link at all). */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[110] focus:rounded-lg focus:bg-power focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
          >
            Skip to the main content
          </a>
          <Navbar />
          {/* "Checkout cancelled — nothing was charged" after Stripe sends a visitor back (/qualify?purchase=cancelled, /pricing?deposit=cancelled). */}
          <Suspense fallback={null}>
            <CheckoutReturnNotice />
          </Suspense>
          <BackgroundReel />
        </SiteChrome>
        <main id="main-content" tabIndex={-1} className="relative pb-16 outline-none lg:pb-0">
          {children}
        </main>
        <SiteChrome>
          <Footer />
          <StickyMobileCTA />
          <ScopingAgent />
        </SiteChrome>
        <Toaster position="top-center" theme="dark" richColors closeButton />
      </body>
    </html>
  );
}
