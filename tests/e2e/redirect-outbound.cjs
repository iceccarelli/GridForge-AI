// Harness-only preload (`node --require`): sends the site's two outside calls to the local stand-ins in tests/e2e/stand-ins.mjs.
//
//   https://api.stripe.com/...   (the Stripe SDK, over node:https)  ->  http://$E2E_STANDIN/...
//   https://api.resend.com/...   (fetch)                            ->  http://$E2E_STANDIN/...
//
// Why a preload: the production code does `new Stripe(key)` and fetches https://api.resend.com/emails directly, and neither base URL
// is configurable. Making them configurable only so a test could reach them would add an outbound-redirect switch to a payment path,
// so the redirect lives in the test harness and is switched on by an environment variable the production deployment never sets.
// Anything else leaves unchanged and, as before, cannot reach a real service from the harness' sandbox.
//
// Nothing here is loaded unless E2E_STANDIN is set, and it refuses anything but a loopback target.

"use strict";

const target = process.env.E2E_STANDIN;
if (target) {
  const [host, portText] = target.split(":");
  const port = Number(portText);
  if (!/^(127\.0\.0\.1|localhost)$/.test(host) || !Number.isInteger(port) || port < 1) {
    throw new Error(`E2E_STANDIN must be a loopback host:port, got ${JSON.stringify(target)}`);
  }

  const http = require("node:http");
  const https = require("node:https");
  const originalRequest = https.request;

  https.request = function patchedRequest(...args) {
    const first = args[0];
    const opts = first && typeof first === "object" && !(first instanceof URL) ? first : null;
    if (opts && (opts.host === "api.stripe.com" || opts.hostname === "api.stripe.com")) {
      // The SDK hands node:https an https.Agent; node:http refuses it, so the plain agent is used instead.
      const redirected = { ...opts, host, hostname: host, port, protocol: "http:", agent: undefined };
      delete redirected.ciphers;
      const req = http.request(redirected, ...args.slice(1));
      // The SDK waits for the TLS event `secureConnect` before it writes the body. A plain socket never emits it, so announce it
      // when the TCP connection opens.
      req.on("socket", (socket) => {
        socket.once("connect", () => socket.emit("secureConnect"));
      });
      return req;
    }
    return originalRequest.apply(this, args);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    if (typeof href === "string" && href.startsWith("https://api.resend.com/")) {
      const rest = href.slice("https://api.resend.com".length);
      return originalFetch(`http://${host}:${port}${rest}`, init);
    }
    return originalFetch(input, init);
  };
}
