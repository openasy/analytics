import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, pathPattern, watchConfig } from "./config.ts";

describe("the sites file", () => {
  it("reads a site with every field, and fills in the defaults", () => {
    const [shop, blog] = parseConfig(`
sites:
  - name: shop
    domains: [https://www.example.com, "https://example.com/", https://www.example.com]
    consent: required
    query: [q, page]
    ignore: [/admin/*]
    keep: { events: 30d, days: 365 }
    rateLimit: 100
    serverKey: ANALYTICS_SHOP_KEY
    goals:
      - { name: Bought, path: /checkout/done }
      - { name: Signed up, event: signup }
    funnels:
      - name: Trial
        steps:
          - { name: Pricing, path: /pricing }
          - { path: /signup }
          - { name: Signed up, event: signup }
    forms: true
    replays: { sample: 10%, keep: 14d }
  - name: blog
    domains: [http://localhost:3000]
`);
    expect(shop).toEqual({
      name: "shop",
      domains: ["https://www.example.com", "https://example.com"],
      consent: "required",
      goals: [
        { name: "Bought", path: "/checkout/done", event: null },
        { name: "Signed up", path: null, event: "signup" },
      ],
      query: ["q", "page"],
      ignore: ["/admin/*"],
      keep: { events: 30, days: 365 },
      rateLimit: 100,
      serverKey: "ANALYTICS_SHOP_KEY",
      funnels: [
        {
          name: "Trial",
          steps: [
            { name: "Pricing", path: "/pricing", event: null },
            { name: "/signup", path: "/signup", event: null },
            { name: "Signed up", path: null, event: "signup" },
          ],
        },
      ],
      forms: true,
      replays: { sample: 10, keep: 14 },
    });
    expect(blog).toMatchObject({
      consent: "none",
      goals: [],
      query: [],
      keep: { events: 90, days: 730 },
      rateLimit: null,
      serverKey: null,
      funnels: [],
      forms: false,
      replays: null,
    });
    expect(parseConfig("sites: [{ name: a, domains: [https://a.example], replays: true }]")[0]!.replays).toEqual({ sample: 100, keep: 30 });
  });

  it("says which funnel, step or replay setting to fix", () => {
    const site = (extra: string) => `sites:\n  - name: shop\n    domains: [https://www.example.com]\n${extra}`;
    for (const [extra, message] of [
      ["    funnels: [{ name: Trial, steps: [{ path: /pricing }] }]", "sites[0] (shop).funnels[0].steps is a list of 2 to 10 steps."],
      [
        "    funnels: [{ name: Trial, steps: [{ path: /a, event: b }, { path: /c }] }]",
        "sites[0] (shop).funnels[0].steps[0] has a path or an event, not both.",
      ],
      [
        "    funnels: [{ name: Trial, steps: [{ path: pricing }, { path: /c }] }]",
        "sites[0] (shop).funnels[0].steps[0].path starts with /, such as /pricing or /blog/*.",
      ],
      [
        "    funnels: [{ name: T, steps: [{ path: /a }, { path: /b }] }, { name: T, steps: [{ path: /a }, { path: /b }] }]",
        "sites[0] (shop).funnels[1].name: T is a funnel twice.",
      ],
      ["    forms: yes please", "sites[0] (shop).forms is true or false."],
      ["    replays: { sample: 0 }", "sites[0] (shop).replays.sample is the share of visits recorded, more than 0% up to 100%, such as 10%."],
      ["    replays: { sample: 10%, every: 2 }", "sites[0] (shop).replays is true, false, or a map with sample and keep."],
    ] as const)
      expect(() => parseConfig(site(extra)), extra).toThrow(message);
    expect(() => parseConfig("sites: [{ name: replay, domains: [https://a.example] }]")).toThrow("taken by the product's own /s/replay.js");
  });

  it("is empty when the file is", () => {
    expect(parseConfig("")).toEqual([]);
    expect(parseConfig("sites: []")).toEqual([]);
  });

  it("says which site and field to fix", () => {
    const cases: Array<[string, RegExp]> = [
      ["sites: [{", /Not valid YAML/],
      ["endpoints: []", /one list, sites:/],
      ["sites: {}", /sites must be a list/],
      ["sites: [{ name: Shop, domains: [https://a.example] }]", /sites\[0\]\.name is required/],
      ["sites: [{ name: shop }]", /sites\[0\] \(shop\)\.domains is a list/],
      ["sites: [{ name: shop, domains: [http://a.example] }]", /domains\[0\] is an origin with https/],
      ["sites: [{ name: shop, domains: [https://a.example/shop] }]", /domains\[0\] is an origin/],
      ["sites: [{ name: shop, domains: [https://a.example], owner: me }]", /unknown owner/],
      ["sites: [{ name: shop, domains: [https://a.example] }, { name: shop, domains: [https://b.example] }]", /shop is in the file twice/],
      ["sites: [{ name: shop, domains: [https://a.example], consent: maybe }]", /consent is none or required/],
      ["sites: [{ name: shop, domains: [https://a.example], goals: [{ name: x, path: /a, event: b }] }]", /a path or an event, not both/],
      ["sites: [{ name: shop, domains: [https://a.example], goals: [{ name: x, path: checkout }] }]", /path starts with \//],
      ["sites: [{ name: shop, domains: [https://a.example], keep: { events: 0 } }]", /keep\.events is 1 to 3650 days/],
      ["sites: [{ name: shop, domains: [https://a.example], rateLimit: 1.5 }]", /rateLimit is events a minute/],
      ["sites: [{ name: shop, domains: [https://a.example], serverKey: sk_live_abc }]", /never the key itself/],
      ["sites: [{ name: shop, domains: [https://a.example], ignore: [admin] }]", /ignore is a list of up to 50 path patterns/],
    ];
    for (const [text, error] of cases) expect(() => parseConfig(text), text).toThrow(error);
  });
});

describe("path patterns", () => {
  it("match with * and nothing else", () => {
    expect(pathPattern("/blog/*").test("/blog/a/b")).toBe(true);
    expect(pathPattern("/blog/*").test("/blogs")).toBe(false);
    expect(pathPattern("/a.b").test("/axb")).toBe(false);
    expect(pathPattern("/checkout/done").test("/checkout/done")).toBe(true);
  });
});

describe("watching the file", () => {
  it("applies a good file, keeps it when the next one is wrong, and says why", () => {
    const path = join(mkdtempSync(join(tmpdir(), "analytics-")), "analytics.yaml");
    writeFileSync(path, "sites: [{ name: shop, domains: [https://a.example] }]");
    const applied: string[][] = [];
    const file = watchConfig(path, (sites) => (applied.push(sites.map((s) => s.name)), ["a warning"]), { everyMs: 60_000 });
    expect(file.state).toMatchObject({ sites: 1, error: null, warnings: ["a warning"] });
    expect(file.state.appliedAt).not.toBeNull();

    writeFileSync(path, "sites: [{ name: Shop }]");
    file.read();
    expect(applied).toEqual([["shop"]]);
    expect(file.state.error).toMatch(/sites\[0\]\.name/);
    expect(file.state.sites).toBe(1);

    writeFileSync(path, "sites: [{ name: shop, domains: [https://a.example] }, { name: blog, domains: [https://b.example] }]");
    file.read();
    expect(applied).toEqual([["shop"], ["shop", "blog"]]);
    expect(file.state).toMatchObject({ sites: 2, error: null });
    file.stop();
  });

  it("says when the file cannot be read, and applies nothing", () => {
    const file = watchConfig("/nonexistent/analytics.yaml", () => [], { everyMs: 60_000 });
    expect(file.state).toMatchObject({ appliedAt: null, error: "Cannot read /nonexistent/analytics.yaml: ENOENT" });
    file.stop();
  });
});
