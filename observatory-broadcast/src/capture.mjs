import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsError } from "./errors.mjs";
import { checkTargetUrl, isAllowedSubrequest } from "./safety.mjs";

/**
 * STAGE 1: SCENE. A URL rendered in headless Chromium at a fixed viewport.
 *
 * Playwright is deliberately NOT a project dependency (the Next app has no use for it). It is loaded at run time from
 * PLAYWRIGHT_MODULE (default /opt/node-tools/node_modules/playwright) and the browser from CHROMIUM
 * (default /opt/pw-browsers/chromium), exactly as tests/e2e/browser-journeys.mjs does.
 *
 * The scene may only talk to its own origin: every request the page makes is checked, and document navigations (including
 * redirects) are re-checked against the allow-list, so a redirect cannot carry the browser to /admin or an off-list host.
 */
export function loadPlaywright(env = process.env) {
  const require = createRequire(import.meta.url);
  try {
    return require(env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright");
  } catch (err) {
    throw new ObsError("playwright_missing", `Playwright could not be loaded (${err instanceof Error ? err.message.split("\n")[0] : err})`, {
      exitCode: 2,
      hint: "Set PLAYWRIGHT_MODULE to a Playwright install (it is intentionally not a project dependency) and CHROMIUM to a browser binary.",
    });
  }
}

/** Query parameters of the deterministic frame contract: ?t=<seconds>&freeze=1 */
export function withFrameParams(url, tSec) {
  const u = new URL(String(url));
  u.searchParams.set("t", tSec.toFixed(3));
  u.searchParams.set("freeze", "1");
  return u.toString();
}

/**
 * @typedef {{ context: any, page: any, userDataDir: string, blocked: string[], close: () => Promise<void> }} Scene
 */

/**
 * Open a page in a fresh persistent Chromium profile (its path is unique per run, which is also how orphaned browsers are found).
 * @param {{ url: string, allow?: readonly string[], viewport: { width: number, height: number }, env?: Record<string, string | undefined>, recordVideoDir?: string, workRoot?: string }} o
 * @returns {Promise<Scene>}
 */
export async function openScene(o) {
  const env = o.env ?? process.env;
  const pw = loadPlaywright(env);
  const sceneUrl = new URL(o.url);
  const userDataDir = fs.mkdtempSync(path.join(o.workRoot ?? os.tmpdir(), "obs-chromium-"));
  /** @type {string[]} */ const blocked = [];
  let context;
  try {
    context = await pw.chromium.launchPersistentContext(userDataDir, {
      executablePath: env.CHROMIUM || "/opt/pw-browsers/chromium",
      headless: true,
      args: ["--no-sandbox", "--mute-audio", "--hide-scrollbars", "--force-device-scale-factor=1"],
      viewport: o.viewport,
      deviceScaleFactor: 1,
      ...(o.recordVideoDir ? { recordVideo: { dir: o.recordVideoDir, size: o.viewport } } : {}),
    });
  } catch (err) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new ObsError("browser_launch_failed", `Chromium could not be launched: ${err instanceof Error ? err.message.split("\n")[0] : err}`, {
      exitCode: 2,
      hint: "Set CHROMIUM to a Chromium/Chrome binary that can run headless (and --no-sandbox in this environment).",
    });
  }
  await context.route("**/*", (/** @type {any} */ route) => {
    const req = route.request();
    const u = req.url();
    const nav = req.isNavigationRequest() && req.frame() === page.mainFrame();
    const ok = nav ? checkTargetUrl(u, { allow: o.allow }).ok : isAllowedSubrequest(u, sceneUrl);
    if (ok) return route.continue();
    blocked.push(u);
    return route.abort("blockedbyclient");
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const close = async () => {
    try { await context.close(); } catch { /* already closed */ }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { context, page, userDataDir, blocked, close };
}

/** Navigate and wait until fonts and two animation frames have settled. Throws ObsError if the final URL left the allow-list. */
export async function gotoStable(page, url, { allow, timeoutMs = 20_000 } = {}) {
  const resp = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
  if (resp && resp.status() >= 400) throw new ObsError("scene_http_error", `scene responded with HTTP ${resp.status()}`);
  const final = page.url();
  const chk = checkTargetUrl(final, { allow });
  if (!chk.ok) throw new ObsError("url_refused", `scene ended on a refused URL after redirects: ${chk.reason}`, { exitCode: 4 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * STEPPED (deterministic) capture: frame i is the page at t = i/fps, loaded with ?t=<sec>&freeze=1.
 * If the page exposes window.__obsSeek(t) (optional fast path) it is used instead of a navigation per frame.
 *
 * @param {{ page: any, url: string, allow?: readonly string[], fps: number, frames: number, onFrame: (png: Buffer, index: number) => Promise<void>, signal?: AbortSignal }} o
 */
export async function captureStepped(o) {
  let fast = false;
  for (let i = 0; i < o.frames; i++) {
    if (o.signal?.aborted) throw new ObsError("aborted", "capture aborted");
    const t = i / o.fps;
    if (fast) {
      await o.page.evaluate(async (/** @type {number} */ tt) => { await window.__obsSeek(tt); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, t);
    } else {
      await gotoStable(o.page, withFrameParams(o.url, t), { allow: o.allow });
      if (i === 0) fast = await o.page.evaluate(() => typeof window.__obsSeek === "function").catch(() => false);
    }
    const png = await o.page.screenshot({ type: "png" });
    await o.onFrame(png, i);
  }
}

/**
 * REAL-TIME capture through Playwright's recordVideo. The page runs on its own clock (no ?freeze). Resolves with the
 * webm path and how long after context creation the page was ready (the recording's blank lead-in, to be trimmed).
 * @param {{ url: string, allow?: readonly string[], viewport: { width: number, height: number }, durationSec: number, workDir: string, env?: Record<string, string | undefined>, signal?: AbortSignal }} o
 */
export async function captureRealtime(o) {
  const t0 = Date.now();
  const scene = await openScene({ url: o.url, allow: o.allow, viewport: o.viewport, env: o.env, recordVideoDir: o.workDir });
  try {
    await gotoStable(scene.page, o.url, { allow: o.allow });
    const leadInSec = (Date.now() - t0) / 1000;
    const video = scene.page.video();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, o.durationSec * 1000);
      o.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new ObsError("aborted", "capture aborted")); }, { once: true });
    });
    await scene.close();
    const webm = await video.path();
    return { webm, leadInSec, blocked: scene.blocked };
  } catch (e) {
    await scene.close();
    throw e;
  }
}

/**
 * LIVE scene feed: JPEG screenshots at ~fps written to `write` (ffmpeg's stdin). Frames are dropped, never queued, when
 * the consumer is slow. A page crash or screenshot failure stops the feed and calls onError; the supervisor sees the
 * frame counter stall and restarts scene + encoder.
 *
 * @param {{ url: string, allow?: readonly string[], fps: number, viewport: { width: number, height: number }, write: (b: Buffer) => boolean, onError: (e: Error) => void, env?: Record<string, string | undefined> }} o
 */
export async function startSceneFeed(o) {
  const scene = await openScene({ url: o.url, allow: o.allow, viewport: o.viewport, env: o.env });
  let stopped = false;
  const stats = { frames: 0, dropped: 0 };
  try {
    scene.page.on("crash", () => o.onError(new ObsError("scene_crashed", "the scene page crashed")));
    await gotoStable(scene.page, o.url, { allow: o.allow });
  } catch (e) {
    await scene.close();
    throw e;
  }
  const interval = 1000 / o.fps;
  const loop = (async () => {
    while (!stopped) {
      const t0 = Date.now();
      try {
        const jpg = await scene.page.screenshot({ type: "jpeg", quality: 82 });
        if (stopped) break;
        if (o.write(jpg)) stats.frames++; else stats.dropped++;
      } catch (e) {
        if (!stopped) o.onError(e instanceof Error ? e : new Error(String(e)));
        break;
      }
      const wait = interval - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return {
    stats,
    blocked: scene.blocked,
    async stop() {
      stopped = true;
      await loop.catch(() => {});
      await scene.close();
    },
  };
}
