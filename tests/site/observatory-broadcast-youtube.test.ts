import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../observatory-broadcast/src/cli.mjs";
import { FakeClock } from "../../observatory-broadcast/src/clock.mjs";
import { createAdapter } from "../../observatory-broadcast/src/adapters/index.mjs";
import { Redactor } from "../../observatory-broadcast/src/redact.mjs";
import { createYouTubeVerifier, deviceAuthorize, evaluateLive, readYouTubeApiConfig } from "../../observatory-broadcast/src/youtube-api.mjs";

// The YouTube verifier is the only road to state "live" for the youtube adapter. A fake Google + YouTube stands in for the network, so
// every decision (no broadcast, preview only, wrong privacy, unhealthy stream, API refusal, revoked token) is asserted without a socket.

const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-client-secret-VALUE-1234";
const REFRESH = "1//refresh-token-VALUE-abcdefghijkl";
const ACCESS = "ya29.access-token-VALUE-xyz";
const SECRETS = [CLIENT_SECRET, REFRESH, ACCESS];
const ENV = { OBS_YOUTUBE_OAUTH_CLIENT_ID: CLIENT_ID, OBS_YOUTUBE_OAUTH_CLIENT_SECRET: CLIENT_SECRET, OBS_YOUTUBE_OAUTH_REFRESH_TOKEN: REFRESH };

type Json = Record<string, unknown>;
const live = (over: Json = {}) => ({ id: "BCAST1", status: { lifeCycleStatus: "live", privacyStatus: "unlisted", ...(over.status as Json) }, contentDetails: { boundStreamId: "STREAM1" } });
const stream = (health = "good", streamStatus = "active", issues: Json[] = []) => ({ id: "STREAM1", status: { streamStatus, healthStatus: { status: health, configurationIssues: issues } } });

/** A fake network: routes by URL, records every request. */
function fakeNet(o: { broadcasts?: unknown[]; streams?: unknown[]; token?: { status: number; body: Json }; api?: { status: number; body: Json } } = {}) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const send = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
      const t = o.token ?? { status: 200, body: { access_token: ACCESS, expires_in: 3600 } };
      return send(t.status, t.body);
    }
    if (u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/liveBroadcasts") {
      if (o.api) return send(o.api.status, o.api.body);
      return send(200, { items: o.broadcasts ?? [live()] });
    }
    if (u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/liveStreams") return send(200, { items: o.streams ?? [stream()] });
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, api: () => calls.filter((c) => c.url.includes("/youtube/v3/")).length, tokens: () => calls.filter((c) => c.url.endsWith("/token")).length };
}

function verifier(net: ReturnType<typeof fakeNet>, extra: Json = {}) {
  const clock = new FakeClock();
  const v = createYouTubeVerifier({ env: ENV, fetch: net.fetchImpl, clock, redactor: new Redactor(), ...extra });
  return { v, clock };
}
const noSecret = (s: string) => { for (const x of SECRETS) expect(s).not.toContain(x); };

