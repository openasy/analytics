import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_KEY, SHOP, startApp } from "./test-app.ts";

const SITES = `
sites:
  - name: shop
    domains: [${SHOP}]
    serverKey: SHOP_KEY
    currency: TRY
    ecommerce: true
    goals:
      - { name: Bought, event: purchase, value: value }
      - { name: Signed up, event: signup, value: 150 }
      - { name: Pricing, path: /pricing }
  - name: blog
    domains: [https://blog.example]
`;

let app: Awaited<ReturnType<typeof startApp>>;
const json = async (r: Response) => (await r.json()) as any;
const ids = (n: string) => ({ site: "shop", visitor: `visitor-${n}`, session: `session-${n}` });
const at = () => app.clock();

beforeAll(async () => {
  app = await startApp({ version: "0.1.0", sites: SITES });
});
afterAll(() => app.close());

describe("ecommerce events", () => {
  it("keeps an order once, with its products, and its refund", async () => {
    const t = at();
    const beans = { sku: "ESP-1000", name: "Espresso beans 1 kg", category: "Coffee", price: 900 };
    const r = await app.collect({
      ...ids("buyer-0001"),
      events: [
        { type: "pageview", at: t, url: `${SHOP}/products/beans?utm_source=newsletter&utm_campaign=fall`, referrer: "https://news.example/" },
        { type: "event", at: t + 1, url: `${SHOP}/products/beans`, name: "view_item", items: [beans] },
        { type: "event", at: t + 2, url: `${SHOP}/products/beans`, name: "add_to_cart", items: [{ ...beans, quantity: 2 }] },
        { type: "event", at: t + 3, url: `${SHOP}/checkout`, name: "begin_checkout", value: 1800, currency: "TRY", items: [{ ...beans, quantity: 2 }] },
        { type: "event", at: t + 4, url: `${SHOP}/checkout/done`, name: "purchase", order: "A-1001", currency: "TRY", items: [{ ...beans, quantity: 2 }] },
        // The thank-you page loaded again: the same order is not counted twice.
        { type: "event", at: t + 5, url: `${SHOP}/checkout/done`, name: "purchase", order: "A-1001", currency: "TRY", items: [{ ...beans, quantity: 2 }] },
        // Another currency than the site's is dropped.
        { type: "event", at: t + 6, url: `${SHOP}/checkout/done`, name: "purchase", order: "A-1002", value: 10, currency: "EUR" },
      ],
    });
    expect(await json(r)).toEqual({ accepted: 5, dropped: 2 });
    const order = app.db.prepare("SELECT * FROM orders WHERE id = 'A-1001'").get() as Record<string, unknown>;
    expect(order).toMatchObject({ value: 1800, items: 2, refunded_at: null });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM items WHERE order_id = 'A-1001' AND action = 'purchase'").get()).toEqual({ n: 1 });

    // A refund of part of it, from the shop's servers, starts no visit.
    const visits = (app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const refund = await fetch(`${app.base}/api/v1/collect`, {
      method: "POST",
      headers: { "x-analytics-key": SERVER_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        ...ids("server-0001"),
        events: [{ type: "event", url: `${SHOP}/admin`, name: "refund", order: "A-1001", value: 900, items: [{ ...beans, quantity: 1 }] }],
      }),
    });
    expect(await json(refund)).toEqual({ accepted: 1, dropped: 0 });
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(visits);
    expect(app.db.prepare("SELECT refunded FROM orders WHERE id = 'A-1001'").get()).toEqual({ refunded: 900 });
    // From a page, only the visitor who bought may refund.
    const other = await app.collect({ ...ids("other-0001"), events: [{ type: "event", url: `${SHOP}/`, name: "refund", order: "A-1001" }] });
    expect(await json(other)).toEqual({ accepted: 0, dropped: 1 });
  });

  it("refuses products that name someone, and fields of an ecommerce event on others", async () => {
    const bad = async (events: unknown[]) => (await json(await app.collect({ ...ids("bad-00001"), events }))).detail as string;
    expect(await bad([{ type: "event", url: `${SHOP}/`, name: "purchase", order: "B-1", items: [{ sku: "X", name: "for ayse@example.com" }] }])).toMatch(
      /email addresses and phone numbers are not kept/,
    );
    expect(await bad([{ type: "event", url: `${SHOP}/`, name: "purchase", order: "B-1", items: [{ sku: "X", buyer: "Ayşe" }] }])).toMatch(
      /buyer is not part of a product/,
    );
    expect(await bad([{ type: "event", url: `${SHOP}/`, name: "purchase", items: [{ sku: "X" }] }])).toMatch(/order is required/);
    expect(await bad([{ type: "event", url: `${SHOP}/`, name: "signup", value: 3 }])).toMatch(/part of an ecommerce event only/);
    expect(await bad([{ type: "event", url: `${SHOP}/`, name: "purchase", order: "+90 532 123 45 67" }])).toMatch(/order is the order's id/);
  });

  it("drops ecommerce on a site without ecommerce: true", async () => {
    const r = await app.collect(
      {
        site: "blog",
        visitor: "visitor-blog1",
        session: "session-blog1",
        events: [{ type: "event", url: "https://blog.example/", name: "purchase", order: "C-1" }],
      },
      { origin: "https://blog.example" },
    );
    expect(await json(r)).toEqual({ accepted: 0, dropped: 1 });
  });

  it("reports sales, the purchase funnel, products and revenue by source", async () => {
    // A second buyer from search, and a visit that only looked.
    const t = at();
    await app.collect({
      ...ids("buyer-0002"),
      events: [
        { type: "pageview", at: t, url: `${SHOP}/products/grinder`, referrer: "https://www.google.com/" },
        { type: "event", at: t + 1, url: `${SHOP}/products/grinder`, name: "view_item", items: [{ sku: "GRN-01", name: "Burr grinder", price: 3500 }] },
        { type: "event", at: t + 2, url: `${SHOP}/`, name: "add_to_cart", items: [{ sku: "GRN-01", price: 3500 }] },
        { type: "event", at: t + 3, url: `${SHOP}/`, name: "purchase", order: "A-1003", value: 3500, items: [{ sku: "GRN-01", price: 3500 }] },
      ],
    });
    await app.collect({
      ...ids("looker-001"),
      events: [
        { type: "pageview", at: t, url: `${SHOP}/products/grinder` },
        { type: "event", at: t + 1, url: `${SHOP}/products/grinder`, name: "view_item", items: [{ sku: "GRN-01", price: 3500 }] },
      ],
    });
    const r = await json(await app.admin("/api/v1/ecommerce?site=shop&days=7&compare=previous"));
    expect(r.currency).toBe("TRY");
    expect(r.totals).toMatchObject({ revenue: 5300, orders: 2, averageOrder: 2650, units: 3, buyingVisits: 2, refunds: 1, refunded: 900 });
    expect(r.funnel).toEqual([
      { event: "view_item", visits: 3 },
      { event: "add_to_cart", visits: 2 },
      { event: "begin_checkout", visits: 1 },
      { event: "purchase", visits: 1 },
    ]);
    expect(r.products[0]).toMatchObject({ sku: "GRN-01", name: "Burr grinder", views: 2, carts: 1, units: 1, revenue: 3500 });
    expect(r.products[1]).toMatchObject({ sku: "ESP-1000", category: "Coffee", views: 1, carts: 1, units: 2, revenue: 1800, refunded: 1 });
    expect(r.sources.find((s: { source: string }) => s.source === "google.com")).toMatchObject({ orders: 1, revenue: 3500 });
    expect(r.campaigns.find((s: { campaign: string }) => s.campaign === "fall")).toMatchObject({ orders: 1, revenue: 1800 });
    expect(r.compare.totals.orders).toBe(0);
    // Filters keep the visits that match.
    const google = await json(await app.admin("/api/v1/ecommerce?site=shop&days=7&filter=source:is:google.com"));
    expect(google.totals).toMatchObject({ orders: 1, revenue: 3500 });
  });

  it("gives goals their value: a fixed amount or the event's", async () => {
    await app.collect({
      ...ids("signup-001"),
      events: [
        { type: "pageview", url: `${SHOP}/` },
        { type: "event", url: `${SHOP}/`, name: "signup" },
      ],
    });
    const r = await json(await app.admin("/api/v1/report?site=shop&days=7"));
    expect(r.goals.find((g: { name: string }) => g.name === "Bought")).toMatchObject({ visits: 2, value: 5300 });
    expect(r.goals.find((g: { name: string }) => g.name === "Signed up")).toMatchObject({ visits: 1, value: 150 });
    expect(r.goals.find((g: { name: string }) => g.name === "Pricing")).toMatchObject({ value: null });
  });
});

describe("realtime", () => {
  it("shows the goals of the last half hour and what happened, newest first", async () => {
    const r = await json(await app.admin("/api/v1/realtime?site=shop"));
    expect(r.goals.find((g: { name: string }) => g.name === "Bought").visits).toBe(2);
    expect(r.feed.map((e: { at: string }) => e.at)).toEqual(
      r.feed
        .map((e: { at: string }) => e.at)
        .sort()
        .reverse(),
    );
    expect(r.feed).toContainEqual(expect.objectContaining({ kind: "goal", name: "Signed up", visit: "session-signup-001" }));
    expect(
      r.feed
        .filter((e: { name: string }) => e.name === "Bought")
        .map((e: { value: number }) => e.value)
        .sort(),
    ).toEqual([1800, 3500]);
    expect(r.feed.find((e: { kind: string }) => e.kind === "visit")).toMatchObject({ path: expect.any(String) });
  });
});

describe("attribution", () => {
  it("credits the first visit, the converting one, or shares it evenly", async () => {
    const start = at();
    const v = "visitor-journey1";
    // Three visits of one visitor: from search, from a social post, then direct, which buys.
    const visit = async (n: number, referrer: string | null, events: unknown[] = []) => {
      app.clock.advance(2 * 3_600_000);
      await app.collect({
        site: "shop",
        visitor: v,
        session: `session-journey-${n}`,
        events: [{ type: "pageview", url: `${SHOP}/`, ...(referrer && { referrer }) }, ...events],
      });
    };
    await visit(1, "https://www.google.com/");
    await visit(2, "https://t.co/x");
    await visit(3, null, [{ type: "event", url: `${SHOP}/`, name: "purchase", order: "J-1", value: 300 }]);
    const r = await json(await app.admin("/api/v1/attribution?site=shop&days=7&goal=Bought"));
    const row = (c: string) => r.rows.find((x: { value: string }) => x.value === c);
    expect(r.conversions).toBe(3);
    expect(row("organic-search")).toMatchObject({ first: 2, last: 1 });
    expect(row("social")).toMatchObject({ first: 0, last: 0, linear: 0.33, linearValue: 100 });
    expect(row("direct")).toMatchObject({ first: 0, last: 1, lastValue: 300 });
    expect(r.medianVisits).toBe(1);
    const bySource = await json(await app.admin("/api/v1/attribution?site=shop&days=7&goal=Bought&by=source"));
    expect(bySource.rows.map((x: { value: string | null }) => x.value)).toContain("t.co");
    expect((await app.admin("/api/v1/attribution?site=shop&goal=Nope")).status).toBe(404);
    void start;
  });
});
