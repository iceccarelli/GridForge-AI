// The presenter page's URL contract, shared by the page and the broadcast tool's scene URL:
//   ?t=<seconds>   where the journey starts (default 0; clamped to the journey by frameAt)
//   &freeze=1      render exactly that frame and stop: a pure function of t, used for frame-exact capture
//   &captions=0    leave the on-screen caption bar off (the WebVTT track is separate)
// Anything else is ignored. Unparseable or negative t is 0.

export interface PresenterParams {
  t: number;
  freeze: boolean;
  captions: boolean;
}

type Raw = string | string[] | undefined;

const first = (v: Raw): string | undefined => (Array.isArray(v) ? v[0] : v);

export function parsePresenterParams(sp: Record<string, Raw> | URLSearchParams | undefined): PresenterParams {
  const get = (k: string): string | undefined => (sp instanceof URLSearchParams ? (sp.get(k) ?? undefined) : first(sp?.[k]));
  const raw = get("t");
  const n = raw !== undefined && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : 0;
  return {
    t: Number.isFinite(n) && n >= 0 ? n : 0,
    freeze: get("freeze") === "1",
    captions: get("captions") !== "0",
  };
}
