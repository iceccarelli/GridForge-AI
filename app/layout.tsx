import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
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

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    template: "%s · Time to Power",
  },
  description:
    "Give Time to Power the technical information for an existing or proposed AI site, and it will tell you how much useful AI compute the site can actually support, what blocks it, what fixes it, what the fix costs, and when the compute can go live. Start with a Density Screen: one hall, five working days, EUR 4,500. Powered by GridForge Engine.",
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
      "The bottleneck isn't chips — it's power. A Density Screen tells you what binds one hall, how many racks it carries, and the inputs nobody has measured. EUR 4,500, five working days.",
    siteName: "Time to Power",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Time to Power" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    description:
      "What stops your hall taking AI racks, named in five working days. Density Screen, EUR 4,500 — or run the free qualifier first.",
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
