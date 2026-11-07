// The one browser-storage record that carries "which product did this visitor just send to Stripe" across the round trip, so that a cancelled
// checkout can offer the way back to THAT product's page when the return URL does not name it. It holds a catalogue product id and a time;
// the reader validates the id against the catalogue, accepts it only within an hour, and REMOVES it the moment it is read, so a stale id
// cannot name a product on a later return. Kept in its own tiny module so lib/ui.ts (in every page's bundle) does not import the catalogue.
export const LAST_CHECKOUT_KEY = "gf:last-checkout-product";

/** How long a remembered product may name the page a buyer cancelled from. */
export const REMEMBER_MS = 60 * 60 * 1000;

export function rememberCheckout(productId: string, now: number = Date.now()): void {
  try {
    window.sessionStorage.setItem(LAST_CHECKOUT_KEY, JSON.stringify({ id: productId, at: now }));
  } catch {
    /* storage blocked: the notice then offers the general list */
  }
}

/** The remembered product id, or null when none, stale or unreadable. Always clears the record: it is consumed by being read. */
export function takeRememberedCheckout(now: number = Date.now()): string | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_CHECKOUT_KEY);
    window.sessionStorage.removeItem(LAST_CHECKOUT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof v.id !== "string" || typeof v.at !== "number" || now - v.at > REMEMBER_MS || now < v.at) return null;
    return v.id;
  } catch {
    return null;
  }
}
