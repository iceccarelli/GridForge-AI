import { promises as fs } from "node:fs";
import path from "node:path";
import { buildOpenApi, type ToolsFile } from "@/lib/openapi";

export const dynamic = "force-static";

/** GET /openapi.json: the engine's public interface as OpenAPI 3.1, generated from public/reference/tools.json. */
export async function GET() {
  const raw = await fs.readFile(path.join(process.cwd(), "public", "reference", "tools.json"), "utf8");
  const doc = buildOpenApi(JSON.parse(raw) as ToolsFile, process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev");
  return new Response(JSON.stringify(doc, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
