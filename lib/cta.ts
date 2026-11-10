// The primary paid CTA's label, built from the catalogue. It lives here, outside any "use client" module, because a Server Component
// that imports a constant from a client module receives a reference instead of the value. lib/ui.ts re-exports it for the client code
// that already imports it from there, so there is still exactly one definition.

import { PRODUCTS, eurFromCents } from "@/lib/products";

const SCREEN = PRODUCTS.density_screen;

export const DENSITY_SCREEN_CTA = `${SCREEN.name} — ${eurFromCents(SCREEN.amountCents)} · ${SCREEN.turnaroundDays} working days`;
