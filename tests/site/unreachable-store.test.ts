/**
 * A token page must fail closed, not 500.
 *
 * Found by checking production after the merge: on one domain every
 * token-addressed page — /intake, /deliverable, /watch, /api-access — returned
 * HTTP 500, while /q/ returned 404.
 *
 * The difference is one try/catch. lib/qualify.ts wraps its fetch; the deliverable,
 * watch and api-access lookups do not. `fetch` REJECTS on a network-level failure
 * (bad host, DNS, refused connection) rather than returning a status, so the
 * rejection propagates out of the server component and Next renders a 500.
 *
 * The customer on the other end of that 500 is holding a link to something they
 * paid four to five figures for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let restore: () => void;

/** Every fetch rejects, the way an unreachable host does. */
function installThrowingFetch() {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  restore = installThrowingFetch();
});

afterEach(() => restore());

describe("an unreachable store fails closed rather than throwing", () => {
  it("getByToken — the deliverable page — THE regression", async () => {
    const { getByToken } = await import("@/lib/deliverables");
    await expect(getByToken("any-token")).resolves.toBeNull();
  });

  it("getByIntakeToken — the intake page", async () => {
    const { getByIntakeToken } = await import("@/lib/deliverables");
    await expect(getByIntakeToken("any-token")).resolves.toBeNull();
  });

  it("deliverableBySession — the post-payment page", async () => {
    const { deliverableBySession } = await import("@/lib/deliverables");
    await expect(deliverableBySession("cs_any")).resolves.toBeNull();
  });

  it("getWatch — the Hall Watch page", async () => {
    const { getWatch } = await import("@/lib/watches");
    await expect(getWatch("any-token")).resolves.toBeNull();
  });

  it("getApiAccount — the API portal", async () => {
    const { getApiAccount } = await import("@/lib/api-access");
    await expect(getApiAccount("any-token")).resolves.toBeNull();
  });

  it("getQualification already did this, which is why /q/ stayed at 404", async () => {
    const { getQualification } = await import("@/lib/qualify");
    await expect(getQualification("any-token")).resolves.toBeNull();
  });
});
