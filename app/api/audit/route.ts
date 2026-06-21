import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Lead-capture fallback. If RESEND_API_KEY + LEAD_TO_EMAIL are set, it emails
// the lead; otherwise it logs server-side and returns ok so the UX never
// silently fails. For most setups, NEXT_PUBLIC_FORMSPREE_ID is the simplest
// path and this route is only the backstop.
export async function POST(req: Request) {
  let data: Record<string, unknown>;
  try {
    data = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const required = ["name", "company", "email", "location", "message"];
  for (const key of required) {
    if (!data[key] || typeof data[key] !== "string") {
      return NextResponse.json(
        { ok: false, error: `Missing field: ${key}` },
        { status: 422 }
      );
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "GridForge AI <onboarding@resend.dev>";

  if (apiKey && to) {
    try {
      const lines = Object.entries(data)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("\n");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          reply_to: String(data.email),
          subject: `Power Audit request — ${data.company}`,
          text: `New audit request via gridforge.ai\n\n${lines}`,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error("Resend error:", detail);
        return NextResponse.json({ ok: false }, { status: 502 });
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error("Lead email failed:", err);
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  // No email provider configured — record it so nothing is lost in dev.
  console.log("[GridForge] audit request:", JSON.stringify(data));
  return NextResponse.json({ ok: true, mode: "logged" });
}