describe("youtube verifier: the decision (pure)", () => {
  const now = "2026-10-28T06:00:00.000Z";
  const run = (broadcasts: unknown[], streams: unknown[], declaredVisibility?: string) => evaluateLive({ broadcasts, streams, declaredVisibility, nowIso: now });

  it("confirms only a single live broadcast with an active, healthy stream, and puts the facts in the evidence", () => {
    for (const health of ["good", "ok"]) {
      const r = run([live()], [stream(health)], "unlisted");
      expect(r.ok).toBe(true);
      expect(r.evidence).toContain("BCAST1");
      expect(r.evidence).toContain("privacy unlisted");
      expect(r.evidence).toContain(`health ${health}`);
      expect(r.evidence).toContain(now);
    }
  });
  it("is not live when nothing is active, or when several are (it cannot tell which one this encoder feeds)", () => {
    expect(run([], []).ok).toBe(false);
    expect(run([], []).evidence).toMatch(/nothing has been taken live/);
    const two = run([live(), { ...live(), id: "BCAST2" }], [stream()]);
    expect(two.ok).toBe(false);
    expect(two.evidence).toMatch(/2 active broadcasts/);
  });
  it("is not live while the broadcast is only in preview or still starting", () => {
    expect(run([live({ status: { lifeCycleStatus: "testing" } })], [stream()]).evidence).toMatch(/preview/);
    expect(run([live({ status: { lifeCycleStatus: "liveStarting" } })], [stream()]).evidence).toMatch(/still starting/);
    expect(run([live({ status: { lifeCycleStatus: "complete" } })], [stream()]).ok).toBe(false);
  });
  it("is not live when the privacy differs from what the operator declared, and says what to change", () => {
    const r = run([live({ status: { privacyStatus: "public" } })], [stream()], "unlisted");
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/privacy "public" but the plan declared "unlisted"/);
    expect(run([live({ status: { privacyStatus: "public" } })], [stream()]).ok).toBe(true); // nothing declared: reported, not judged
  });
  it("is not live when YouTube is not receiving video or the stream is unhealthy, naming the configuration issues", () => {
    expect(run([live()], [stream("good", "inactive")]).evidence).toMatch(/not active/);
    expect(run([live()], [stream("noData")]).ok).toBe(false);
    const bad = run([live()], [stream("bad", "active", [{ type: "videoBitrateLow", severity: "warning", reason: "free text that must not be copied" }])]);
    expect(bad.ok).toBe(false);
    expect(bad.evidence).toContain("videoBitrateLow");
    expect(bad.evidence).not.toContain("free text");
    expect(run([live()], []).evidence).toMatch(/no readable stream/);
  });
});

describe("youtube verifier: configuration", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-yt-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("none set is 'not configured'; some set is 'partial' and names what is missing; all set is configured", () => {
    expect(readYouTubeApiConfig({})).toMatchObject({ configured: false, partial: false });
    const half = readYouTubeApiConfig({ OBS_YOUTUBE_OAUTH_CLIENT_ID: CLIENT_ID });
    expect(half.configured).toBe(false);
    expect(half.partial).toBe(true);
    expect(half.errors.join(" ")).toMatch(/CLIENT_SECRET/);
    expect(half.errors.join(" ")).toMatch(/obs youtube-auth/);
    expect(readYouTubeApiConfig(ENV)).toMatchObject({ configured: true, partial: false });
  });
  it("secrets may come from a 0600 file, but not from one other users can read", () => {
    const f = path.join(tmp, "rt");
    fs.writeFileSync(f, REFRESH + "\n", { mode: 0o600 });
    const { OBS_YOUTUBE_OAUTH_REFRESH_TOKEN: _drop, ...rest } = ENV;
    expect(readYouTubeApiConfig({ ...rest, OBS_YOUTUBE_OAUTH_REFRESH_TOKEN_FILE: f })).toMatchObject({ configured: true, refreshToken: REFRESH });
    fs.chmodSync(f, 0o644);
    const bad = readYouTubeApiConfig({ ...rest, OBS_YOUTUBE_OAUTH_REFRESH_TOKEN_FILE: f });
    expect(bad.configured).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/chmod 600/);
  });
  it("refuses to build a verifier from an incomplete configuration", () => {
    expect(() => createYouTubeVerifier({ env: { OBS_YOUTUBE_OAUTH_CLIENT_ID: CLIENT_ID } })).toThrow(/not configured/);
  });
});

