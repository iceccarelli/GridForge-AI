// What a deployed GridForge site must show a visitor, as pure checks over {status, headers, body}. The runner
// (scripts/production-smoke.mjs) fetches the public URLs; these functions only judge what came back, so they are testable
// without a network. A check returns a list of problems (empty = pass).
//
// Why this exists: /observatory shipped to production reading a file the serverless function did not contain, so it answered
// 200 with its own honest "the demonstration data cannot be shown" panel. Every status-code check and every local run passed;
// only reading the deployed page's CONTENT shows it. Add a check here when a page can degrade without changing its status.

const text = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const json = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const FRESHNESS = new Set(["fresh", "stale", "unavailable"]);

/** @type {{ name: string, path: string, judge: (r: {status:number, headers: Record<string,string>, body:string}) => string[] }[]} */
export const CHECKS = [
  {
    name: "the Observatory page shows its halls, not its degraded state",
    path: "/observatory",
    judge: (r) => {
      const p = [];
      if (r.status !== 200) p.push(`status ${r.status}, expected 200`);
      if (/data-observatory="data-unavailable"/.test(r.body) || /demonstration data cannot be shown/i.test(text(r.body))) p.push("the page rendered its 'data cannot be shown' state: its scenario data did not load");
      const t = text(r.body);
      for (const hall of ["Synthetic Hall A", "Synthetic Hall B", "Synthetic Hall C"]) if (!t.includes(hall)) p.push(`${hall} is not on the page`);
      if (/\blive reading\b/i.test(t.replace(/not a live reading/gi, ""))) p.push("the page calls a reading live");
      return p;
    },
  },
  {
    name: "the Observatory scenario file is served and is the synthetic engine output",
    path: "/observatory/scenarios.json",
    judge: (r) => {
      const d = json(r.body);
      if (r.status !== 200 || !d) return [`status ${r.status}, not JSON`];
      const p = [];
      if (d.schema !== "gridforge/observatory-scenarios/1") p.push(`schema ${d.schema}`);
      if (d.synthetic !== true) p.push("not marked synthetic");
      if (!Array.isArray(d.scenarios) || d.scenarios.length < 1) p.push("no scenarios");
      if (typeof d.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.contentSha256)) p.push("no content digest");
      return p;
    },
  },
  {
    name: "the Observatory context API labels what it serves",
    path: "/api/observatory/context",
    judge: (r) => {
      const d = json(r.body);
      if (r.status !== 200 || !d) return [`status ${r.status}, not JSON`];
      const p = [];
      for (const k of ["dayAheadPrice", "generationMix", "queue", "usDemand"]) {
        const v = d[k];
        if (!v || typeof v !== "object") {
          p.push(`${k} missing`);
          continue;
        }
        const prov = v.provenance ?? {};
        if (typeof prov.basis !== "string") p.push(`${k} has no basis`);
        const f = prov.freshness ?? v.freshness;
        if (!FRESHNESS.has(f)) p.push(`${k} freshness ${JSON.stringify(f)}`);
      }
      if (d.dayAheadPrice?.provenance?.basis && d.dayAheadPrice.provenance.basis !== "day_ahead_auction") p.push("the day-ahead price is not labelled as an auction result");
      return p;
    },
  },
  {
    name: "the presenter scene renders, carries no link, and is not indexable",
    path: "/observatory/presenter?t=0&freeze=1",
    judge: (r) => {
      const p = [];
      if (r.status !== 200) p.push(`status ${r.status}, expected 200`);
      if (/data-presenter="unavailable"/.test(r.body)) p.push("the presenter rendered its 'not available' state: its scenario data did not load");
      if (!/data-presenter="frame"/.test(r.body)) p.push("no presenter frame");
      if (/<a[\s>]/i.test(r.body)) p.push("the presenter page contains a link");
      if (!/<meta name="robots" content="[^"]*noindex/i.test(r.body)) p.push("the presenter page is not marked noindex");
      return p;
    },
  },
  {
    name: "robots.txt keeps the presenter out of search",
    path: "/robots.txt",
    judge: (r) => (r.status === 200 && /Disallow:\s*\/observatory\/presenter/.test(r.body) ? [] : [`status ${r.status}; no Disallow for /observatory/presenter`]),
  },
  {
    name: "the home page and the free qualifier answer",
    path: "/qualify",
    judge: (r) => (r.status === 200 && text(r.body).length > 500 ? [] : [`status ${r.status} or an empty page`]),
  },
];

/** Run every check against `fetchOne(path)`; resolves to [{ name, path, problems }]. A thrown fetch is a problem, not a crash. */
export async function runChecks(fetchOne, checks = CHECKS) {
  const out = [];
  for (const c of checks) {
    let problems;
    try {
      problems = c.judge(await fetchOne(c.path));
    } catch (e) {
      problems = [`request failed: ${e instanceof Error ? e.message : String(e)}`];
    }
    out.push({ name: c.name, path: c.path, problems });
  }
  return out;
}
