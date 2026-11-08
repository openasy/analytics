// Reports over a realistic volume: a site with about 2,000 visits a day for 30 days, 60,000 visits and 300,000
// events, filled straight into the database. On a laptop each answers in about half a second or less; the bound
// leaves room for a busy CI runner.
import { describe, expect, it } from "vitest";
import { createAnalytics } from "./analytics.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const DAY = 86_400_000;
const VISITS = 60_000;

function fill() {
  const db = openDb(":memory:");
  const pick = <T>(list: readonly T[], i: number) => list[i % list.length]!;
  const countries = ["DE", "TR", "US", "FR", "GB", "NL", null] as const;
  const channels = ["direct", "organic-search", "social", "referral", "ai", "email", "paid-search"] as const;
  const paths = Array.from({ length: 200 }, (_, i) => `/p/${i}`);
  const session = db.prepare(
    `INSERT INTO sessions (site, id, visitor, started_at, last_at, entry_path, exit_path, pageviews, events, source, channel, browser, browser_version, os, device,
       country, region, city, language, screen, is_returning, engaged)
     VALUES ('shop', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '141', ?, ?, ?, ?, ?, 'en-US', '1920x1080', ?, ?)`,
  );
  const event = db.prepare(
    "INSERT INTO events (site, session, visitor, at, type, path, target, href, name, duration, scroll, lcp, inp, cls, rage, dead, link) VALUES ('shop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const commerce = db.prepare(
    "INSERT INTO events (site, session, visitor, at, type, path, name, amount, order_id) VALUES ('shop', ?, ?, ?, 'event', ?, ?, ?, ?)",
  );
  const order = db.prepare("INSERT INTO orders (site, id, session, visitor, at, value, items) VALUES ('shop', ?, ?, ?, ?, ?, 2)");
  const item = db.prepare(
    "INSERT INTO items (site, session, visitor, at, action, order_id, sku, name, price, quantity) VALUES ('shop', ?, ?, ?, ?, ?, ?, ?, 450, ?)",
  );
  const search = db.prepare(
    "INSERT INTO events (site, session, visitor, at, type, path, search, no_results) VALUES ('shop', ?, ?, ?, 'pageview', '/search', ?, ?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i < VISITS; i++) {
    const start = NOW - Math.floor((i / VISITS) * 30 * DAY);
    const at = (s: number) => new Date(start + s * 1000).toISOString();
    const id = `s-${i}`;
    const visitor = `v-${i % 25_000}`;
    const views = 1 + (i % 4);
    const entry = pick(paths, i * 7);
    session.run(
      id,
      visitor,
      at(0),
      at(views * 20),
      entry,
      pick(paths, i * 11),
      views,
      i % 3 ? "google.com" : null,
      pick(channels, i),
      pick(["Chrome", "Safari", "Firefox", "Edge"], i),
      pick(["Windows", "macOS", "iOS", "Android"], i),
      pick(["desktop", "mobile", "tablet"], i),
      pick(countries, i),
      "Region",
      "City",
      i % 25_000 === i ? 0 : 1,
      views > 1 ? 1 : 0,
    );
    for (let v = 0; v < views; v++) {
      const path = v ? pick(paths, i * 13 + v) : entry;
      event.run(id, visitor, at(v * 20), "pageview", path, null, null, null, null, null, null, null, null, null, null, null);
      event.run(id, visitor, at(v * 20 + 19), "leave", path, null, null, null, 19_000, 60, 1000 + (i % 3000), 50 + (i % 400), (i % 30) / 100, null, null, null);
    }
    if (i % 2)
      event.run(
        id,
        visitor,
        at(5),
        "click",
        entry,
        "button.buy",
        i % 10 ? null : "https://out.example/",
        null,
        null,
        null,
        null,
        null,
        null,
        i % 50 ? null : 1,
        i % 40 ? null : 1,
        i % 10 ? null : "outbound",
      );
    if (i % 5 === 0) event.run(id, visitor, at(6), "event", entry, null, null, "signup", null, null, null, null, null, null, null, null);
    // A product seen in every third visit, put in the cart in every sixth and bought in every twentieth.
    const sku = `SKU-${i % 300}`;
    if (i % 3 === 0)
      (commerce.run(id, visitor, at(7), entry, "view_item", null, null), item.run(id, visitor, at(7), "view_item", null, sku, `Product ${i % 300}`, 1));
    if (i % 6 === 0) (commerce.run(id, visitor, at(8), entry, "add_to_cart", null, null), item.run(id, visitor, at(8), "add_to_cart", null, sku, null, 2));
    if (i % 20 === 0) {
      commerce.run(id, visitor, at(9), entry, "purchase", 900, `o-${i}`);
      order.run(`o-${i}`, id, visitor, at(9), 900);
      item.run(id, visitor, at(9), "purchase", `o-${i}`, sku, null, 2);
    }
    if (i % 15 === 0) search.run(id, visitor, at(10), `term ${i % 400}`, i % 45 === 0 ? 1 : null);
  }
  db.exec("COMMIT");
  for (const day of Array.from({ length: 30 }, (_, d) => new Date(NOW - d * DAY).toISOString().slice(0, 10)))
    db.prepare("INSERT INTO days (site, day, visitors, visits, pageviews) VALUES ('shop', ?, 2000, 2000, 5000)").run(day);
  db.exec("ANALYZE");
  const analytics = createAnalytics(db, { clock: () => NOW });
  analytics.setSites(
    parseConfig(
      "sites: [{ name: shop, domains: [https://www.shop.example], currency: TRY, ecommerce: true, search: q, goals: [{ name: Signed up, event: signup, value: 150 }, { name: Pricing, path: /p/1* }, { name: Bought, event: purchase, value: value }] }]",
    ),
  );
  return { db, analytics };
}

