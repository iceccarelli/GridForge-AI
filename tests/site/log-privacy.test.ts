/**
 * No log line may carry a bearer link, a credential, a message body, a provider/store response body, or an
 * address. This reads every console.* call in app/ and lib/ as a SYNTAX TREE (so multi-line calls, template
 * literals, spread arguments and nested expressions are all seen) rather than matching text.
 *
 * What is flagged, anywhere inside a console.log/info/warn/error/debug argument list:
 *   - a response body read inline (`await res.text()`, `.json()`, `.arrayBuffer()`),
 *   - an identifier or property whose name denotes a secret/credential/personal datum (token, secret, key,
 *     password, authorization, url, link, email, body, text, html, to, from, subject, address, phone),
 *   - a string/template fragment containing a capability path (/intake/, /watch/, /api-access/, /deliverable/,
 *     /qualify/, /project/) followed by a value.
 * Logging a record id, a notification id, a category or an HTTP status is fine and is how failures are traced.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BANNED_NAME = /(^|[^a-z])(token|secret|apikey|api_key|password|passwd|authorization|bearer|url|link|email|body|text|html|subject|address|phone|recipient|signature)($|[^a-z])|intake_token|tokens?$/i;
const SAFE_NAME = /^(status|statusText|code|category|reason|attempts?|kind|id|count|length)$/i;
const CAPABILITY = /\/(intake|watch|api-access|deliverable|qualify|project)\/(\$\{|[A-Za-z0-9_-]{8,})/;
const BODY_READ = new Set(["text", "json", "arrayBuffer", "blob", "formData"]);

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", ".next"].includes(e.name)) files(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function offenders(source: string, name = "x.ts"): string[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const isConsole = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "console" &&
    ["log", "info", "warn", "error", "debug"].includes(n.expression.name.text);

  const inspect = (arg: ts.Node, call: ts.CallExpression) => {
    const where = `${name}:${sf.getLineAndCharacterOfPosition(call.getStart()).line + 1}`;
    const visit = (n: ts.Node) => {
      // redact() (lib/mail.ts) strips addresses and capability tokens: a sanctioned scrubber
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "redact") return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && BODY_READ.has(n.expression.name.text)) {
        found.push(`${where}: reads a response body inside a log call`);
      }
      if (ts.isIdentifier(n) && BANNED_NAME.test(n.text) && !SAFE_NAME.test(n.text)) {
        // a property name used only as the *label* of an object literal key is data we choose; a value is what leaks
        const p = n.parent;
        const isCallee = ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p;
        if (!isCallee) found.push(`${where}: logs \`${n.text}\``);
      }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && CAPABILITY.test(n.text)) {
        found.push(`${where}: builds a capability path in a log message`);
      }
      ts.forEachChild(n, visit);
    };
    // string literals that are the message text itself are prose, not data: only look INSIDE expressions
    const walkArg = (a: ts.Node) => {
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) { if (CAPABILITY.test(a.text)) found.push(`${where}: builds a capability path in a log message`); return; }
      if (ts.isTemplateExpression(a)) {
        if (CAPABILITY.test(a.head.text) || a.templateSpans.some((s) => CAPABILITY.test(s.literal.text))) found.push(`${where}: builds a capability path in a log message`);
        a.templateSpans.forEach((s) => visit(s.expression));
        return;
      }
      visit(a);
    };
    walkArg(arg);
  };
  const walk = (n: ts.Node) => {
    if (isConsole(n)) n.arguments.forEach((a) => inspect(ts.isSpreadElement(a) ? a.expression : a, n));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

describe("the privacy guard understands logging syntax", () => {
  it("flags the representative leaks from the earlier implementation, multi-line and templated", () => {
    const bad = [
      'console.log(`[GridForge] api account opened for ${p.email || "unknown"} — ${url}`);',
      "console.error(`[GridForge] ${label} email NOT sent: no address — link was`, link);",
      "console.log(`deliverable opened — intake link: ${base}/intake/${intakeToken}`);",
      'console.error("[GridForge] bid not persisted for", row.token);',
      "console.log(`hall watch ${found.watch.token} cancelled`);",
      'console.log("follow-up:", JSON.stringify({ token, email, note }));',
      'console.error("mail refused", res.status, await res.text());',
      'console.error(\n  "multi",\n  "line",\n  customer.email\n);',
      "console.error(...[`x ${apiKey}`]);",
    ];
    for (const src of bad) expect(offenders(src), src).not.toEqual([]);
  });

  it("allows ids, categories and statuses", () => {
    const ok = [
      "console.error(`[GridForge] customer email pending: notification ${mine.id} (${mine.kind}) ${category}; attempt ${mine.attempts}`);",
      'console.error("[GridForge] mail refused by the provider: HTTP " + res.status);',
      'console.log(`[GridForge] deliverable opened (${p.kind}, record ${record.id})`);',
    ];
    for (const src of ok) expect(offenders(src), src).toEqual([]);
  });
});

describe("no console call in app/ or lib/ leaks", () => {
  it("every log line is free of links, credentials, bodies and addresses", () => {
    const all: string[] = [];
    for (const f of [...files(path.join(ROOT, "app")), ...files(path.join(ROOT, "lib"))]) {
      all.push(...offenders(fs.readFileSync(f, "utf8"), path.relative(ROOT, f)));
    }
    expect(all, "log lines that could leak:\n" + all.join("\n")).toEqual([]);
  });
});

describe("one provider integration", () => {
  it("lib/mail.ts is the only place that talks to the mail provider", () => {
    const hits: string[] = [];
    for (const f of [...files(path.join(ROOT, "app")), ...files(path.join(ROOT, "lib"))]) {
      if (fs.readFileSync(f, "utf8").includes("api.resend.com")) hits.push(path.relative(ROOT, f));
    }
    expect(hits).toEqual(["lib/mail.ts"]);
  });
});
