// Which URLs are a return from a cancelled checkout. No imports, so the shell can ask on every page without loading the catalogue
// (lib/checkout-return.ts holds that, and is loaded only when the notice actually shows).

/** The routes Stripe returns to on cancel, and the one parameter that marks the return. */
export const CANCEL_RETURNS: { path: string; param: string }[] = [
  { path: "/qualify", param: "purchase" },
  { path: "/pricing", param: "deposit" },
];

export function isCancelledReturn(pathname: string | null | undefined, params: { get(name: string): string | null }): boolean {
  return CANCEL_RETURNS.some((r) => pathname === r.path && params.get(r.param) === "cancelled");
}
