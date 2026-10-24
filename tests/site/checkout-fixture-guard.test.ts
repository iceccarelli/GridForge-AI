/**
 * A checkout.session.completed fixture that does not say whether it was PAID must never be written again.
 *
 * Until the webhook failed closed, `checkoutIsPaid` read a session with no `payment_status` as paid, so 23 test files built
 * fabricated sessions without the field and every one passed: fixtures proving the fulfilment of sales nobody paid for. Stripe
 * always sends the field. This test reads every test source with the TypeScript parser and fails when it finds a Checkout
 * Session fixture that omits it:
 *
 *   1. an event literal (`type: "checkout.session.completed"` or `...async_payment_succeeded`, with a `data`), or a call whose first
 *      argument is that string (`send("checkout.session.completed", ...)`), must state `payment_status`, call a builder from
 *      ./checkout-fixture, or use a builder declared in the same file that does (followed up to four levels);
 *   2. an object literal with `object: "checkout_session"` / `"checkout.session"` must have `payment_status` or be an argument of
 *      a ./checkout-fixture builder.
 *
 * It is a source scan, not a proof that no fixture can be wrong: it reads names, it does not run the tests. The behaviour itself
 * (a missing field is refused, an unknown one is not fulfilled) is asserted in tests/site/checkout-payment-status.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TRIGGER = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const SESSION_OBJECT = new Set(["checkout_session", "checkout.session"]);
const BUILDERS = ["paidSession", "unpaidSession", "noPaymentRequiredSession", "checkoutSession", "checkoutEvent", "omitPaymentStatus"];
const STATES_IT = new RegExp(`\\bpayment_status\\b|\\b(?:${BUILDERS.join("|")})\\b`);
/** Calls whose first string argument is an assertion or a title, never a fixture. */
const NOT_FIXTURE_CALLS = new Set(["expect", "describe", "it", "test", "toContain", "toBe", "toEqual", "toMatch", "arrayContaining"]);

type Offender = { file: string; line: number; why: string };

