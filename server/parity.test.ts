// What a visit says about where it came from and what it ran on, and the reports that read it: filters, comparisons,
// breakdowns, who is on the site now, annotations, Core Web Vitals, and rage and dead clicks.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGeo } from "./geo.ts";
import { startApp } from "./test-app.ts";
import { city, writeMmdb } from "./test-mmdb.ts";

const SHOP = "https://www.shop.example";
const SITES = `
trustedProxies: [10.0.0.0/8]
sites:
  - name: shop
    domains: [${SHOP}]
    search: [q, s]
    notFound: { title: Page not found }
    channels:
      referral: [news.ycombinator.com]
    downloads: [pdf, zip]
    goals:
      - { name: Bought, path: /checkout/done }
  - name: coarse
    domains: [https://coarse.example]
    location: country
  - name: nowhere
    domains: [https://nowhere.example]
    location: off
`;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const VIEWER = "oa_viewer-token-for-tests";

const mmdb = join(mkdtempSync(join(tmpdir(), "analytics-geo-")), "city.mmdb");
writeFileSync(
  mmdb,
  writeMmdb([
    ["203.0.113.0/24", city("DE", "Bavaria", "Munich")],
    ["198.51.100.0/24", city("TR", "Istanbul", "Istanbul")],
  ]),
);

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  // Test requests come from this machine, which is the trusted proxy here.
  app = await startApp({
    version: "0.1.0",
    sites: SITES,
    trustedProxies: ["127.0.0.1", "::1"],
    analyticsOptions: { geo: createGeo({ file: mmdb, update: false }) },
  });
  app.db
    .prepare("INSERT INTO auth_tokens (id, secret_hash, name, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("t-viewer", createHash("sha256").update(VIEWER).digest("base64url"), "dashboards", "viewer", new Date().toISOString(), "2099-01-01T00:00:00.000Z");
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
let n = 0;
const ids = () => ({ visitor: `visitor-${++n}-parity`, session: `session-${n}-parity` });
const at = (seconds = 0) => app.clock() + seconds * 1000;
const send = (id: { visitor: string; session: string }, events: unknown[], { ip = "203.0.113.9", ua = undefined as string | undefined, site = "shop" } = {}) =>
  app.collect({ site, ...id, events }, { origin: site === "shop" ? SHOP : `https://${site}.example`, headers: { "x-forwarded-for": ip }, ...(ua && { ua }) });
const view = (path: string, s = 0, more: object = {}) => ({ type: "pageview", at: at(s), url: `${SHOP}${path}`, title: path, ...more });
const session = (id: string) => app.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, any>;
const report = async (q: string) => json(await app.admin(`/api/v1/report?site=shop&${q}`));

describe("what a visit records", () => {
  it("keeps the browser's language, time zone, screen and versions, the place, and never the address or user agent", async () => {
    const id = ids();
    const res = await send(
      id,
      [view("/", 0, { language: "de-de", timezone: "Europe/Berlin", screen: "390x844", referrer: "https://news.ycombinator.com/item?id=1" })],
      {
        ua: IPHONE,
      },
    );
    expect(res.status).toBe(202);
    expect(session(id.session)).toMatchObject({
      language: "de-DE",
      timezone: "Europe/Berlin",
      screen: "390x844",
      browser: "Safari",
      browser_version: "18",
      os: "iOS",
      os_version: "18.1",
      country: "DE",
      region: "Bavaria",
      city: "Munich",
      // The file moved Hacker News from social to referral.
      channel: "referral",
      is_returning: 0,
    });
    const everything = JSON.stringify(app.db.prepare("SELECT * FROM sessions").all()) + JSON.stringify(app.db.prepare("SELECT * FROM events").all());
    expect(everything).not.toContain("203.0.113.9");
    expect(everything).not.toContain("AppleWebKit");
  });

  it("works out the place to the site's precision, and from X-Forwarded-For only behind a trusted proxy", async () => {
    const coarse = ids();
    await send(coarse, [{ type: "pageview", url: "https://coarse.example/" }], { site: "coarse" });
    expect(session(coarse.session)).toMatchObject({ country: "DE", region: null, city: null });
    const off = ids();
    await send(off, [{ type: "pageview", url: "https://nowhere.example/" }], { site: "nowhere" });
    expect(session(off.session)).toMatchObject({ country: null, region: null, city: null });
    // Events from the site's servers come from the servers' address: no place.
    const fromServer = ids();
    await app.collect({ site: "shop", ...fromServer, events: [view("/")] }, { origin: "", headers: { "x-analytics-key": "x" } });
    const untrusted = await startApp({ version: "0.1.0", sites: SITES, analyticsOptions: { geo: createGeo({ file: mmdb, update: false }) } });
    try {
      const id = ids();
      await untrusted.collect({ site: "shop", ...id, events: [view("/")] }, { origin: SHOP, headers: { "x-forwarded-for": "203.0.113.9" } });
      expect(untrusted.db.prepare("SELECT country FROM sessions WHERE id = ?").get(id.session)).toEqual({ country: null });
    } finally {
      await untrusted.close();
    }
  });

  it("keeps utm_term and utm_content, the full referrer without its query, and the AI assistant it came from", async () => {
    const id = ids();
    await send(id, [
      view("/?utm_source=chatgpt.com&utm_term=running%20shoes&utm_content=ali@example.com", 0, {
        referrer: "https://chatgpt.com/c/68f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5?token=abc&email=ali@example.com",
      }),
    ]);
    expect(session(id.session)).toMatchObject({
      source: "chatgpt.com",
      referrer: "https://chatgpt.com",
      referrer_url: "https://chatgpt.com/c/***",
      utm_term: "running shoes",
      utm_content: "***",
      channel: "ai",
    });
  });

  it("counts a visitor's second visit as returning", async () => {
    const id = ids();
    await send(id, [view("/")]);
    await send({ visitor: id.visitor, session: `${id.session}-2` }, [view("/")]);
    expect(session(`${id.session}-2`).is_returning).toBe(1);
  });

  it("counts a visit as engaged as GA4 does: two pages, more than 10 seconds, or a goal", async () => {
    const one = ids();
    await send(one, [view("/")]);
    const two = ids();
    await send(two, [view("/"), view("/pricing", 2)]);
    const long = ids();
    await send(long, [view("/"), { type: "leave", at: at(11), url: `${SHOP}/`, duration: 11_000, scroll: 10 }]);
    const short = ids();
    await send(short, [view("/"), { type: "leave", at: at(9), url: `${SHOP}/`, duration: 9_000, scroll: 10 }]);
    const goal = ids();
    await send(goal, [view("/checkout/done")]);
    expect([one, two, long, short, goal].map((x) => session(x.session).engaged)).toEqual([0, 1, 1, 0, 1]);
  });

  it("marks links out and downloads, by the file endings of the site", async () => {
    const id = ids();
    const click = (href: string) => ({ type: "click", at: at(), url: `${SHOP}/`, target: "a", text: "x", href });
    await send(id, [
      view("/"),
      click("https://elsewhere.example/a?b=c"),
      click(`${SHOP}/files/report.PDF`),
      click("https://cdn.example/app.zip"),
      click(`${SHOP}/about`),
      click(`${SHOP}/x.exe`),
    ]);
    const links = app.db.prepare("SELECT href, link FROM events WHERE session = ? AND type = 'click' ORDER BY id").all(id.session);
    expect(links).toEqual([
      { href: "https://elsewhere.example/a", link: "outbound" },
      { href: "/files/report.PDF", link: "download" },
      { href: "https://cdn.example/app.zip", link: "download" },
      { href: "/about", link: null },
      // exe is a download by default, but this site lists its own endings.
      { href: "/x.exe", link: null },
    ]);
  });

  it("keeps pages not found with the page that linked to them, and site searches masked", async () => {
    const id = ids();
    await send(id, [
      view("/", 0),
      view("/old-page", 1, { notFound: true, referrer: `${SHOP}/blog/post` }),
      view("/search?q=Red%20Shoes%20ali@example.com", 2),
      view("/search?s=call%20me%20%2B90%20532%20123%2045%2067", 3),
      view("/later", 4),
      { type: "leave", at: at(5), url: `${SHOP}/later`, notFound: true, duration: 1000, scroll: 10 },
    ]);
    const rows = app.db.prepare("SELECT path, query, search, not_found, ref FROM events WHERE session = ? AND type = 'pageview' ORDER BY id").all(id.session);
    expect(rows).toEqual([
      { path: "/", query: null, search: null, not_found: null, ref: null },
      { path: "/old-page", query: null, search: null, not_found: 1, ref: "/blog/post" },
      // The search parameter is read before the query string is dropped; it is not kept in the address.
      { path: "/search", query: null, search: "red shoes ***", not_found: null, ref: null },
      { path: "/search", query: null, search: "call me +***", not_found: null, ref: null },
      // openasy.notFound() after the page view was sent: the leave marks it.
      { path: "/later", query: null, search: null, not_found: 1, ref: null },
    ]);
  });

  it("tells a page not found by the title the file names, reads searches only on the search pages, and counts a download goal", async () => {
    const ranged = await startApp({
      version: "0.1.0",
      sites: `sites:
  - name: shop
    domains: [${SHOP}]
    search: { path: /search, param: q }
    notFound: { title: Page not found }
    vitals: true
    goals:
      - { name: Guide, download: /files/*.pdf }`,
    });
    try {
      const id = ids();
      await ranged.collect({
        site: "shop",
        ...id,
        events: [
          { type: "pageview", url: `${SHOP}/nope`, title: "Page Not Found " },
          { type: "pageview", url: `${SHOP}/products?q=ignored` },
          { type: "pageview", url: `${SHOP}/search?q=Grinder` },
          { type: "click", url: `${SHOP}/search`, target: "a", href: `${SHOP}/files/guide.pdf` },
        ],
      });
      expect(ranged.db.prepare("SELECT path, not_found, search FROM events WHERE type = 'pageview' ORDER BY id").all()).toEqual([
        { path: "/nope", not_found: 1, search: null },
        { path: "/products", not_found: null, search: null },
        { path: "/search", not_found: null, search: "grinder" },
      ]);
      const r = await json(await ranged.admin("/api/v1/report?site=shop&days=7"));
      expect(r.goals).toEqual([{ name: "Guide", path: null, event: null, download: "/files/*.pdf", visits: 1, rate: 1, value: null }]);
      expect((await json(await ranged.admin("/api/v1/report?site=shop&days=7&filter=goal:is:Guide"))).totals.visits).toBe(1);
      expect(await (await fetch(`${ranged.base}/s/shop.js`)).text()).toContain('"vitals":true');
    } finally {
      await ranged.close();
    }
  });

  it("keeps the Core Web Vitals of a page with its leave, and refuses values that are not numbers", async () => {
    const id = ids();
    await send(id, [view("/"), { type: "leave", at: at(3), url: `${SHOP}/`, duration: 3000, scroll: 10, lcp: 1800.6, inp: 120, cls: 0.123456 }]);
    expect(app.db.prepare("SELECT lcp, inp, cls FROM events WHERE session = ? AND type = 'leave'").get(id.session)).toEqual({
      lcp: 1801,
      inp: 120,
      cls: 0.1235,
    });
    expect((await send(ids(), [{ type: "leave", url: `${SHOP}/`, cls: "bad" }])).status).toBe(422);
    expect((await send(ids(), [{ type: "click", url: `${SHOP}/`, dead: "yes" }])).status).toBe(422);
  });

  it("marks rage clicks on the click that made the burst, and joins a dead click sent again", async () => {
    const id = ids();
    const t = at();
    const click = (ms: number, more: object = {}) => ({ type: "click", at: t + ms, url: `${SHOP}/`, target: "button.pay", text: "Pay", ...more });
    await send(id, [view("/"), click(0), click(200), click(400), click(600)]);
    await send(id, [click(5000), click(5000, { dead: true })]);
    const rows = app.db.prepare("SELECT rage, dead FROM events WHERE session = ? AND type = 'click' ORDER BY id").all(id.session);
    expect(rows).toEqual([
      { rage: null, dead: null },
      { rage: null, dead: null },
      { rage: 1, dead: null },
      { rage: null, dead: null },
      { rage: null, dead: 1 },
    ]);
    expect(session(id.session).rage).toBe(1);
  });
});

describe("filters and comparisons", () => {
  let fresh: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    fresh = await startApp({
      version: "0.1.0",
      sites: SITES,
      trustedProxies: ["127.0.0.1", "::1"],
      analyticsOptions: { geo: createGeo({ file: mmdb, update: false }) },
    });
    const go = (id: string, events: unknown[], ip: string, ua?: string) =>
      fresh.collect(
        { site: "shop", visitor: `v-${id}-filters`, session: `s-${id}-filters`, events },
        { headers: { "x-forwarded-for": ip }, ...(ua && { ua }) },
      );
    const t = fresh.clock();
    const v = (path: string, more: object = {}) => ({ type: "pageview", at: t, url: `${SHOP}${path}`, ...more });
    await go("de-google", [v("/", { referrer: "https://www.google.de/" }), v("/pricing")], "203.0.113.1");
    await go("de-direct", [v("/blog/a")], "203.0.113.2", IPHONE);
    await go("tr-chatgpt", [v("/?utm_source=chatgpt.com"), v("/checkout/done")], "198.51.100.3");
    await go(
      "tr-social",
      [v("/blog/b", { referrer: "https://t.co/x" }), { type: "event", at: t, url: `${SHOP}/blog/b`, name: "share" }],
      "198.51.100.4",
      IPHONE,
    );
    // Eight days ago, for the previous period; a year ago, for the same days last year.
    await go("old", [{ type: "pageview", at: t - 8 * 86_400_000, url: `${SHOP}/` }], "203.0.113.5");
    fresh.db
      .prepare("UPDATE sessions SET started_at = ?, last_at = ? WHERE id = 's-old-filters'")
      .run(new Date(t - 8 * 86_400_000).toISOString(), new Date(t - 8 * 86_400_000).toISOString());
    for (const [id, ago] of [
      ["year-1", 365],
      ["year-2", 366],
    ] as const) {
      await go(id, [{ type: "pageview", at: t, url: `${SHOP}/` }], "198.51.100.9");
      const when = new Date(t - ago * 86_400_000).toISOString();
      fresh.db.prepare("UPDATE sessions SET started_at = ?, last_at = ? WHERE id = ?").run(when, when, `s-${id}-filters`);
      fresh.db.prepare("UPDATE events SET at = ? WHERE session = ?").run(when, `s-${id}-filters`);
    }
  });
  afterAll(() => fresh.close());
  const get = async (path: string) => json(await fresh.admin(path));

  it("keeps the visits of one or several values, or all but them", async () => {
    expect((await get("/api/v1/report?site=shop&days=7&filter=country:is:DE")).totals.visits).toBe(2);
    expect((await get("/api/v1/report?site=shop&days=7&filter=country:is:DE|TR")).totals.visits).toBe(4);
    expect((await get("/api/v1/report?site=shop&days=7&filter=country:not:DE")).totals.visits).toBe(2);
    expect((await get("/api/v1/report?site=shop&days=7&filter=channel:is:ai|organic-search")).totals.visits).toBe(2);
    expect((await get("/api/v1/report?site=shop&days=7&filter=source:is:(none)")).totals.visits).toBe(2);
    expect((await get("/api/v1/report?site=shop&days=7&filter=source:not:(none)")).totals.visits).toBe(2);
    // Filters together all apply.
    expect((await get("/api/v1/report?site=shop&days=7&filter=country:is:TR&filter=device:is:mobile")).totals.visits).toBe(1);
  });

  it("filters on what a visit did: a page, with *, an event or a goal", async () => {
    const blog = await get("/api/v1/report?site=shop&days=7&filter=page:is:/blog/*");
    expect(blog.totals.visits).toBe(2);
    // The pages of a report filtered on a page are the matching pages only.
    expect(blog.pages.map((p: { path: string }) => p.path).sort()).toEqual(["/blog/a", "/blog/b"]);
    expect((await get("/api/v1/report?site=shop&days=7&filter=page:not:/blog/*")).totals.visits).toBe(2);
    expect((await get("/api/v1/report?site=shop&days=7&filter=event:is:share")).totals.visits).toBe(1);
    expect((await get("/api/v1/report?site=shop&days=7&filter=goal:is:Bought")).totals.visits).toBe(1);
    expect((await get("/api/v1/report?site=shop&days=7&filter=goal:is:Nothing")).totals.visits).toBe(0);
  });

  it("refuses a filter it cannot read", async () => {
    for (const f of ["country", "planet:is:mars", "country:maybe:DE", "country:is:", `country:is:${Array.from({ length: 21 }, (_, i) => i).join("|")}`]) {
      const res = await fresh.admin(`/api/v1/report?site=shop&filter=${encodeURIComponent(f)}`);
      expect(res.status, f).toBe(422);
    }
    expect((await fresh.admin("/api/v1/report?site=shop&compare=decade")).status).toBe(422);
  });

  it("returns the period and the one before it, or the same days a year before", async () => {
    const r = await get("/api/v1/report?site=shop&days=7&compare=previous");
    expect(r.totals.visits).toBe(4);
    expect(r.compare).toMatchObject({ period: "previous", from: "2026-10-09T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z" });
    expect(r.compare.totals.visits).toBe(1);
    expect(r.compare.series).toHaveLength(7);
    const y = await get("/api/v1/report?site=shop&days=7&compare=year");
    expect(y.compare).toMatchObject({ period: "year", from: "2025-10-16T00:00:00.000Z", to: "2025-10-23T00:00:00.000Z" });
    expect(y.compare.totals.visits).toBe(2);
    // Filters apply to both periods.
    const both = await get("/api/v1/report?site=shop&days=7&compare=previous&filter=country:is:TR");
    expect([both.totals.visits, both.compare.totals.visits]).toEqual([2, 0]);
    expect((await get("/api/v1/report?site=shop&days=7")).compare).toBeUndefined();
  });

  it("filters and compares funnels, forms, heatmaps, replays and visits too", async () => {
    expect((await fresh.admin("/api/v1/funnels?site=shop&days=7&filter=country:is:DE&compare=previous")).status).toBe(200);
    expect((await get("/api/v1/forms?site=shop&days=7&compare=year")).compare.period).toBe("year");
    const heat = await get("/api/v1/heatmap?site=shop&days=7&path=/&filter=country:is:TR");
    expect(heat.views).toBe(1);
    expect((await get("/api/v1/visits?site=shop&filter=country:is:TR&filter=device:is:mobile")).visits).toHaveLength(1);
    expect((await get("/api/v1/visits?site=shop&days=7&filter=page:is:/pricing")).visits.map((v: { id: string }) => v.id)).toEqual(["s-de-google-filters"]);
    expect((await get("/api/v1/replays?site=shop&days=7&filter=country:is:TR")).replays).toEqual([]);
  });

  it("breaks visits down by any dimension, with the one it belongs to", async () => {
    const countries = await get("/api/v1/breakdown?site=shop&days=7&dimension=country");
    expect(countries.rows).toEqual([
      { value: "DE", group: null, visitors: 2, visits: 2, count: 3, engagementRate: 0.5, duration: 0 },
      // The visit that only shared viewed one page: an event that is not a goal does not make it engaged.
      { value: "TR", group: null, visitors: 2, visits: 2, count: 3, engagementRate: 0.5, duration: 0 },
    ]);
    const cities = await get("/api/v1/breakdown?site=shop&days=7&dimension=city");
    expect(cities.rows.map((r: { value: string; group: string }) => [r.value, r.group])).toEqual([
      ["Istanbul", "Istanbul, TR"],
      ["Munich", "Bavaria, DE"],
    ]);
    const versions = await get("/api/v1/breakdown?site=shop&days=7&dimension=browserVersion");
    expect(versions.rows.map((r: { value: string; group: string }) => `${r.group} ${r.value}`).sort()).toEqual(["Chrome 141", "Safari 18"]);
    const channels = await get("/api/v1/breakdown?site=shop&days=7&dimension=channel&compare=previous");
    expect(channels.rows.map((r: { value: string }) => r.value).sort()).toEqual(["ai", "direct", "organic-search", "social"]);
    expect(channels.compare.rows).toEqual([{ value: "direct", group: null, visitors: 1, visits: 1, count: 1, engagementRate: 0, duration: 0 }]);
    const types = await get("/api/v1/breakdown?site=shop&days=7&dimension=visitorType");
    expect(types.rows).toEqual([expect.objectContaining({ value: "new", visits: 4 })]);
    const pages = await get("/api/v1/breakdown?site=shop&days=7&dimension=page&filter=country:is:DE&limit=2");
    expect(pages.rows).toHaveLength(2);
    expect(pages.rows[0]).toMatchObject({ engagementRate: null, duration: null });
    expect((await fresh.admin("/api/v1/breakdown?site=shop&dimension=shoeSize")).status).toBe(422);
  });

  it("breaks down searches, pages not found, links out and downloads", async () => {
    const t = fresh.clock();
    await fresh.collect({
      site: "shop",
      visitor: "v-misc-filters",
      session: "s-misc-filters",
      events: [
        { type: "pageview", at: t, url: `${SHOP}/find?q=boots` },
        { type: "pageview", at: t, url: `${SHOP}/find?q=Boots` },
        { type: "pageview", at: t, url: `${SHOP}/gone`, notFound: true, referrer: "https://forum.example/thread?id=4" },
        { type: "click", at: t, url: `${SHOP}/gone`, target: "a", href: "https://partner.example/" },
        { type: "click", at: t, url: `${SHOP}/gone`, target: "a", href: `${SHOP}/catalog.pdf` },
      ],
    });
    const rows = async (d: string) => (await get(`/api/v1/breakdown?site=shop&days=7&dimension=${d}`)).rows.map((r: any) => [r.value, r.group, r.count]);
    expect(await rows("search")).toEqual([["boots", null, 2]]);
    expect(await rows("notFound")).toEqual([["/gone", "https://forum.example/thread", 1]]);
    expect(await rows("outbound")).toEqual([["https://partner.example/", null, 1]]);
    expect(await rows("download")).toEqual([["/catalog.pdf", null, 1]]);
  });
});

