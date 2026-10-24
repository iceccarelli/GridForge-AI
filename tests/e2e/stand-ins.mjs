// Local stand-ins for the two outside services the purchase journey touches: Stripe and the email provider.
//
// Development and testing only. NOTHING here talks to Stripe or Resend, and nothing here is a proof that either service works:
// it records what the site SENT, so a test can assert on the request (the metadata Stripe would have been given, the mails that
// would have gone out) and so the journey can run end to end without a live account, a real card or a real inbox.
//
//   * Stripe: POST /v1/checkout/sessions (records the decoded form, answers with a session whose `url` is this server's own
//     /pay/<id> page), POST /v1/coupons. Every other Stripe route answers 404, as Stripe does for an unknown resource, and is
//     listed in `unhandled` so a test can see the site asked for something this stand-in does not model. In particular a
//     session RETRIEVE is not modelled, so the release gate's "Stripe cannot say whether this payment stands" path is unchanged.
//   * GET /pay/<id>: the "Stripe-hosted page" a browser lands on. It says in plain words that no payment is taken here.
//   * Resend: POST /emails (records the message, answers with an id).
//
// The site process reaches these through tests/e2e/redirect-outbound.cjs (a --require preload used only by the harness), because
// the production code builds `new Stripe(key)` and calls https://api.resend.com directly; neither base URL is configurable and
// this must not change just so a test can reach them.

import http from "node:http";

/** Stripe encodes nested params the way `qs` does: a[b][0][c]=1. Decode into plain objects and arrays. */
export function decodeStripeForm(body) {
  const root = {};
  for (const pair of String(body).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const dec = (v) => decodeURIComponent(v.replace(/\+/g, " "));
    const rawKey = dec(eq < 0 ? pair : pair.slice(0, eq));
    const value = dec(eq < 0 ? "" : pair.slice(eq + 1));
    const parts = [rawKey.replace(/\[.*$/, ""), ...[...rawKey.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1])];
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (i === parts.length - 1) {
        if (Array.isArray(node) && key === "") node.push(value);
        else node[key] = value;
        break;
      }
      const next = parts[i + 1];
      if (node[key] === undefined) node[key] = next === "" || /^\d+$/.test(next) ? [] : {};
      node = node[key];
    }
  }
  return root;
}

export async function startStandIns(port = 0) {
  const state = { stripeSessions: [], stripeCoupons: [], mails: [], unhandled: [], paid: [] };
  let n = 0;
  let base = "";

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://standin.local");
      const json = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json", "request-id": `req_standin_${++n}` });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const params = decodeStripeForm(body);
        const id = `cs_test_standin_${state.stripeSessions.length + 1}`;
        const session = {
          id,
          object: "checkout.session",
          url: `${base}/pay/${id}`,
          // A freshly created session is open and unpaid, exactly as Stripe's is. It only becomes paid on Stripe's own page.
          status: "open",
          payment_status: "unpaid",
          mode: params.mode,
          metadata: params.metadata ?? {},
          customer_email: params.customer_email ?? null,
          amount_total: params.line_items?.[0]?.price_data?.unit_amount ? Number(params.line_items[0].price_data.unit_amount) : null,
        };
        state.stripeSessions.push({ id, params, headers: req.headers, session });
        return json(200, session);
      }
      if (req.method === "POST" && url.pathname === "/v1/coupons") {
        const params = decodeStripeForm(body);
        const id = `coupon_standin_${state.stripeCoupons.length + 1}`;
        state.stripeCoupons.push({ id, params });
        return json(200, { id, object: "coupon" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/pay/")) {
        const id = decodeURIComponent(url.pathname.slice("/pay/".length));
        const found = state.stripeSessions.find((s) => s.id === id);
        res.writeHead(found ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stripe Checkout stand-in</title></head><body>` +
            `<main><h1>Stripe Checkout stand-in</h1>` +
            (found
              ? `<p id="standin-session">${id}</p><p>This is a local test double standing where Stripe's hosted page would be. ` +
                `No card is taken and no payment is made here.</p>`
              : `<p>No such session.</p>`) +
            `</main></body></html>`
        );
      }
      if (req.method === "POST" && url.pathname === "/emails") {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* recorded as empty */ }
        state.mails.push({
          to: [].concat(parsed.to ?? []),
          subject: String(parsed.subject ?? ""),
          text: String(parsed.text ?? ""),
          from: parsed.from,
          idempotencyKey: req.headers["idempotency-key"] ?? null,
        });
        return json(200, { id: `re_standin_${state.mails.length}` });
      }
      state.unhandled.push(`${req.method} ${url.pathname}`);
      return json(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${req.method} ${url.pathname}): local stand-in does not model it.` } });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const boundPort = server.address().port;
  base = `http://127.0.0.1:${boundPort}`;

  return {
    port: boundPort,
    base,
    /** "host:port" as tests/e2e/redirect-outbound.cjs expects it in E2E_STANDIN. */
    target: `127.0.0.1:${boundPort}`,
    state,
    sessions: () => state.stripeSessions,
    mails: () => state.mails,
    mailsTo: (address) => state.mails.filter((m) => m.to.map((t) => t.toLowerCase()).includes(address.toLowerCase())),
    reset() {
      state.stripeSessions.length = 0;
      state.stripeCoupons.length = 0;
      state.mails.length = 0;
      state.unhandled.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