const timed = <T>(fn: () => T) => {
  const t = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t };
};

describe("reports over 60,000 visits", () => {
  const { analytics, db } = fill();
  it("holds the data it was given", () => {
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBeGreaterThan(250_000);
  });

  const cases: Array<[string, () => unknown]> = [
    ["the report", () => analytics.report("shop", { range: 30 })],
    [
      "the report, filtered and compared",
      () =>
        analytics.report("shop", {
          range: 30,
          filters: [
            { dimension: "country", op: "is", values: ["DE", "TR"] },
            { dimension: "device", op: "not", values: ["tablet"] },
          ],
          compare: "previous",
        }),
    ],
    ["the report filtered on a page", () => analytics.report("shop", { range: 30, filters: [{ dimension: "page", op: "is", values: ["/p/1*"] }] })],
    ["a breakdown by country", () => analytics.breakdown("shop", "country", { range: 30, compare: "year" })],
    ["a breakdown by page", () => analytics.breakdown("shop", "page", { range: 30, filters: [{ dimension: "channel", op: "is", values: ["ai"] }] })],
    ["Core Web Vitals", () => analytics.vitals("shop", { range: 30 })],
    ["rage and dead clicks", () => analytics.frustration("shop", { range: 30 })],
    ["who is on the site now", () => analytics.realtime("shop")],
    ["ecommerce, compared", () => analytics.ecommerce("shop", { range: 30, compare: "previous" })],
    ["attribution of a goal reached by every fifth visit", () => analytics.attribution("shop", "Signed up", { range: 30 }, 30, "channel")],
    ["paths from a page", () => analytics.paths("shop", "/p/7", "from", 3, { range: 30 })],
    ["paths to a page", () => analytics.paths("shop", "/p/1*", "to", 3, { range: 30 })],
    ["retention: 8 weekly cohorts and 30 days of stickiness", () => analytics.retention("shop", 8, 30)],
    ["retention, filtered", () => analytics.retention("shop", 8, 30, [{ dimension: "country", op: "is", values: ["DE"] }])],
    ["site search with what came after", () => analytics.siteSearch("shop", { range: 30 })],
  ];
  for (const [name, run] of cases)
    it(`${name} answers within a second and a half`, () => {
      run(); // warm
      const { ms } = timed(run);
      if (process.env.ANALYTICS_TIMINGS) console.log(`${Math.round(ms)} ms  ${name}`);
      expect(ms).toBeLessThan(1500);
    });
});