const scriptKind = (file: string) => (/\.(mjs|js|cjs)$/.test(file) ? ts.ScriptKind.JS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

export function findOffenders(file: string, source: string): Offender[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const text = (n: ts.Node) => n.getText(sf);

  // Declarations in this file, by name, so a builder (`const buy = ...`, `function completed(...)`) is judged by its body.
  const declared = new Map<string, string[]>();
  const remember = (name: string, node: ts.Node) => declared.set(name, [...(declared.get(name) ?? []), text(node)]);
  (function collect(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) remember(n.name.text, n.initializer);
    if (ts.isFunctionDeclaration(n) && n.name && n.body) remember(n.name.text, n.body);
    ts.forEachChild(n, collect);
  })(sf);

  const states = (body: string, depth = 4, seen = new Set<string>()): boolean => {
    if (STATES_IT.test(body)) return true;
    if (depth === 0) return false;
    for (const id of new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (seen.has(id) || !declared.has(id)) continue;
      seen.add(id);
      if (declared.get(id)!.some((d) => states(d, depth - 1, seen))) return true;
    }
    return false;
  };

  const out: Offender[] = [];
  const isFixtureCallee = (call: ts.CallExpression) => ts.isIdentifier(call.expression) && !NOT_FIXTURE_CALLS.has(call.expression.text);
  const propName = (p: ts.ObjectLiteralElementLike) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "");

  (function visit(n: ts.Node) {
    // 1a. { type: "checkout.session.completed", ... }
    if (ts.isObjectLiteralExpression(n)) {
      const typeProp = n.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === "type") as ts.PropertyAssignment | undefined;
      // An event carries its session in `data`; a bare `{ type: "..." }` is the options argument of a builder, not a fixture.
      const isEvent = n.properties.some((p) => propName(p) === "data");
      if (typeProp && isEvent && ts.isStringLiteralLike(typeProp.initializer) && TRIGGER.has(typeProp.initializer.text) && !states(text(n))) {
        out.push({ file, line: at(n), why: `an event of type ${typeProp.initializer.text} whose session states no payment_status` });
      }
      // 2. { object: "checkout_session", ... }
      const objectProp = n.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === "object") as ts.PropertyAssignment | undefined;
      if (objectProp && ts.isStringLiteralLike(objectProp.initializer) && SESSION_OBJECT.has(objectProp.initializer.text)) {
        const hasStatus = n.properties.some((p) => propName(p) === "payment_status");
        const p = n.parent;
        const underBuilder = ts.isCallExpression(p) && ts.isIdentifier(p.expression) && BUILDERS.includes(p.expression.text);
        if (!hasStatus && !underBuilder) out.push({ file, line: at(n), why: `a checkout session literal with no payment_status and not built by ./checkout-fixture` });
      }
    }
    // 1b. send("checkout.session.completed", <session>)
    if (ts.isCallExpression(n) && isFixtureCallee(n)) {
      const first = n.arguments[0];
      if (first && ts.isStringLiteralLike(first) && TRIGGER.has(first.text) && !states(text(n))) {
        out.push({ file, line: at(n), why: `${text(n.expression)}("${first.text}", ...) with a session that states no payment_status` });
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
  return out;
}

function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testSources(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("every checkout.session.completed fixture says whether it was paid", () => {
  it("finds none in tests/", () => {
    const root = path.resolve(__dirname, "..");
    const self = new Set([path.join(root, "site", "checkout-fixture.ts"), path.join(root, "site", "checkout-fixture-guard.test.ts")]);
    const files = testSources(root).filter((f) => !self.has(f));
    expect(files.length).toBeGreaterThan(50); // the scan really read the suite
    const offenders = files.flatMap((f) => findOffenders(path.relative(path.resolve(root, ".."), f), fs.readFileSync(f, "utf8")));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.why}`)).toEqual([]);
  });

  it("actually reads the fixtures it is meant to guard (a scan that matches nothing proves nothing)", () => {
    const root = path.resolve(__dirname, "..");
    const webhook = fs.readFileSync(path.join(root, "site", "webhook.test.ts"), "utf8");
    expect(webhook).toContain("checkout.session.completed");
    expect(findOffenders("webhook.test.ts", webhook)).toEqual([]);
    expect(findOffenders("webhook.test.ts", webhook.replaceAll("paidSession(", "Object.assign("))).not.toEqual([]);
  });
});

describe("the scan itself", () => {
  const flagged = (src: string) => findOffenders("x.test.ts", src).length;

  it("flags an event literal whose session has no payment_status", () => {
    expect(flagged(`const e = { id: "e", type: "checkout.session.completed", data: { object: { id: "cs_1", customer_email: "a@b.c" } } };`)).toBe(1);
  });

  it("flags the object: checkout_session shape without the field, however it is wrapped", () => {
    expect(flagged(`const s = JSON.stringify({ data: { object: { id: "cs_1", object: "checkout_session" } } });`)).toBe(1);
  });

  it("flags a helper call that names the event and passes a bare session", () => {
    expect(flagged(`send("checkout.session.completed", { id: "cs_1", object: "checkout_session", metadata: {} });`)).toBeGreaterThan(0);
    expect(flagged(`send("checkout.session.async_payment_succeeded", { id: "cs_1" });`)).toBe(1);
  });

  it("flags a same-file builder that forgets it, and passes one that does not", () => {
    expect(flagged(`const make = (id) => ({ id });\nsend("checkout.session.completed", make("cs_1"));`)).toBe(1);
    expect(flagged(`const make = (id) => paidSession({ id });\nsend("checkout.session.completed", make("cs_1"));`)).toBe(0);
    expect(flagged(`function build(id) { return { id, payment_status: "paid" }; }\nsend("checkout.session.completed", build("cs_1"));`)).toBe(0);
  });

  it("passes a session built by the central helper, or one that states the field", () => {
    expect(flagged(`const e = { type: "checkout.session.completed", data: { object: paidSession({ id: "cs_1" }) } };`)).toBe(0);
    expect(flagged(`const e = { type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "unpaid" } } };`)).toBe(0);
    expect(flagged(`const s = noPaymentRequiredSession({ id: "cs_1", object: "checkout.session", mode: "setup" });`)).toBe(0);
  });

  it("does not mistake an assertion or a webhook endpoint's event list for a fixture", () => {
    expect(flagged(`expect(events).toContain("checkout.session.completed");`)).toBe(0);
    expect(flagged(`const endpoint = { enabled_events: ["checkout.session.completed", "invoice.paid"] };`)).toBe(0);
    expect(flagged(`describe("checkout.session.completed", () => {});`)).toBe(0);
  });
});
