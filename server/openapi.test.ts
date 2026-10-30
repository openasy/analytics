import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, CHROME, SERVER_KEY, SHOP, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "analytics-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const admin = () => ({ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
const page = (body: unknown, origin = SHOP, headers: Record<string, string> = {}) => ({
  headers: { "content-type": "text/plain", "user-agent": CHROME, ...(origin && { origin }), ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // analytics's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  const visitor = "visitor-contract";
  const session = "session-contract";
  const batch = {
    site: "shop",
    visitor,
    session,
    user: "u-1",
    events: [
      { type: "pageview", url: `${SHOP}/?utm_source=x`, title: "Home", referrer: "https://www.google.com/" },
      { type: "click", url: `${SHOP}/`, target: "a.buy", text: "Buy", href: `${SHOP}/cart` },
      { type: "event", url: `${SHOP}/`, name: "signup", props: { plan: "pro" } },
      { type: "leave", url: `${SHOP}/`, duration: 1000, scroll: 50 },
    ],
  };

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("the script", async () => {
    await call("GET", "/s/{site}.js", {}, "/s/shop.js");
    await call("GET", "/s/{site}.js", {}, "/s/nope.js");
  });

  it("collect: taken, refused and limited", async () => {
    await call("POST", "/api/v1/collect", page(batch));
    await call("POST", "/api/v1/collect", page({ ...batch, events: [batch.events[2]] }, "", { "x-analytics-key": SERVER_KEY }));
    await call("POST", "/api/v1/collect", page({ ...batch, events: [batch.events[0]] }, "", { "x-analytics-key": "wrong" }));
    await call("POST", "/api/v1/collect", page(batch, "https://evil.example"));
    await call("POST", "/api/v1/collect", page({ ...batch, site: "nope" }));
    await call("POST", "/api/v1/collect", page("{nope"));
    await call("POST", "/api/v1/collect", page({ ...batch, events: [{ type: "pageview" }] }));
    await call("POST", "/api/v1/collect", page({ ...batch, pad: "x".repeat(70_000) }));
    // shop takes 200 events a minute, and 6 are counted so far (refused batches are not); this fills the rest of it.
    for (const [i, size] of [50, 50, 50, 44].entries()) {
      const events = Array.from({ length: size }, () => batch.events[0]);
      const res = await fetch(`${base}/api/v1/collect`, { method: "POST", ...page({ ...batch, session: `session-fill-${i}`, events }) });
      expect(res.status).toBe(202);
    }
    const limited = await call("POST", "/api/v1/collect", page(batch));
    expect(limited.res.status).toBe(429);
    app.clock.advance(60_000);
  });

  it("sites, reports and visits", async () => {
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    await call("GET", "/api/v1/sites", admin());
    await call("GET", "/api/v1/sites", {});
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?site=shop&days=30");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?site=shop&days=2");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?site=nope");
    await call("GET", "/api/v1/report", {}, "/api/v1/report?site=shop");
    await call("GET", "/api/v1/visits", admin(), `/api/v1/visits?site=shop&visitor=${visitor}&limit=1`);
    await call("GET", "/api/v1/visits", admin(), "/api/v1/visits?site=shop&limit=0");
    await call("GET", "/api/v1/visits", admin(), "/api/v1/visits?site=nope");
    await call("GET", "/api/v1/visits", {}, "/api/v1/visits?site=shop");
    await call("GET", "/api/v1/visits/{id}", admin(), `/api/v1/visits/${session}?site=shop`);
    await call("GET", "/api/v1/visits/{id}", admin(), "/api/v1/visits/missing?site=shop");
    await call("GET", "/api/v1/visits/{id}", admin(), `/api/v1/visits/${session}`);
    await call("GET", "/api/v1/visits/{id}", {}, `/api/v1/visits/${session}?site=shop`);
  });

  it("a visitor's data", async () => {
    await call("GET", "/api/v1/visitors/{id}", admin(), `/api/v1/visitors/${visitor}?site=shop`);
    await call("GET", "/api/v1/visitors/{id}", admin(), "/api/v1/visitors/missing?site=shop");
    await call("GET", "/api/v1/visitors/{id}", admin(), `/api/v1/visitors/${visitor}`);
    await call("GET", "/api/v1/visitors/{id}", {}, `/api/v1/visitors/${visitor}?site=shop`);
    await call("DELETE", "/api/v1/visitors/{id}", admin(), `/api/v1/visitors/${visitor}?site=shop`);
    await call("DELETE", "/api/v1/visitors/{id}", admin(), `/api/v1/visitors/${visitor}?site=shop`);
    await call("DELETE", "/api/v1/visitors/{id}", admin(), `/api/v1/visitors/${visitor}`);
    await call("DELETE", "/api/v1/visitors/{id}", {}, `/api/v1/visitors/${visitor}?site=shop`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