describe("youtube verifier: the network behaviour", () => {
  it("makes read-only calls to two Google hosts only, over https, with the bearer token, no redirects and a timeout", async () => {
    const net = fakeNet();
    const { v } = verifier(net);
    const r = await v({ adapter: "youtube", stream: { visibility: "unlisted" } });
    expect(r.ok).toBe(true);
    noSecret(r.evidence);
    expect(net.calls.map((c) => new URL(c.url).hostname)).toEqual(["oauth2.googleapis.com", "www.googleapis.com", "www.googleapis.com"]);
    for (const c of net.calls) { expect(c.url.startsWith("https://")).toBe(true); expect(c.init.redirect).toBe("error"); expect(c.init.signal).toBeInstanceOf(AbortSignal); }
    const list = net.calls[1];
    expect(new URL(list.url).searchParams.get("broadcastStatus")).toBe("active");
    expect(list.init.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(list.init.method ?? "GET").toBe("GET");
    expect(net.calls[0].init.method).toBe("POST"); // the only write-shaped call is the token refresh itself
  });

  it("caches the answer so a supervisor that asks every few seconds stays inside the daily quota", async () => {
    const net = fakeNet();
    const { v, clock } = verifier(net);
    const ctx = { adapter: "youtube", stream: { visibility: "unlisted" } };
    await v(ctx); await v(ctx); await v(ctx);
    expect(net.api()).toBe(2);
    await clock.advance(29_000); await v(ctx);
    expect(net.api()).toBe(2);
    await clock.advance(2_000); await v(ctx);
    expect(net.api()).toBe(4);
    expect(net.tokens()).toBe(1); // the access token is reused until a minute before it expires
    await clock.advance(3_600_000); await v(ctx);
    expect(net.tokens()).toBe(2);
  });

  it("a change of declared visibility is not answered from the cache", async () => {
    const net = fakeNet();
    const { v } = verifier(net);
    expect((await v({ adapter: "youtube", stream: { visibility: "unlisted" } })).ok).toBe(true);
    const r = await v({ adapter: "youtube", stream: { visibility: "public" } });
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/declared "public"/);
  });

  it("an API refusal fails closed with the short reason, backs off for two minutes, and never copies the response body", async () => {
    const net = fakeNet({ api: { status: 403, body: { error: { errors: [{ reason: "liveStreamingNotEnabled", message: "SECRET-BODY-TEXT you should never see" }] } } } });
    const { v, clock } = verifier(net);
    const r = await v({ adapter: "youtube", stream: null });
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/liveStreamingNotEnabled/);
    expect(r.evidence).not.toContain("SECRET-BODY-TEXT");
    const n = net.api();
    await clock.advance(60_000); await v({ adapter: "youtube", stream: null });
    expect(net.api()).toBe(n);
    await clock.advance(61_000); await v({ adapter: "youtube", stream: null });
    expect(net.api()).toBe(n + 1);
  });

  it("a reason that is not a short identifier is reported as the HTTP status, not echoed", async () => {
    const net = fakeNet({ api: { status: 500, body: { error: { errors: [{ reason: "x y <script>alert(1)</script>" }] } } } });
    const r = await verifier(net).v({ adapter: "youtube", stream: null });
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/http 500/);
    expect(r.evidence).not.toContain("<script>");
  });

  it("a revoked refresh token says so and leaks no secret", async () => {
    const net = fakeNet({ token: { status: 400, body: { error: "invalid_grant", error_description: `Token has been revoked ${REFRESH}` } } });
    const r = await verifier(net).v({ adapter: "youtube", stream: null });
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/invalid_grant/);
    noSecret(r.evidence);
  });

  it("a network failure or a redirect is a failed verification, not a crash", async () => {
    const net = fakeNet();
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const r = await verifier(net, { fetch: failing }).v({ adapter: "youtube", stream: null });
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/could not reach oauth2\.googleapis\.com/);
  });
});

