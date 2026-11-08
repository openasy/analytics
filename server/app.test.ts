import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_KEY, SHOP, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
let n = 0;
/** A fresh visitor and visit, so tests do not count each other's. */
const ids = () => ({ visitor: `visitor-${++n}-aaaa`, session: `session-${n}-aaaa` });
const at = (minutes = 0) => app.clock() + minutes * 60_000;
const view = (path: string, over: object = {}) => ({ type: "pageview", at: at(), url: `${SHOP}${path}`, title: path, ...over });

describe("the script", () => {
  it("is served per site with its settings, and says so for a site not in the file", async () => {
    const res = await fetch(`${app.base}/s/shop.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await res.text();
    expect(text).toContain(
      `OAT.start({"site":"shop","endpoint":"${app.base}/api/v1/collect","consent":"none","forms":true,"vitals":false,"ecommerce":true,"replay":{"sample":10,"script":"${app.base}/s/replay.js","endpoint":"${app.base}/api/v1/replay"},"heatmap":"${app.base}/s/heatmap.js"});`,
    );
    expect(await (await fetch(`${app.base}/s/replay.js`)).text()).toBe("/* replay */");
    expect(await (await fetch(`${app.base}/s/heatmap.js`)).text()).toBe("/* heatmap */");
    expect(await (await fetch(`${app.base}/s/blog.js`)).text()).toContain('"consent":"required"');
    const missing = await fetch(`${app.base}/s/nope.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('no site named "nope"');
  });
});

describe("collecting", () => {
  it("takes a batch from one of the site's domains, and lets that page read the answer", async () => {
    const res = await app.collect({ site: "shop", ...ids(), events: [view("/")] });
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe(SHOP);
    expect(await json(res)).toEqual({ accepted: 1, dropped: 0 });
  });

  it("refuses pages of other origins, unknown sites, and a wrong server key", async () => {
    const other = await app.collect({ site: "shop", ...ids(), events: [view("/")] }, { origin: "https://evil.example" });
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await app.collect({ site: "shop", ...ids(), events: [view("/")] }, { origin: "" })).status).toBe(403);
    expect((await app.collect({ site: "nope", ...ids(), events: [view("/")] })).status).toBe(404);
    expect((await app.collect({ site: "shop", ...ids(), events: [view("/")] }, { origin: "", headers: { "x-analytics-key": "wrong" } })).status).toBe(401);
    expect((await app.collect({ site: "blog", ...ids(), events: [view("/")] }, { origin: "", headers: { "x-analytics-key": SERVER_KEY } })).status).toBe(401);
  });

  it("takes events from the site's servers with its key, from any origin", async () => {
    const res = await app.collect(
      { site: "shop", ...ids(), events: [{ type: "event", url: `${SHOP}/checkout`, name: "paid", props: { total: 120 } }] },
      { origin: "", headers: { "x-analytics-key": SERVER_KEY } },
    );
    expect(await json(res)).toEqual({ accepted: 1, dropped: 0 });
  });

  it("drops crawlers, ignored paths and pages of other sites without a word to the sender", async () => {
    const bot = await app.collect({ site: "shop", ...ids(), events: [view("/")] }, { ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" });
    expect(await json(bot)).toEqual({ accepted: 0, dropped: 1 });
    const mixed = await app.collect({ site: "shop", ...ids(), events: [view("/admin/users"), view("/ok"), { ...view("/"), url: "https://other.example/" }] });
    expect(await json(mixed)).toEqual({ accepted: 1, dropped: 2 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE path LIKE '/admin%'").get()).toEqual({ n: 0 });
  });

  it("refuses what is not a batch, with what to fix", async () => {
    const bad = await app.collect({ site: "shop", ...ids(), events: [{ type: "pageview", url: `${SHOP}/`, value: "hunter2" }] });
    expect(bad.status).toBe(422);
    expect((await json(bad)).detail).toMatch(/value is part of an ecommerce event only/);
    expect((await app.collect("{nope")).status).toBe(400);
    expect((await app.collect({ site: "shop", ...ids(), events: [view("/")], pad: "x".repeat(70_000) })).status).toBe(413);
    const gz = await fetch(`${app.base}/api/v1/collect`, {
      method: "POST",
      body: gzipSync(JSON.stringify({ site: "shop", ...ids(), events: [view("/gz")] })),
      headers: { "content-encoding": "gzip", origin: SHOP, "user-agent": "Mozilla/5.0 Firefox/140.0" },
    });
    expect(gz.status).toBe(202);
  });

  it("keeps a visit to the visitor that started it", async () => {
    const id = ids();
    await app.collect({ site: "shop", ...id, events: [view("/")] });
    const taken = await app.collect({ site: "shop", visitor: "someone-else", session: id.session, events: [view("/x")] });
    expect(await json(taken)).toEqual({ accepted: 0, dropped: 1 });
  });

  it("deletes everything about a visitor that withdraws consent", async () => {
    const id = ids();
    await app.collect({ site: "shop", ...id, events: [view("/"), view("/b")] });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE visitor = ?").get(id.visitor)).toEqual({ n: 2 });
    await app.collect({ site: "shop", ...id, events: [{ type: "forget" }] });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE visitor = ?").get(id.visitor)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE visitor = ?").get(id.visitor)).toEqual({ n: 0 });
  });
});

describe("a visit", () => {
  it("knows where it came from, where it entered and left, and what happened in order", async () => {
    const id = ids();
    await app.collect({
      site: "shop",
      ...id,
      user: "u-42",
      events: [
        view("/landing?utm_source=newsletter&utm_campaign=fall&email=a@b.co&q=boots", { referrer: "https://www.news.example/story" }),
        { type: "click", at: at(0.5), url: `${SHOP}/landing`, target: "a.cta", text: "Buy now", href: `${SHOP}/checkout?coupon=x` },
        { type: "leave", at: at(1), url: `${SHOP}/landing`, duration: 60_000, scroll: 80 },
        view("/checkout/done", { at: at(2), referrer: `${SHOP}/landing` }),
        { type: "event", at: at(2.5), url: `${SHOP}/checkout/done`, name: "signup" },
      ],
    });
    const visit = await json(await app.admin(`/api/v1/visits/${id.session}?site=shop`));
    expect(visit).toMatchObject({
      visitor: id.visitor,
      user: "u-42",
      entry: "/landing",
      exit: "/checkout/done",
      source: "news.example",
      referrer: "https://www.news.example",
      utm: { source: "newsletter", medium: null, campaign: "fall" },
      pageviews: 2,
      events: 2,
      duration: 150,
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
    });
    expect(visit.timeline.map((e: { type: string }) => e.type)).toEqual(["pageview", "click", "leave", "pageview", "event"]);
    expect(visit.timeline[0].query).toBe("?utm_source=newsletter&utm_campaign=fall&q=boots");
    expect(visit.timeline[1]).toMatchObject({ target: "a.cta", text: "Buy now", href: "/checkout" });
    expect(JSON.stringify(visit)).not.toContain("a@b.co");

    const list = await json(await app.admin("/api/v1/visits?site=shop&user=u-42"));
    expect(list.visits.map((v: { id: string }) => v.id)).toEqual([id.session]);
    expect((await app.admin(`/api/v1/visits/${id.session}?site=blog`)).status).toBe(404);
    expect((await app.admin(`/api/v1/visits/${id.session}`)).status).toBe(422);
  });
});

describe("reports", () => {
  it("count visitors, pages, sources, devices, events, clicks and goals", async () => {
    const fresh = await startApp({ version: "0.1.0" });
    const send = (id: { visitor: string; session: string }, events: unknown[], ua?: string) =>
      fresh.collect({ site: "shop", ...id, events }, ua ? { ua } : {}).then((r) => expect(r.status).toBe(202));
    const t = fresh.clock();
    const v = (path: string, minutes: number, referrer?: string) => ({
      type: "pageview",
      at: t + minutes * 60_000,
      url: `${SHOP}${path}`,
      title: path,
      referrer,
    });
    await send({ visitor: "visitor-a-1", session: "session-a-1" }, [
      v("/", 0, "https://www.google.com/"),
      v("/checkout/done", 1),
      { type: "event", at: t + 61_000, url: `${SHOP}/checkout/done`, name: "signup" },
    ]);
    await send({ visitor: "visitor-a-1", session: "session-a-2" }, [v("/", 30)]);
    await send(
      { visitor: "visitor-b-1", session: "session-b-1" },
      [
        v("/pricing", 5),
        { type: "click", at: t + 5 * 60_000, url: `${SHOP}/pricing`, target: "button.buy", text: "Buy" },
        { type: "leave", at: t + 6 * 60_000, url: `${SHOP}/pricing`, duration: 40_000, scroll: 50 },
      ],
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    );
    const r = await json(await fresh.admin("/api/v1/report?site=shop&days=7"));
    // Engaged as GA4 counts it: session-a-1 viewed two pages, session-b-1 lasted a minute; session-a-2 bounced.
    expect(r.totals).toEqual({
      visitors: 2,
      visits: 3,
      pageviews: 4,
      bounceRate: 1 / 3,
      duration: 40,
      engagedVisits: 2,
      engagementRate: 2 / 3,
      newVisitors: 2,
      returningVisitors: 1,
    });
    expect(r.series).toHaveLength(7);
    expect(r.series[6]).toEqual({ day: "2026-10-22", visitors: 2, visits: 3, pageviews: 4 });
    expect(r.pages[0]).toEqual({ path: "/", title: "/", views: 2, visitors: 1, time: null, scroll: null });
    expect(r.pages.find((p: { path: string }) => p.path === "/pricing")).toMatchObject({ time: 40, scroll: 50 });
    expect(r.sources).toEqual([
      { source: null, visits: 2, visitors: 2 },
      { source: "google.com", visits: 1, visitors: 1 },
    ]);
    expect(r.entries[0]).toEqual({ path: "/", visits: 2, visitors: 1 });
    expect(r.devices).toEqual([
      { name: "desktop", visits: 2, visitors: 1 },
      { name: "mobile", visits: 1, visitors: 1 },
    ]);
    expect(r.events).toEqual([{ name: "signup", count: 1, visitors: 1 }]);
    expect(r.clicks).toEqual([{ target: "button.buy", text: "Buy", href: null, count: 1, visitors: 1 }]);
    expect(r.goals).toEqual([
      { name: "Bought", path: "/checkout/done", event: null, download: null, visits: 1, rate: 1 / 3, value: null },
      { name: "Signed up", path: null, event: "signup", download: null, visits: 1, rate: 1 / 3, value: null },
    ]);

    const summary = await json(await fresh.admin("/api/v1/summary"));
    expect(summary).toMatchObject({ sites: 2, visitors24h: 2, visits24h: 3, pageviews24h: 4 });
    const sites = await json(await fresh.admin("/api/v1/sites"));
    expect(sites.sites[0]).toMatchObject({
      name: "shop",
      script: `${fresh.base}/s/shop.js`,
      today: { visitors: 2, pageviews: 4 },
      serverKey: { variable: "SHOP_KEY", set: true },
      rateLimit: 200,
    });

    expect((await fresh.admin("/api/v1/report?site=shop&days=3")).status).toBe(422);
    expect((await fresh.admin("/api/v1/report?site=nope")).status).toBe(404);
    await fresh.close();
  });
});

describe("a visitor's data", () => {
  it("is exported and deleted by an admin, and the daily totals stay", async () => {
    const id = ids();
    await app.collect({ site: "shop", ...id, events: [view("/a"), view("/b")] });
    const exported = await json(await app.admin(`/api/v1/visitors/${id.visitor}?site=shop`));
    expect(exported.visits).toHaveLength(1);
    expect(exported.visits[0].timeline).toHaveLength(2);
    const before = app.db.prepare("SELECT SUM(pageviews) AS n FROM days").get() as { n: number };
    expect((await app.admin(`/api/v1/visitors/${id.visitor}?site=shop`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/visitors/${id.visitor}?site=shop`)).status).toBe(404);
    expect((await app.admin(`/api/v1/visitors/${id.visitor}?site=shop`, { method: "DELETE" })).status).toBe(404);
    expect(app.db.prepare("SELECT SUM(pageviews) AS n FROM days").get()).toEqual(before);
  });
});

describe("limits", () => {
  it("answers 429 with Retry-After once a site has sent its events for the minute", async () => {
    const limited = await startApp({ version: "0.1.0", sites: "sites: [{ name: shop, domains: [https://www.shop.example], rateLimit: 3 }]" });
    const events = (k: number) => Array.from({ length: k }, () => view("/"));
    expect((await limited.collect({ site: "shop", ...ids(), events: events(2) })).status).toBe(202);
    const over = await limited.collect({ site: "shop", ...ids(), events: events(2) });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    limited.clock.advance(60_000);
    expect((await limited.collect({ site: "shop", ...ids(), events: events(3) })).status).toBe(202);
    await limited.close();
  });
});

describe("retention", () => {
  it("deletes events and visits after keep.events, and daily totals after keep.days", async () => {
    const short = await startApp({ version: "0.1.0", sites: "sites: [{ name: shop, domains: [https://www.shop.example], keep: { events: 1, days: 30 } }]" });
    await short.collect({ site: "shop", ...ids(), events: [view("/")] });
    short.clock.advance(2 * 86_400_000);
    short.analytics.purge();
    expect(short.db.prepare("SELECT (SELECT COUNT(*) FROM events) AS e, (SELECT COUNT(*) FROM sessions) AS s, (SELECT COUNT(*) FROM days) AS d").get()).toEqual(
      {
        e: 0,
        s: 0,
        d: 1,
      },
    );
    short.clock.advance(31 * 86_400_000);
    short.analytics.purge();
    expect(short.db.prepare("SELECT COUNT(*) AS n FROM days").get()).toEqual({ n: 0 });
    await short.close();
  });
});

describe("access", () => {
  it("needs a signed-in person for reports, and an admin for a visitor's data", async () => {
    expect((await fetch(`${app.base}/api/v1/report?site=shop`)).status).toBe(401);
    expect((await fetch(`${app.base}/api/v1/visitors/x?site=shop`)).status).toBe(401);
    expect(await json(await fetch(`${app.base}/api/v1/version`))).toEqual({ product: "analytics", version: "0.1.0" });
  });
});
