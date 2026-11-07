// The one browser-storage key that carries "which product did this visitor just send to Stripe" across the round trip, so that a cancelled
// checkout can offer the way back to THAT product's page. Kept in its own tiny module so lib/ui.ts (in every page's bundle) does not import
// the catalogue to write it. It holds a catalogue product id and nothing else; the reader validates it against the catalogue.
export const LAST_CHECKOUT_KEY = "gf:last-checkout-product";
