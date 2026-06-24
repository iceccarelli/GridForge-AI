// Client helper: start a Stripe Checkout session and redirect to it.
"use client";

export async function startDeposit(opts: {
  company?: string;
  email?: string;
  capacityMW?: number;
  service?: string;
  founding?: boolean;
}): Promise<void> {
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    const data = await res.json();
    if (data.ok && data.url) {
      window.location.href = data.url;
    } else {
      alert("Could not start checkout. Please try the audit form instead.");
    }
  } catch {
    alert("Could not start checkout. Please try the audit form instead.");
  }
}
