import { describe, expect, it } from "vitest";
import { SiteBody } from "@/lib/sites";

// zod 4 takes { error } where zod 3 took { errorMap }: the message the person is shown for a missing or unknown data kind must actually come out.
describe("SiteBody dataOrigin", () => {
  const ORG = "00000000-0000-4000-8000-000000000001";
  it.each([undefined, "", "prod", "Production", 1, null])("%j is refused with the plain-language message", (dataOrigin) => {
    const r = SiteBody.safeParse({ orgId: ORG, name: "S", dataOrigin });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.find((i) => i.path[0] === "dataOrigin")?.message).toBe("Say whether this site holds production, test or synthetic data.");
  });
  it.each(["production", "test", "synthetic"])("%s is accepted", (dataOrigin) => {
    expect(SiteBody.safeParse({ orgId: ORG, name: "S", dataOrigin }).success).toBe(true);
  });
});
