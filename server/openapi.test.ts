import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, CHROME, SERVER_KEY, SHOP, readMail, startApp } from "./test-app.ts";

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
      { type: "click", url: `${SHOP}/`, target: "a.buy", text: "Buy", x: 400, y: 600 },
      { type: "form", url: `${SHOP}/`, form: "form#signup", action: "start", field: "email", kind: "email" },
      { type: "form", url: `${SHOP}/`, form: "form#signup", action: "leave", field: "email", kind: "email", duration: 900, filled: true, again: false },
      { type: "form", url: `${SHOP}/`, form: "form#signup", action: "submit" },
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
    // shop takes 200 events a minute, and 10 are counted so far (a batch refused before its events are read is not); this fills the rest of it.
    for (const [i, size] of [50, 50, 50, 40].entries()) {
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
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/settings", {});
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

  it("funnels, forms, heatmaps and replays", async () => {
    for (const [path, ok] of [
      ["/api/v1/funnels", "/api/v1/funnels?site=shop&days=7"],
      ["/api/v1/forms", "/api/v1/forms?site=shop&days=7"],
      ["/api/v1/heatmap", "/api/v1/heatmap?site=shop&path=/&days=7&device=desktop"],
      ["/api/v1/replays", "/api/v1/replays?site=shop&days=7&limit=1"],
    ] as const) {
      await call("GET", path, admin(), ok);
      await call("GET", path, admin(), `${path}?site=nope`);
      await call("GET", path, admin(), `${path}?site=shop&days=2`);
      await call("GET", path, {}, ok);
    }
    const chunk = (q: string, body: Uint8Array | string = gzipSync(JSON.stringify([{ type: 4, timestamp: Date.now(), data: {} }])), origin = SHOP) => ({
      method: "POST",
      body,
      headers: { "content-type": "text/plain", origin, "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36" },
      q,
    });
    const send = (c: ReturnType<typeof chunk>) => call("POST", "/api/v1/replay", c, `/api/v1/replay?${c.q}`);
    await send(chunk(`site=shop&visitor=${visitor}&session=${session}&seq=0`));
    await send(
      chunk(
        `site=shop&visitor=${visitor}&session=${session}&seq=1`,
        gzipSync(JSON.stringify([{ type: 4, timestamp: Date.now(), data: {} }])),
        "https://evil.example",
      ),
    );
    await send(chunk(`site=nope&visitor=${visitor}&session=${session}&seq=1`));
    await send(chunk(`site=shop&visitor=${visitor}&session=${session}&seq=x`));
    await send(chunk(`site=shop&visitor=${visitor}&session=${session}&seq=1`, "not gzip"));
    await send(chunk(`site=shop&visitor=${visitor}&session=${session}&seq=1`, new Uint8Array(2 * 1024 * 1024 + 10)));
    await call(
      "POST",
      "/api/v1/replay",
      { method: "POST", body: "x", headers: { "content-encoding": "br", origin: SHOP } },
      `/api/v1/replay?site=shop&visitor=${visitor}&session=${session}&seq=1`,
    );
    await call("GET", "/api/v1/replays/{id}", admin(), `/api/v1/replays/${session}?site=shop`);
    await call("GET", "/api/v1/replays/{id}", admin(), "/api/v1/replays/missing?site=shop");
    await call("GET", "/api/v1/replays/{id}", admin(), `/api/v1/replays/${session}`);
    await call("GET", "/api/v1/replays/{id}", {}, `/api/v1/replays/${session}?site=shop`);
  });

  it("breakdowns, now, vitals, frustration and annotations", async () => {
    const vitals = { type: "leave", url: `${SHOP}/`, duration: 1000, scroll: 50, lcp: 1500, inp: 80, cls: 0.02, notFound: true };
    await call(
      "POST",
      "/api/v1/collect",
      page({ ...batch, events: [{ type: "pageview", url: `${SHOP}/?q=x`, language: "en-US", timezone: "UTC", screen: "1280x800" }, vitals] }),
    );
    for (const [path, ok] of [
      ["/api/v1/breakdown", "/api/v1/breakdown?site=shop&dimension=country&days=7&compare=previous&filter=device:is:desktop"],
      ["/api/v1/vitals", "/api/v1/vitals?site=shop&days=7&compare=year"],
      ["/api/v1/frustration", "/api/v1/frustration?site=shop&days=7&compare=previous"],
      ["/api/v1/realtime", "/api/v1/realtime?site=shop&filter=page:is:/"],
      ["/api/v1/annotations", "/api/v1/annotations?site=shop&days=7"],
    ] as const) {
      await call("GET", path, admin(), ok);
      await call("GET", path, admin(), `${path}?site=nope&dimension=page`);
      await call("GET", path, admin(), `${path}?site=shop&dimension=page&filter=nope`);
      await call("GET", path, {}, ok);
    }
    await call("GET", "/api/v1/breakdown", admin(), "/api/v1/breakdown?site=shop&dimension=page");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?site=shop&days=7&compare=previous&filter=country:is:(none)");
    await call("GET", "/api/v1/funnels", admin(), "/api/v1/funnels?site=shop&days=7&compare=year");
    await call("GET", "/api/v1/heatmap", admin(), "/api/v1/heatmap?site=shop&path=/&compare=previous");
    const json = (body: unknown) => ({ ...admin(), headers: { ...admin().headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await call("POST", "/api/v1/annotations", json({ date: "2026-10-20", text: "Launch" }), "/api/v1/annotations?site=shop");
    await call("POST", "/api/v1/annotations", json({ date: "yesterday", text: "Launch" }), "/api/v1/annotations?site=shop");
    await call("POST", "/api/v1/annotations", { ...json({}), body: "{nope" }, "/api/v1/annotations?site=shop");
    await call("POST", "/api/v1/annotations", json({ date: "2026-10-20", text: "x" }), "/api/v1/annotations?site=nope");
    await call("POST", "/api/v1/annotations", { body: "{}" }, "/api/v1/annotations?site=shop");
    const id = (created.body as { id: number }).id;
    await call("GET", "/api/v1/annotations", admin(), "/api/v1/annotations?site=shop");
    await call("DELETE", "/api/v1/annotations/{id}", admin(), `/api/v1/annotations/${id}?site=shop`);
    await call("DELETE", "/api/v1/annotations/{id}", admin(), `/api/v1/annotations/${id}?site=shop`);
    await call("DELETE", "/api/v1/annotations/{id}", admin(), `/api/v1/annotations/${id}`);
    await call("DELETE", "/api/v1/annotations/{id}", {}, `/api/v1/annotations/${id}?site=shop`);
    const visit = await call("GET", "/api/v1/visits/{id}", admin(), `/api/v1/visits/${session}?site=shop`);
    expect((visit.body as { timeline: Array<{ lcp: number | null }> }).timeline.some((e) => e.lcp === 1500)).toBe(true);
  });

  it("ecommerce, attribution, paths, retention, site search and search engines", async () => {
    const shop = [
      { type: "pageview", url: `${SHOP}/products/beans`, title: "Beans" },
      { type: "event", url: `${SHOP}/products/beans`, name: "view_item", items: [{ sku: "B-1", name: "Beans", price: 100 }] },
      { type: "event", url: `${SHOP}/cart`, name: "add_to_cart", items: [{ sku: "B-1", price: 100, quantity: 2 }] },
      { type: "event", url: `${SHOP}/checkout`, name: "purchase", order: "o-1", currency: "TRY", items: [{ sku: "B-1", price: 100, quantity: 2 }] },
      { type: "pageview", url: `${SHOP}/search?q=beans`, noResults: true },
    ];
    await call("POST", "/api/v1/collect", page({ ...batch, events: shop }));
    await call(
      "POST",
      "/api/v1/collect",
      page({ ...batch, events: [{ type: "event", url: `${SHOP}/`, name: "purchase", items: [{ sku: "x", bad: 1 }], order: "o-2" }] }),
    );
    for (const [path, ok] of [
      ["/api/v1/ecommerce", "/api/v1/ecommerce?site=shop&days=7&compare=previous"],
      ["/api/v1/attribution", "/api/v1/attribution?site=shop&days=7&goal=Signed%20up&by=source"],
      ["/api/v1/paths", "/api/v1/paths?site=shop&days=7&page=/products/*&steps=2"],
      ["/api/v1/retention", "/api/v1/retention?site=shop&weeks=4&days=30"],
      ["/api/v1/sitesearch", "/api/v1/sitesearch?site=shop&days=7"],
      ["/api/v1/search-console", "/api/v1/search-console?site=shop&days=30&engine=google&compare=previous"],
    ] as const) {
      await call("GET", path, admin(), ok);
      await call("GET", path, admin(), `${path}?site=nope&goal=x&page=/`);
      await call("GET", path, {}, ok);
    }
    await call("GET", "/api/v1/attribution", admin(), "/api/v1/attribution?site=shop&goal=Nope");
    await call("GET", "/api/v1/paths", admin(), "/api/v1/paths?site=shop&page=nope");
    await call("GET", "/api/v1/retention", admin(), "/api/v1/retention?site=shop&weeks=99");
  });

  it("segments, email reports, shared links and alerts", async () => {
    const json = (body: unknown, method = "POST") => ({
      method,
      ...admin(),
      headers: { ...admin().headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const seg = await call("POST", "/api/v1/segments", json({ name: "Germany", filters: ["country:is:DE"], shared: true }));
    await call("POST", "/api/v1/segments", json({ name: "", filters: [] }));
    await call("POST", "/api/v1/segments", { body: "{}" });
    await call("GET", "/api/v1/segments", admin());
    await call("GET", "/api/v1/segments", {});
    const segId = (seg.body as { id: string }).id;

    const report = await call(
      "POST",
      "/api/v1/email-reports",
      json({ site: "shop", name: "Weekly", recipients: ["a@example.test"], every: "weekly", sections: ["overview", "ecommerce"], segment: segId }),
    );
    await call("POST", "/api/v1/email-reports", json({ site: "shop", name: "x", recipients: ["not an email"], every: "weekly", sections: ["overview"] }));
    await call("POST", "/api/v1/email-reports", json({ site: "nope", name: "x", recipients: ["a@example.test"], every: "weekly", sections: ["overview"] }));
    await call("POST", "/api/v1/email-reports", { body: "{}" });
    await call("GET", "/api/v1/email-reports", admin(), "/api/v1/email-reports?site=shop");
    await call("GET", "/api/v1/email-reports", {});
    const rid = (report.body as { id: string }).id;
    await call("POST", "/api/v1/email-reports/{id}/send", admin(), `/api/v1/email-reports/${rid}/send`);
    await call("POST", "/api/v1/email-reports/{id}/send", admin(), "/api/v1/email-reports/missing/send");
    await call("POST", "/api/v1/email-reports/{id}/send", {}, `/api/v1/email-reports/${rid}/send`);
    const mail = app.sink.messages.at(-1)!.data;
    const stop = /token=([A-Za-z0-9_.-]+)/.exec(readMail(mail))![1]!;
    await call("GET", "/api/v1/unsubscribe", {}, `/api/v1/unsubscribe?token=${stop}`);
    await call("GET", "/api/v1/unsubscribe", {}, "/api/v1/unsubscribe?token=nope");
    await call("DELETE", "/api/v1/email-reports/{id}", admin(), `/api/v1/email-reports/${rid}`);
    await call("DELETE", "/api/v1/email-reports/{id}", {}, `/api/v1/email-reports/${rid}`);

    const share = await call(
      "POST",
      "/api/v1/shares",
      json({ site: "shop", name: "Board", sections: ["overview", "search"], password: "a long password", expiresDays: 30 }),
    );
    await call("POST", "/api/v1/shares", json({ site: "shop", name: "Board", sections: ["visits"] }));
    await call("POST", "/api/v1/shares", json({ site: "nope", name: "Board", sections: ["overview"] }));
    await call("POST", "/api/v1/shares", { body: "{}" });
    await call("GET", "/api/v1/shares", admin());
    await call("GET", "/api/v1/shares", {});
    const token = (share.body as { url: string }).url.split("/").pop()!;
    await call("GET", "/api/v1/shared/{token}", {}, `/api/v1/shared/${token}`);
    await call("GET", "/api/v1/shared/{token}", {}, "/api/v1/shared/nope-nope-nope-nope-nope");
    await call("GET", "/api/v1/shared/{token}/report", {}, `/api/v1/shared/${token}/report?section=overview`);
    await call(
      "POST",
      "/api/v1/shared/{token}/unlock",
      { headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong password" }) },
      `/api/v1/shared/${token}/unlock`,
    );
    await call("POST", "/api/v1/shared/{token}/unlock", { body: "{nope" }, `/api/v1/shared/${token}/unlock`);
    await call("POST", "/api/v1/shared/{token}/unlock", { body: "[]" }, `/api/v1/shared/${token}/unlock`);
    await call("POST", "/api/v1/shared/{token}/unlock", { body: "{}" }, "/api/v1/shared/nope-nope-nope-nope-nope/unlock");
    const unlocked = await call(
      "POST",
      "/api/v1/shared/{token}/unlock",
      { body: JSON.stringify({ password: "a long password" }) },
      `/api/v1/shared/${token}/unlock`,
    );
    const access = { headers: { "x-share-access": (unlocked.body as { access: string }).access } };
    await call("GET", "/api/v1/shared/{token}/report", access, `/api/v1/shared/${token}/report?section=overview&days=7&compare=previous&filter=country:is:DE`);
    await call("GET", "/api/v1/shared/{token}/report", access, `/api/v1/shared/${token}/report?section=search`);
    await call("GET", "/api/v1/shared/{token}/report", access, `/api/v1/shared/${token}/report?section=performance`);
    await call("GET", "/api/v1/shared/{token}/report", access, `/api/v1/shared/${token}/report?section=overview&filter=city:is:Berlin`);
    await call("GET", "/api/v1/shared/{token}/report", access, "/api/v1/shared/nope-nope-nope-nope-nope/report");
    for (let i = 0; i < 6; i++) await fetch(`${base}/api/v1/shared/${token}/unlock`, { method: "POST", body: JSON.stringify({ password: "wrong password" }) });
    await call("POST", "/api/v1/shared/{token}/unlock", { body: JSON.stringify({ password: "a long password" }) }, `/api/v1/shared/${token}/unlock`);
    const sid = (share.body as { id: string }).id;
    await call("DELETE", "/api/v1/shares/{id}", admin(), `/api/v1/shares/${sid}`);
    await call("DELETE", "/api/v1/shares/{id}", admin(), `/api/v1/shares/${sid}`);
    await call("DELETE", "/api/v1/shares/{id}", {}, `/api/v1/shares/${sid}`);

    const rule = await call("POST", "/api/v1/alerts", json({ site: "shop", name: "Drop", kind: "drop", ratio: 0.5, recipients: ["a@example.test"] }));
    await call("POST", "/api/v1/alerts", json({ site: "shop", name: "Drop", kind: "drop", ratio: 3 }));
    await call("POST", "/api/v1/alerts", json({ site: "nope", name: "Drop", kind: "drop", recipients: ["a@example.test"] }));
    await call("POST", "/api/v1/alerts", { body: "{}" });
    await call("GET", "/api/v1/alerts", admin(), "/api/v1/alerts?site=shop");
    await call("GET", "/api/v1/alerts", {});
    const aid = (rule.body as { id: string }).id;
    await call("PATCH", "/api/v1/alerts/{id}", json({ enabled: false }, "PATCH"), `/api/v1/alerts/${aid}`);
    await call("PATCH", "/api/v1/alerts/{id}", json({ enabled: "no" }, "PATCH"), `/api/v1/alerts/${aid}`);
    await call("PATCH", "/api/v1/alerts/{id}", json({ enabled: true }, "PATCH"), "/api/v1/alerts/missing");
    await call("PATCH", "/api/v1/alerts/{id}", { body: "{}" }, `/api/v1/alerts/${aid}`);
    await call("DELETE", "/api/v1/alerts/{id}", admin(), `/api/v1/alerts/${aid}`);
    await call("DELETE", "/api/v1/alerts/{id}", admin(), `/api/v1/alerts/${aid}`);
    await call("DELETE", "/api/v1/alerts/{id}", {}, `/api/v1/alerts/${aid}`);

    await call("DELETE", "/api/v1/segments/{id}", admin(), `/api/v1/segments/${segId}`);
    await call("DELETE", "/api/v1/segments/{id}", admin(), `/api/v1/segments/${segId}`);
    await call("DELETE", "/api/v1/segments/{id}", {}, `/api/v1/segments/${segId}`);
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
