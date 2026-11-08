// The search engines' APIs are tested against fakes that answer as their documentation shows: Google's
// searchAnalytics.query and token endpoint, Bing Webmaster's JSON GetQueryStats and GetPageStats, and Yandex
// Webmaster's /v4/user and search-queries/popular. Nothing here reaches the real services.
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalytics } from "./analytics.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { bing, engines, google, searchImporter, wcfDay, yandex } from "./searchconsole.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
type Call = { url: string; init: RequestInit };

function fake(answer: (url: URL, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  const doFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    const body = answer(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, doFetch };
}

describe("Google Search Console", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "analytics-gsc-"));
  const keyFile = join(dir, "key.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      type: "service_account",
      client_email: "analytics@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );

  it("signs in as the service account and asks a day at a time for totals, queries with their page, and pages", async () => {
    const f = fake((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return { access_token: "ya29.token", expires_in: 3599, token_type: "Bearer" };
      const body = JSON.parse(String(init.body)) as { dimensions: string[]; startDate: string };
      if (!body.dimensions.length) return { rows: [{ clicks: 30, impressions: 1000, ctr: 0.03, position: 7.5 }], responseAggregationType: "byProperty" };
      if (body.dimensions.length === 2)
        return {
          rows: [
            { keys: ["espresso beans", "https://www.example.com/products/beans"], clicks: 20, impressions: 400, ctr: 0.05, position: 3.2 },
            { keys: ["burr grinder", "https://www.example.com/products/grinder"], clicks: 4, impressions: 300, ctr: 0.013, position: 9.1 },
          ],
          responseAggregationType: "byPage",
        };
      return {
        rows: [{ keys: ["https://www.example.com/products/beans"], clicks: 22, impressions: 500, ctr: 0.044, position: 3.5 }],
        responseAggregationType: "byPage",
      };
    });
    const g = google({ ANALYTICS_GOOGLE_SERVICE_ACCOUNT: keyFile }, f.doFetch, () => NOW);
    expect(g.missing()).toBeNull();
    const rows = await g.rows("sc-domain:example.com", "2026-10-20", "2026-10-21");
    expect(rows.filter((r) => r.kind === "total")).toHaveLength(2);
    expect(rows).toContainEqual({
      day: "2026-10-20",
      kind: "query",
      query: "espresso beans",
      page: "https://www.example.com/products/beans",
      clicks: 20,
      impressions: 400,
      position: 3.2,
    });
    // One token for every call, and a JWT the service account's key signed.
    const tokenCalls = f.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/"));
    expect(tokenCalls).toHaveLength(1);
    const assertion = new URLSearchParams(String(tokenCalls[0]!.init.body)).get("assertion")!;
    const [h, p, sig] = assertion.split(".");
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({
      iss: "analytics@project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
    const q = f.calls.find((c) => c.url.includes("searchAnalytics"))!;
    expect(q.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    expect((q.init.headers as Record<string, string>).authorization).toBe("Bearer ya29.token");
    expect(JSON.parse(String(q.init.body))).toMatchObject({ startDate: "2026-10-20", endDate: "2026-10-20", rowLimit: 25000, startRow: 0 });
  });

  it("can use an OAuth refresh token instead, and says what is missing", async () => {
    expect(google({}).missing()).toMatch(/ANALYTICS_GOOGLE_SERVICE_ACCOUNT/);
    const f = fake((url) => (url.hostname === "oauth2.googleapis.com" ? { access_token: "t", expires_in: 3600 } : { responseAggregationType: "auto" }));
    const g = google(
      { ANALYTICS_GOOGLE_CLIENT_ID: "id", ANALYTICS_GOOGLE_CLIENT_SECRET: "secret", ANALYTICS_GOOGLE_REFRESH_TOKEN: "1//r" },
      f.doFetch,
      () => NOW,
    );
    expect(await g.rows("https://www.example.com/", "2026-10-21", "2026-10-21")).toEqual([]);
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0]!.init.body)))).toEqual({
      grant_type: "refresh_token",
      client_id: "id",
      client_secret: "secret",
      refresh_token: "1//r",
    });
  });

  it("says what the API answered when it refuses", async () => {
    const f = fake((url) =>
      url.hostname === "oauth2.googleapis.com"
        ? { access_token: "t", expires_in: 3600 }
        : new Response(JSON.stringify({ error: { code: 403, message: "User does not have sufficient permission for site" } }), { status: 403 }),
    );
    await expect(
      google({ ANALYTICS_GOOGLE_REFRESH_TOKEN: "r", ANALYTICS_GOOGLE_CLIENT_ID: "i", ANALYTICS_GOOGLE_CLIENT_SECRET: "s" }, f.doFetch).rows(
        "sc-domain:x.com",
        "2026-10-21",
        "2026-10-21",
      ),
    ).rejects.toThrow(/answered 403: .*sufficient permission/);
  });
});

