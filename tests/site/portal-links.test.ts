/**
 * Unconfirmed-email sessions get null tokens from /api/engagements and {verified:false} from /api/subscription-status.
 * No page may turn those into /watch/null; they must say "confirm your email" instead.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIRM_EMAIL_TEXT, documentHref, intakeHref, isUnverified, watchHref } from "@/lib/portal-links";

const ROOT = path.resolve(__dirname, "../..");

describe("portal links are built only from tokens that exist", () => {
  it("returns a link for a real token and encodes it", () => {
    expect(watchHref({ token: "abc" })).toBe("/watch/abc");
    expect(documentHref({ documentToken: "d/1" })).toBe("/deliverable/d%2F1");
    expect(intakeHref({ intakeToken: "i1" })).toBe("/intake/i1");
  });
  it("returns null, never /x/null, for a missing, empty or stringified-null token", () => {
    for (const t of [null, undefined, "", "null", "undefined", 5 as unknown as string]) {
      expect(watchHref({ token: t })).toBeNull();
      expect(documentHref({ documentToken: t })).toBeNull();
      expect(intakeHref({ intakeToken: t })).toBeNull();
    }
  });
  it("only an explicit verified:false is unconfirmed; an older route with no flag is not", () => {
    expect(isUnverified({ verified: false })).toBe(true);
    expect(isUnverified({ verified: true })).toBe(false);
    expect(isUnverified({})).toBe(false);
    expect(isUnverified(null)).toBe(false);
  });
});

describe("the pages use the helpers and show the confirm-your-email state", () => {
  const dash = fs.readFileSync(path.join(ROOT, "app/dashboard/page.tsx"), "utf8");
  const account = fs.readFileSync(path.join(ROOT, "app/account/page.tsx"), "utf8");
  it("the dashboard never interpolates a token into a link", () => {
    expect(dash).not.toMatch(/\$\{(w|e)\.(token|documentToken|intakeToken)\}/);
    expect(dash).toContain("watchHref(");
    expect(dash).toContain("documentHref(");
    expect(dash).toContain("intakeHref(");
    expect(dash).toContain("CONFIRM_EMAIL_TEXT");
    expect(dash).toContain("isUnverified(body)");
  });
  it("the account page shows the confirm state, not the upgrade prompt, for verified:false", () => {
    expect(account).toContain("isUnverified(j)");
    expect(account).toMatch(/unverified \? <ConfirmEmail \/> : <Gate \/>/);
  });
  it("the message says what to do", () => {
    expect(CONFIRM_EMAIL_TEXT).toMatch(/Confirm your email to open this/);
  });
});