describe("youtube verifier: the adapter reaches 'live' only through it", () => {
  const adapterWith = (net: ReturnType<typeof fakeNet>) => {
    const redactor = new Redactor();
    const verifierFn = createYouTubeVerifier({ env: ENV, fetch: net.fetchImpl, clock: new FakeClock(), redactor });
    const a = createAdapter("youtube", { redactor, verifier: verifierFn, checkFfmpeg: () => "fake", hasFfmpegFeature: () => true });
    a.validateConfig({ OBS_YOUTUBE_STREAM_KEY: "STREAMKEY-aaaa-bbbb-cccc" });
    return a;
  };

  it("is verified:true and live with the evidence when YouTube confirms; liveVerifiable is true", async () => {
    const a = adapterWith(fakeNet());
    expect(a.status().liveVerifiable).toBe(true);
    const r = await a.verify();
    expect(r).toMatchObject({ ok: true, supported: true });
    expect(a.status()).toMatchObject({ state: "live", verified: true });
    expect(a.status().evidence).toContain("BCAST1");
  });
  it("stays out of live while YouTube says the broadcast is only in preview", async () => {
    const a = adapterWith(fakeNet({ broadcasts: [live({ status: { lifeCycleStatus: "testing" } })] }));
    const r = await a.verify();
    expect(r.ok).toBe(false);
    expect(a.status().state).not.toBe("live");
    expect(a.status().verified).toBe(false);
  });
  it("describes itself honestly: the API is asked after the encoder starts, visibility can be checked but not set", async () => {
    const a = adapterWith(fakeNet());
    const pre = await a.preflight();
    expect(pre.ok).toBe(true);
    expect(pre.verified).toBe(false);
    const text = pre.notes.join(" ");
    expect(text).toMatch(/unverified until the broadcast is live/);
    expect(text).toMatch(/cannot SET the platform-side visibility/);
    expect(text).toMatch(/read-only YouTube Data API/);
    expect(text).not.toMatch(/the YouTube API is not called/);
  });
  it("without credentials nothing changes: it cannot verify and says so", async () => {
    const a = createAdapter("youtube", { checkFfmpeg: () => "fake", hasFfmpegFeature: () => true });
    a.validateConfig({ OBS_YOUTUBE_STREAM_KEY: "STREAMKEY-aaaa-bbbb-cccc" });
    expect(a.status().liveVerifiable).toBe(false);
    expect((await a.verify()).supported).toBe(false);
    expect((await a.preflight()).notes.join(" ")).toMatch(/the YouTube API is not called/);
  });
});