describe("Bing Webmaster Tools", () => {
  it("reads WCF dates", () => {
    expect(wcfDay("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(wcfDay("/Date(1761091200000)/")).toBe("2025-10-22");
    expect(wcfDay("2026-10-22")).toBeNull();
  });

  it("keeps the days asked for from GetQueryStats and GetPageStats, and sums the day's totals", async () => {
    const day = (d: string) => `/Date(${Date.parse(`${d}T07:00:00Z`)}-0700)/`;
    const f = fake((url) => ({
      d: url.pathname.endsWith("GetQueryStats")
        ? [
            {
              __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
              AvgClickPosition: 3,
              AvgImpressionPosition: 4,
              Clicks: 5,
              Date: day("2026-10-20"),
              Impressions: 100,
              Query: "espresso",
            },
            {
              __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
              AvgClickPosition: 8,
              AvgImpressionPosition: 10,
              Clicks: 1,
              Date: day("2026-10-20"),
              Impressions: 50,
              Query: "grinder",
            },
            {
              __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
              AvgClickPosition: 1,
              AvgImpressionPosition: 1,
              Clicks: 9,
              Date: day("2026-09-01"),
              Impressions: 9,
              Query: "old",
            },
          ]
        : [
            {
              __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
              AvgClickPosition: 3,
              AvgImpressionPosition: 4,
              Clicks: 6,
              Date: day("2026-10-20"),
              Impressions: 150,
              Query: "https://www.example.com/",
            },
          ],
    }));
    const b = bing({ ANALYTICS_BING_API_KEY: "key" }, f.doFetch);
    const rows = await b.rows("https://www.example.com/", "2026-10-15", "2026-10-21");
    expect(f.calls[0]!.url).toBe("https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=https%3A%2F%2Fwww.example.com%2F&apikey=key");
    expect(rows.map((r) => [r.kind, r.query || r.page, r.clicks])).toEqual([
      ["query", "espresso", 5],
      ["query", "grinder", 1],
      ["page", "https://www.example.com/", 6],
      ["total", "", 6],
    ]);
    expect(rows.at(-1)!.position).toBe(6);
    expect(bing({}).missing()).toBe("ANALYTICS_BING_API_KEY");
  });
});

describe("Yandex Webmaster", () => {
  it("finds the token's user, then reads each day's popular queries", async () => {
    const f = fake((url) => {
      if (url.pathname === "/v4/user") return { user_id: 12345 };
      return {
        queries: [
          { query_id: "q1", query_text: "кофе", indicators: { TOTAL_SHOWS: 120, TOTAL_CLICKS: 12, AVG_SHOW_POSITION: 4.5 } },
          { query_id: "q2", query_text: "espresso", indicators: { TOTAL_SHOWS: 30 } },
        ],
        date_from: url.searchParams.get("date_from"),
        date_to: url.searchParams.get("date_to"),
        count: "2",
      };
    });
    const y = yandex({ ANALYTICS_YANDEX_TOKEN: "y0_token" }, f.doFetch);
    const rows = await y.rows("https:www.example.com:443", "2026-10-21", "2026-10-21");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("OAuth y0_token");
    const popular = new URL(f.calls[1]!.url);
    expect(popular.pathname).toBe("/v4/user/12345/hosts/https%3Awww.example.com%3A443/search-queries/popular");
    expect(popular.searchParams.getAll("query_indicator")).toEqual(["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION"]);
    expect(popular.searchParams.get("order_by")).toBe("TOTAL_SHOWS");
    expect(rows).toEqual([
      { day: "2026-10-21", kind: "query", query: "кофе", page: "", clicks: 12, impressions: 120, position: 4.5 },
      { day: "2026-10-21", kind: "query", query: "espresso", page: "", clicks: 0, impressions: 30, position: null },
      { day: "2026-10-21", kind: "total", query: "", page: "", clicks: 12, impressions: 150, position: 3.6 },
    ]);
  });
});

describe("the daily import and the report", () => {
  it("imports each site's engines, keeps errors per engine, and reports queries, pages and their bounce", async () => {
    const db = openDb(":memory:");
    let clock = NOW;
    const f = fake((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return { access_token: "t", expires_in: 3600 };
      if (url.hostname === "ssl.bing.com") return new Response("Unauthorized", { status: 401 });
      const body = JSON.parse(String(init.body)) as { dimensions: string[] };
      if (!body.dimensions.length) return { rows: [{ clicks: 10, impressions: 200, ctr: 0.05, position: 5 }] };
      if (body.dimensions.length === 2)
        return { rows: [{ keys: ["beans", "https://www.shop.example/beans"], clicks: 8, impressions: 100, ctr: 0.08, position: 2 }] };
      return { rows: [{ keys: ["https://www.shop.example/beans"], clicks: 9, impressions: 150, ctr: 0.06, position: 2.5 }] };
    });
    const env = { ANALYTICS_GOOGLE_CLIENT_ID: "i", ANALYTICS_GOOGLE_CLIENT_SECRET: "s", ANALYTICS_GOOGLE_REFRESH_TOKEN: "r", ANALYTICS_BING_API_KEY: "k" };
    const list = engines(env, f.doFetch, () => clock);
    const analytics = createAnalytics(db, { clock: () => clock, searchEngines: list });
    const sites = parseConfig(
      `sites: [{ name: shop, domains: ["https://www.shop.example"], searchConsole: { google: "sc-domain:shop.example", bing: "https://www.shop.example/", yandex: "https:www.shop.example:443" } }]`,
    );
    analytics.setSites(sites);
    const importer = searchImporter(db, list, () => clock);
    await importer.run(sites);
    // Thirty days the first time, up to yesterday; today is not imported yet, so the last 7 days hold 6.
    const days = db.prepare("SELECT MIN(day) AS a, MAX(day) AS b, COUNT(DISTINCT day) AS n FROM search_console WHERE engine = 'google'").get();
    expect(days).toEqual({ a: "2026-09-22", b: "2026-10-21", n: 30 });
    // A visit that entered on the page and left at once.
    db.prepare(
      "INSERT INTO sessions (site, id, visitor, started_at, last_at, entry_path, browser, os, device, engaged) VALUES ('shop', 's1', 'v1', ?, ?, '/beans', 'Chrome', 'macOS', 'desktop', 0)",
    ).run(new Date(NOW - 3_600_000).toISOString(), new Date(NOW - 3_600_000).toISOString());
    const r = analytics.searchConsole("shop", "google", { range: 7, compare: "previous" });
    expect(r.totals).toEqual({ clicks: 60, impressions: 1200, ctr: 0.05, position: 5 });
    expect(r.hidden).toBe(12);
    expect(r.queries).toEqual([{ query: "beans", page: "https://www.shop.example/beans", clicks: 48, impressions: 600, ctr: 0.08, position: 2 }]);
    expect(r.pages[0]).toMatchObject({ page: "https://www.shop.example/beans", path: "/beans", clicks: 54, entries: 1, bounceRate: 1 });
    expect("compare" in r && r.compare.totals.clicks).toBe(70);
    const status = Object.fromEntries(r.engines.map((e) => [e.engine, e]));
    expect(status.google).toMatchObject({ importedUntil: "2026-10-21", error: null, missing: null });
    expect(status.bing!.error).toMatch(/answered 401/);
    expect(status.yandex).toMatchObject({ missing: "ANALYTICS_YANDEX_TOKEN", importedUntil: null });
    // The next day asks again only from three days back.
    clock += 86_400_000;
    const before = f.calls.length;
    await importer.run(sites);
    const asked = f.calls
      .slice(before)
      .filter((c) => c.url.includes("searchAnalytics"))
      .map((c) => JSON.parse(String(c.init.body)).startDate as string);
    expect([...new Set(asked)]).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
  });
});
