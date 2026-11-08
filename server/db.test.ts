import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalytics, lastDays } from "./analytics.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "analytics-")), "nested", "analytics.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 5 });
    second.close();
  });
});

describe("migrating a database from before", () => {
  it("keeps its visits working: new columns are empty, engaged and the channel are worked out from what was kept", () => {
    const path = join(mkdtempSync(join(tmpdir(), "analytics-")), "analytics.db");
    const old = openDb(path, { until: 2 });
    const visit = old.prepare(
      `INSERT INTO sessions (site, id, visitor, started_at, last_at, entry_path, exit_path, pageviews, source, referrer, utm_source, utm_medium, browser, os, device)
       VALUES ('shop', ?, ?, ?, ?, '/', '/', ?, ?, ?, ?, ?, 'Chrome', 'macOS', 'desktop')`,
    );
    visit.run("s-1", "v-1", "2026-10-22T10:00:00.000Z", "2026-10-22T10:00:30.000Z", 1, "google.com", "https://www.google.com", null, null);
    visit.run("s-2", "v-2", "2026-10-22T11:00:00.000Z", "2026-10-22T11:00:02.000Z", 1, null, null, "news", "email");
    visit.run("s-3", "v-3", "2026-10-22T12:00:00.000Z", "2026-10-22T12:00:01.000Z", 3, null, null, null, null);
    old.prepare("INSERT INTO events (site, session, visitor, at, type, path) VALUES ('shop', 's-1', 'v-1', '2026-10-22T10:00:00.000Z', 'pageview', '/')").run();
    old.prepare("INSERT INTO days (site, day, visitors, visits, pageviews) VALUES ('shop', '2026-10-22', 3, 3, 5)").run();
    old.close();

    const db = openDb(path);
    expect(db.prepare("SELECT id, channel, engaged, country, language, is_returning FROM sessions ORDER BY id").all()).toEqual([
      { id: "s-1", channel: "organic-search", engaged: 1, country: null, language: null, is_returning: null },
      { id: "s-2", channel: "email", engaged: 0, country: null, language: null, is_returning: null },
      { id: "s-3", channel: "direct", engaged: 1, country: null, language: null, is_returning: null },
    ]);
    const analytics = createAnalytics(db, { clock: () => Date.parse("2026-10-22T13:00:00Z") });
    analytics.setSites(parseConfig("sites: [{ name: shop, domains: [https://www.shop.example] }]"));
    const r = analytics.report("shop", { range: 7, filters: [{ dimension: "country", op: "is", values: ["(none)"] }], compare: "previous" });
    expect(r.totals).toMatchObject({ visits: 3, engagedVisits: 2, newVisitors: 0, returningVisitors: 0 });
    expect(analytics.report("shop", 1).series).toEqual([{ day: "2026-10-22", visitors: 3, visits: 3, pageviews: 5 }]);
    expect(analytics.visit("shop", "s-1")).toMatchObject({
      country: null,
      channel: "organic-search",
      returning: null,
      timeline: [{ type: "pageview", lcp: null }],
    });
    db.close();
  });
});

describe("lastDays", () => {
  it("names the last days in UTC, today last", () => {
    expect(lastDays(3, Date.parse("2026-11-01T23:59:59.000Z"))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});
