// Server-only: describe a failed store/provider call for a log WITHOUT its body.
//
// PostgREST error bodies carry `details` such as `Key (email)=(a@b.c) already exists`, and provider bodies can
// echo a request. A log line gets the HTTP status and the machine error code (e.g. 23505), nothing else.

export async function storeFault(res: Response): Promise<string> {
  let code = "";
  try {
    const j = (await res.clone().json()) as { code?: unknown; name?: unknown };
    const c = typeof j.code === "string" ? j.code : typeof j.name === "string" ? j.name : "";
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(c)) code = c;
  } catch {
    /* not JSON: status alone */
  }
  return `HTTP ${res.status}${code ? ` ${code}` : ""}`;
}
