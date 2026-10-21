import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "sonner";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { BackgroundReel } from "@/components/BackgroundReel";
import { MotionProvider } from "@/components/MotionProvider";
import { ScopingAgent } from "@/components/ScopingAgent";
import { StickyMobileCTA } from "@/components/StickyMobileCTA";

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

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    template: "%s · Time to Power",
  },
  description:
    `Give Time to Power the technical information for an existing AI hall, and it will tell you how much useful AI compute the hall can actually support, what blocks it, what fixes it, what the fix costs, and the time to full capacity, with the evidence class behind each figure. Start with a Density Screen: one hall, ${SCREEN_DAYS} working days, ${SCREEN_PRICE}. Powered by GridForge Engine.`,
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
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  openGraph: {
    type: "website",
    url: siteUrl,
    title: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    description:
      `The bottleneck isn't chips — it's power. A Density Screen tells you what binds one hall, how many racks it carries, and the inputs nobody has measured. ${SCREEN_PRICE}, ${SCREEN_DAYS} working days.`,
    siteName: "Time to Power",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Time to Power" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    description:
      `What stops your hall taking AI racks, named in ${SCREEN_DAYS} working days. Density Screen, ${SCREEN_PRICE} — or run the free qualifier first.`,
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${mono.variable}`}>
      <body className="font-sans antialiased text-ghost">
        <MotionProvider>
        <Navbar />
        <BackgroundReel />
        <main className="relative pb-16 lg:pb-0">{children}</main>
        <Footer />
        <StickyMobileCTA />
        <ScopingAgent />
        <Toaster position="top-center" theme="dark" richColors closeButton />
        </MotionProvider>
      </body>
    </html>
  );
}