describe("now, notes, vitals and frustration", () => {
  it("shows who is on the site now and the page each is on", async () => {
    const id = ids();
    await send(id, [view("/"), view("/live-now", 1)], { ip: "198.51.100.20" });
    const r = await json(await app.admin("/api/v1/realtime?site=shop"));
    expect(r.visitors).toBeGreaterThan(0);
    expect(r.pages).toContainEqual({ path: "/live-now", visitors: 1 });
    expect(r.countries).toContainEqual(expect.objectContaining({ country: "TR" }));
    expect(r.minutes).toHaveLength(30);
    const filtered = await json(await app.admin("/api/v1/realtime?site=shop&filter=page:is:/live-now"));
    expect(filtered.visitors).toBe(1);
    // Five minutes later, the visit is no longer on the site now.
    app.clock.advance(6 * 60_000);
    expect((await json(await app.admin("/api/v1/realtime?site=shop&filter=page:is:/live-now"))).visitors).toBe(0);
  });

  it("keeps annotations that editors add and delete, and viewers read", async () => {
    const viewer = { authorization: `Bearer ${VIEWER}` };
    const add = (body: unknown, headers: Record<string, string> = {}) =>
      app.admin("/api/v1/annotations?site=shop", { method: "POST", body: JSON.stringify(body), headers });
    const created = await add({ date: "2026-10-20", text: "  Launched the new pricing page " });
    expect(created.status).toBe(201);
    const a = await json(created);
    expect(a).toMatchObject({ site: "shop", date: "2026-10-20", text: "Launched the new pricing page", createdBy: null });
    expect((await add({ date: "2026-02-30", text: "x" })).status).toBe(422);
    expect((await add({ date: "2026-10-20", text: "" })).status).toBe(422);
    expect((await add({ date: "2026-10-20", text: "x", color: "red" })).status).toBe(422);
    expect((await add({ date: "2026-10-20", text: "x" }, viewer)).status).toBe(403);
    const list = await json(await fetch(`${app.base}/api/v1/annotations?site=shop&days=7`, { headers: viewer }));
    expect(list.annotations).toEqual([a]);
    expect((await json(await fetch(`${app.base}/api/v1/annotations?site=shop&days=1`, { headers: viewer }))).annotations).toEqual([]);
    expect((await report("days=7")).annotations).toEqual([a]);
    expect((await fetch(`${app.base}/api/v1/annotations/${a.id}?site=shop`, { method: "DELETE", headers: viewer })).status).toBe(403);
    expect((await app.admin(`/api/v1/annotations/${a.id}?site=coarse`, { method: "DELETE" })).status).toBe(404);
    expect((await app.admin(`/api/v1/annotations/${a.id}?site=shop`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/annotations/${a.id}?site=shop`, { method: "DELETE" })).status).toBe(404);
  });

  it("gives Core Web Vitals at the 75th percentile, by device and by page", async () => {
    const vitals = await startApp({ version: "0.1.0", sites: SITES });
    try {
      const t = vitals.clock();
      for (let i = 1; i <= 8; i++) {
        const leave = { type: "leave", at: t, url: `${SHOP}/fast`, duration: 1000, scroll: 50, lcp: i * 500, inp: i * 50, cls: i / 100 };
        await vitals.collect(
          { site: "shop", visitor: `v-vital-${i}`, session: `s-vital-${i}`, events: [{ type: "pageview", at: t, url: `${SHOP}/fast` }, leave] },
          i > 6 ? { ua: IPHONE } : {},
        );
      }
      const r = await json(await vitals.admin("/api/v1/vitals?site=shop&days=7"));
      expect(r.thresholds.lcp).toEqual([2500, 4000]);
      // Nearest rank: the 6th of 8.
      expect(r.totals).toMatchObject({ samples: 8, lcp: { p75: 3000, samples: 8, good: 5 / 8, poor: 0 }, inp: { p75: 300 }, cls: { p75: 0.06 } });
      expect(r.devices.map((d: { device: string; lcp: { p75: number } }) => [d.device, d.lcp.p75])).toEqual([
        ["desktop", 2500],
        ["mobile", 4000],
      ]);
      expect(r.pages).toContainEqual({ path: "/fast", device: "mobile", samples: 2, lcp: 4000, inp: 400, cls: 0.08 });
      expect((await json(await vitals.admin("/api/v1/vitals?site=shop&days=7&filter=device:is:mobile"))).totals.samples).toBe(2);
    } finally {
      await vitals.close();
    }
  });

  it("lists rage and dead clicks by page and element", async () => {
    const r = await json(await app.admin("/api/v1/frustration?site=shop&days=7&compare=previous"));
    // Five quick clicks on the links of one page were a rage click too.
    expect(r.totals).toMatchObject({ rage: 2, dead: 1, rageVisits: 2, deadVisits: 1 });
    expect(r.pages).toContainEqual(expect.objectContaining({ path: "/", rage: 2, dead: 1 }));
    expect(r.elements).toContainEqual({ path: "/", target: "button.pay", text: "Pay", rage: 1, dead: 1, visitors: 1 });
    expect(r.compare.totals.rage).toBe(0);
  });

  it("names the GeoIP database and its attribution in the summary", async () => {
    const s = await json(await app.admin("/api/v1/summary"));
    expect(s.location).toMatchObject({ enabled: true, attribution: expect.stringContaining("CC BY 4.0") });
  });
});