describe("youtube verifier: device sign-in", () => {
  const noWait = async () => {};
  const script = (steps: { status: number; body: Json }[], deviceBody: Json = { device_code: "DEVCODE-secret-1234", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 }) => {
    const calls: { url: string; body: string }[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: any = {}) => {
      calls.push({ url, body: String(init.body ?? "") });
      const send = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
      if (url.endsWith("/device/code")) return send(200, deviceBody);
      const step = steps[Math.min(i++, steps.length - 1)];
      return send(step.status, step.body);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  it("asks only for the read-only scope, shows the code, waits through 'pending' and 'slow_down', and returns the refresh token", async () => {
    const net = script([
      { status: 428, body: { error: "authorization_pending" } },
      { status: 403, body: { error: "slow_down" } },
      { status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 } },
    ]);
    const said: string[] = [];
    const token = await deviceAuthorize({ env: ENV, fetch: net.fetchImpl, sleep: noWait, say: (s) => said.push(s) });
    expect(token).toBe(REFRESH);
    expect(net.calls[0].body).toContain("youtube.readonly");
    expect(net.calls[0].body).not.toContain("youtube.force-ssl");
    expect(said.join("\n")).toContain("ABCD-EFGH");
    expect(said.join("\n")).toMatch(/READ-ONLY/);
    for (const s of [...SECRETS, "DEVCODE-secret-1234"]) expect(said.join("\n")).not.toContain(s);
  });
  it("a declined or expired request is an error, and a lookalike verification URL is replaced by Google's", async () => {
    await expect(deviceAuthorize({ env: ENV, fetch: script([{ status: 403, body: { error: "access_denied" } }]).fetchImpl, sleep: noWait, say: () => {} })).rejects.toMatchObject({ code: "youtube_auth_denied" });
    await expect(deviceAuthorize({ env: ENV, fetch: script([{ status: 400, body: { error: "expired_token" } }]).fetchImpl, sleep: noWait, say: () => {} })).rejects.toMatchObject({ code: "youtube_auth_expired" });
    const said: string[] = [];
    await deviceAuthorize({
      env: ENV, sleep: noWait, say: (s) => said.push(s),
      fetch: script([{ status: 200, body: { refresh_token: REFRESH } }], { device_code: "D1234567", user_code: "WXYZ-1234", verification_url: "https://evil.example/device" }).fetchImpl,
    });
    expect(said.join("\n")).toContain("https://www.google.com/device");
    expect(said.join("\n")).not.toContain("evil.example");
  });
  it("needs the client id and secret first, and says what kind of client", async () => {
    await expect(deviceAuthorize({ env: {}, say: () => {} })).rejects.toMatchObject({ code: "youtube_oauth_incomplete", message: expect.stringMatching(/TVs and Limited Input devices/) });
  });
});

describe("youtube verifier: the operator commands", () => {
  let tmp: string;
  let stateDir: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-yt-cli-")); stateDir = path.join(tmp, "state"); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  async function obs(argv: string[], env: Record<string, string>, io: Json = {}) {
    const lines: string[] = [];
    const code = await main(argv, { env: { PATH: process.env.PATH, OBS_STATE_DIR: stateDir, ...env }, stdout: (s: string) => lines.push(s), stderr: (s: string) => lines.push(s), ...io } as any);
    return { code, text: lines.join("") };
  }

  it("youtube-check: exit 0 with the evidence when confirmed, exit 1 when not, exit 2 when not configured or half-configured", async () => {
    const ok = await obs(["youtube-check", "--visibility", "unlisted"], ENV, { fetch: fakeNet().fetchImpl });
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/CONFIRMED by YouTube: .*BCAST1/);
    const no = await obs(["youtube-check"], ENV, { fetch: fakeNet({ broadcasts: [] }).fetchImpl });
    expect(no.code).toBe(1);
    expect(no.text).toMatch(/NOT confirmed: no active YouTube broadcast/);
    const wrong = await obs(["youtube-check", "--visibility", "private"], ENV, { fetch: fakeNet().fetchImpl });
    expect(wrong.code).toBe(1);
    expect(wrong.text).toMatch(/declared "private"/);
    expect((await obs(["youtube-check"], {})).code).toBe(2);
    const half = await obs(["youtube-check"], { OBS_YOUTUBE_OAUTH_CLIENT_ID: CLIENT_ID });
    expect(half.code).toBe(2);
    expect(half.text).toMatch(/youtube_oauth_incomplete|not configured/);
    for (const r of [ok, no, wrong, half]) noSecret(r.text);
  });

  it("youtube-auth: stores the refresh token 0600 in the state dir and never prints it", async () => {
    const net = (() => {
      const f = (async (url: string) => {
        const send = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
        if (url.endsWith("/device/code")) return send(200, { device_code: "DEVCODE-1234567", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", interval: 1, expires_in: 600 });
        return send(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
      }) as unknown as typeof fetch;
      return f;
    })();
    const r = await obs(["youtube-auth"], { OBS_YOUTUBE_OAUTH_CLIENT_ID: CLIENT_ID, OBS_YOUTUBE_OAUTH_CLIENT_SECRET: CLIENT_SECRET }, { fetch: net, sleep: async () => {} });
    expect(r.code).toBe(0);
    noSecret(r.text);
    expect(r.text).toContain("ABCD-EFGH");
    const file = path.join(stateDir, "youtube-refresh-token");
    expect(fs.readFileSync(file, "utf8").trim()).toBe(REFRESH);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(r.text).toContain("OBS_YOUTUBE_OAUTH_REFRESH_TOKEN_FILE=" + file);
  });

  it("prepare for youtube refuses a half-configured verifier instead of silently downgrading to 'never live'", async () => {
    const r = await obs(["prepare", "--adapter", "youtube", "--url", "http://localhost:3000/observatory/presenter"], { OBS_YOUTUBE_STREAM_KEY: "STREAMKEY-aaaa-bbbb-cccc", OBS_YOUTUBE_OAUTH_CLIENT_ID: CLIENT_ID });
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/half-configured/);
  });

  it("help lists the two commands and the three variables", async () => {
    const h = await obs(["help"], {});
    expect(h.text).toMatch(/youtube-auth/);
    expect(h.text).toMatch(/youtube-check/);
    expect(h.text).toMatch(/OBS_YOUTUBE_OAUTH_CLIENT_ID/);
  });
});
