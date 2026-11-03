import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The homepage's source: app/page.tsx and everything in components/home. It used to be one file, components/HomeClient.tsx. */
export function homeSource(): string {
  const root = path.resolve(__dirname, "../..");
  const dir = path.join(root, "components", "home");
  const files = [path.join(root, "app", "page.tsx"), ...readdirSync(dir).filter((f) => f.endsWith(".tsx")).sort().map((f) => path.join(dir, f))];
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}
