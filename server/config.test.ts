import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOWNLOADS, parseConfig, parseFile, pathPattern, watchConfig } from "./config.ts";

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
        { name: "Bought", path: "/checkout/done", event: null, download: null, value: null },
        { name: "Signed up", path: null, event: "signup", download: null, value: null },
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
      search: null,
      notFound: null,
      channels: {},
      vitals: false,
      downloads: DOWNLOADS,
      location: "city",
      currency: null,
      ecommerce: false,
      searchConsole: { google: null, bing: null, yandex: null },
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
      ["endpoints: []", /holds the list sites:/],
      ["sites: {}", /sites must be a list/],
      ["sites: [{ name: Shop, domains: [https://a.example] }]", /sites\[0\]\.name is required/],
      ["sites: [{ name: shop }]", /sites\[0\] \(shop\)\.domains is a list/],
      ["sites: [{ name: shop, domains: [http://a.example] }]", /domains\[0\] is an origin with https/],
      ["sites: [{ name: shop, domains: [https://a.example/shop] }]", /domains\[0\] is an origin/],
      ["sites: [{ name: shop, domains: [https://a.example], owner: me }]", /unknown owner/],
      ["sites: [{ name: shop, domains: [https://a.example] }, { name: shop, domains: [https://b.example] }]", /shop is in the file twice/],
      ["sites: [{ name: shop, domains: [https://a.example], consent: maybe }]", /consent is none or required/],
      ["sites: [{ name: shop, domains: [https://a.example], goals: [{ name: x, path: /a, event: b }] }]", /a path, an event or a download, one of them/],
      ["sites: [{ name: shop, domains: [https://a.example], goals: [{ name: x, path: checkout }] }]", /path starts with \//],
      ["sites: [{ name: shop, domains: [https://a.example], keep: { events: 0 } }]", /keep\.events is 1 to 3650 days/],
      ["sites: [{ name: shop, domains: [https://a.example], rateLimit: 1.5 }]", /rateLimit is events a minute/],
      ["sites: [{ name: shop, domains: [https://a.example], serverKey: sk_live_abc }]", /never the key itself/],
      ["sites: [{ name: shop, domains: [https://a.example], ignore: [admin] }]", /ignore is a list of up to 50 path patterns/],
    ];
    for (const [text, error] of cases) expect(() => parseConfig(text), text).toThrow(error);
  });
});

describe("the newer settings of a site and the file", () => {
  it("reads site search, pages not found, own channels, vitals, downloads, download goals, location, proxies and geoip", () => {
    const { sites, settings } = parseFile(`
trustedProxies: [10.0.0.0/8, "fd00::/8", 192.168.1.1]
geoip:
  database: /data/geoip/dbip-city-lite.mmdb
  update: monthly
sites:
  - name: shop
    domains: [https://www.example.com]
    search: { path: /search, param: q }
    notFound: { title: Page not found }
    channels:
      Email: [partner-bulten, News.Example.com]
      AI assistants: [assistant.example]
    vitals: true
    downloads: [.PDF, zip]
    location: region
    goals:
      - { name: Brew guide, download: /files/brew-guide.pdf }
  - name: blog
    domains: [https://blog.example]
    search: [q, s]
    downloads: false
    location: false
`);
    expect(settings).toEqual({
      trustedProxies: ["10.0.0.0/8", "fd00::/8", "192.168.1.1"],
      geoip: { database: "/data/geoip/dbip-city-lite.mmdb", update: "monthly" },
      smtp: null,
    });
    expect(sites[0]).toMatchObject({
      search: { path: "/search", params: ["q"] },
      notFound: { title: "Page not found" },
      channels: { email: ["partner-bulten", "news.example.com"], ai: ["assistant.example"] },
      vitals: true,
      downloads: ["pdf", "zip"],
      location: "region",
      goals: [{ name: "Brew guide", path: null, event: null, download: "/files/brew-guide.pdf" }],
    });
    expect(sites[1]).toMatchObject({ search: { path: null, params: ["q", "s"] }, downloads: [], location: "off" });
    expect(parseFile("geoip: off\nsites: []").settings.geoip).toBe(false);
  });

  it("says which of them to fix", () => {
    const site = (extra: string) => `sites:\n  - name: shop\n    domains: [https://www.example.com]\n${extra}`;
    for (const [text, message] of [
      [site("    search: { path: search, param: q }"), "sites[0] (shop).search.path starts with /"],
      [site("    search: { path: /search }"), "sites[0] (shop).search.param names the query parameter"],
      [site("    notFound: Page not found"), "sites[0] (shop).notFound is a map with the title"],
      [site("    channels: { Pigeon: [x] }"), "sites[0] (shop).channels: Pigeon is not a channel"],
      [site("    vitals: sometimes"), "sites[0] (shop).vitals is true or false."],
      [site("    location: street"), "sites[0] (shop).location is city, region, country, off."],
      [site("    goals: [{ name: G, download: guide.pdf }]"), "sites[0] (shop).goals[0].download is a file's path or address"],
      [site("    goals: [{ name: G, path: /a, download: /b.pdf }]"), "has a path, an event or a download, one of them."],
      ["trustedProxies: [10.0.0.0/40]", "trustedProxies is a list of up to 50 addresses or ranges"],
      ["geoip: { database: dbip.mmdb }", "geoip.database is the path of an .mmdb file"],
      ["geoip: { update: weekly }", "geoip.update is monthly"],
    ] as const)
      expect(() => parseFile(text), text).toThrow(message);
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
    expect(file.text()).toBe("sites: [{ name: shop, domains: [https://a.example] }]");

    writeFileSync(path, "sites: [{ name: Shop }]");
    file.read();
    expect(applied).toEqual([["shop"]]);
    expect(file.state.error).toMatch(/sites\[0\]\.name/);
    expect(file.state.sites).toBe(1);
    // The text shown is the one applied, not the one with the mistake.
    expect(file.text()).toBe("sites: [{ name: shop, domains: [https://a.example] }]");

    writeFileSync(path, "sites: [{ name: shop, domains: [https://a.example] }, { name: blog, domains: [https://b.example] }]");
    file.read();
    expect(applied).toEqual([["shop"], ["shop", "blog"]]);
    expect(file.state).toMatchObject({ sites: 2, error: null });
    file.stop();
  });

  it("says when the file cannot be read, and applies nothing", () => {
    const file = watchConfig("/nonexistent/analytics.yaml", () => [], { everyMs: 60_000 });
    expect(file.state).toMatchObject({ appliedAt: null, error: "Cannot read /nonexistent/analytics.yaml: ENOENT" });
    expect(file.text()).toBeNull();
    file.stop();
  });
});
