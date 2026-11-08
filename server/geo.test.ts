import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { clientIp, createGeo, geoSettings, parseProxies, placeAt } from "./geo.ts";
import { city, writeMmdb } from "./test-mmdb.ts";

const db = () => writeMmdb([["203.0.113.0/24", city("DE", "Bavaria", "Munich")]]);
const dir = () => mkdtempSync(join(tmpdir(), "analytics-geo-"));
/** DB-IP Lite city, downloaded monthly into this folder. */
const dbip = (d: string) => ({ file: join(d, "dbip-city-lite.mmdb"), update: true });
const clock = () => Date.parse("2026-11-08T12:00:00Z");

/** A stand-in for download.db-ip.com: the months it has, gzipped as DB-IP serves them. */
function server(months: Record<string, Buffer | number>) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const m = /lite-(\d{4}-\d{2})\.mmdb\.gz$/.exec(url)?.[1] ?? "";
    const v = months[m];
    if (v === undefined) return new Response("not yet", { status: 404 });
    if (typeof v === "number") return new Response("down", { status: v });
    return new Response(gzipSync(v));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("the GeoIP database", () => {
  it("is downloaded into the data volume on first start, last month's when this month's is not out yet", async () => {
    const d = dir();
    const { fetch, asked } = server({ "2026-10": db() });
    const geo = createGeo({ ...dbip(d), fetch, clock });
    expect(geo.lookup("203.0.113.9")).toBeNull();
    await geo.refresh();
    expect(asked.map((u) => u.slice(-20))).toEqual(["lite-2026-11.mmdb.gz", "lite-2026-10.mmdb.gz"]);
    expect(geo.lookup("203.0.113.9")).toEqual({ country: "DE", region: "Bavaria", city: "Munich" });
    expect(geo.lookup("192.0.2.1")).toBeNull();
    expect(geo.state).toMatchObject({ enabled: true, month: "2026-10", database: "DB-IP Lite city 2026-10", error: null });
    expect(geo.state.attribution).toContain("DB-IP");
    expect(existsSync(join(d, "dbip-city-lite.mmdb"))).toBe(true);
  });

  it("is refreshed once the month's file is out, and keeps the last good one when a download fails", async () => {
    const d = dir();
    const first = server({ "2026-11": db() });
    const geo = createGeo({ ...dbip(d), fetch: first.fetch, clock });
    await geo.refresh();
    // Up to date: nothing is asked again this month.
    await geo.refresh();
    expect(first.asked).toHaveLength(1);
    const broken = server({ "2026-12": Buffer.from("not a database") });
    const next = createGeo({ ...dbip(d), fetch: broken.fetch, clock: () => Date.parse("2026-12-03T00:00:00Z") });
    expect(next.state.month).toBe("2026-11");
    await next.refresh();
    expect(next.state.error).toMatch(/Cannot download/);
    expect(next.lookup("203.0.113.9")?.city).toBe("Munich");
    const down = server({ "2026-12": 503 });
    await createGeo({ ...dbip(d), fetch: down.fetch, clock: () => Date.parse("2026-12-03T00:00:00Z") }).refresh();
    expect(createGeo({ ...dbip(d), clock }).lookup("203.0.113.9")?.city).toBe("Munich");
  });

  it("uses an install's own file as it is, and does nothing when off", async () => {
    const d = dir();
    const own = join(d, "own.mmdb");
    writeFileSync(own, db());
    const { fetch, asked } = server({});
    const geo = createGeo({ file: own, update: false, fetch, clock });
    await geo.refresh();
    expect(asked).toEqual([]);
    expect(geo.lookup("203.0.113.9")?.country).toBe("DE");
    const off = createGeo({ off: true, ...dbip(d), fetch, clock });
    await off.refresh();
    expect(off.lookup("203.0.113.9")).toBeNull();
    expect(off.state.enabled).toBe(false);
    writeFileSync(join(d, "country.mmdb"), writeMmdb([["203.0.113.0/24", city("DE", "x", "y")]], "GeoLite2-ASN"));
    expect(createGeo({ file: join(d, "country.mmdb"), update: false }).state.error).toMatch(/city database is needed/);
  });

  it("is set by the sites file's geoip:, else by ANALYTICS_GEOIP, else downloaded into the data volume", () => {
    expect(geoSettings(null, undefined, "/data")).toEqual({ file: "/data/geoip/dbip-city-lite.mmdb", update: true });
    expect(geoSettings(null, "/geo/GeoLite2-City.mmdb", "/data")).toEqual({ file: "/geo/GeoLite2-City.mmdb", update: false });
    expect(geoSettings(null, "off", "/data")).toMatchObject({ off: true });
    expect(geoSettings({ database: "/data/geo/city.mmdb", update: "monthly" }, "off", "/data")).toEqual({ file: "/data/geo/city.mmdb", update: true });
    expect(geoSettings({ database: null, update: "never" }, undefined, "/data")).toEqual({ file: "/data/geoip/dbip-city-lite.mmdb", update: false });
    expect(geoSettings(false, "/geo/x.mmdb", "/data")).toMatchObject({ off: true });
  });

  it("keeps only what the site's precision allows", () => {
    const p = { country: "DE", region: "Bavaria", city: "Munich" };
    expect(placeAt(p, "city")).toEqual(p);
    expect(placeAt(p, "region")).toEqual({ country: "DE", region: "Bavaria", city: null });
    expect(placeAt(p, "country")).toEqual({ country: "DE", region: null, city: null });
    expect(placeAt(p, "off")).toBeNull();
  });

  it("never writes an address to disk", async () => {
    const d = dir();
    const geo = createGeo({ ...dbip(d), fetch: server({ "2026-11": db() }).fetch, clock });
    await geo.refresh();
    geo.lookup("203.0.113.77");
    expect(readFileSync(join(d, "dbip-city-lite.json"), "utf8")).not.toContain("203.0.113.77");
  });
});

describe("the visitor's address", () => {
  it("is the connection's, and X-Forwarded-For only from a trusted proxy", () => {
    expect(clientIp("203.0.113.9", "198.51.100.1", [])).toBe("203.0.113.9");
    expect(clientIp("::ffff:203.0.113.9", undefined, [])).toBe("203.0.113.9");
    expect(clientIp("10.0.0.2", "198.51.100.1", ["10.0.0.0/8"])).toBe("198.51.100.1");
    // A page cannot put a made-up address in front: the last one the trusted proxies did not add is the visitor's.
    expect(clientIp("10.0.0.2", "1.2.3.4, 198.51.100.1, 10.0.0.5", ["10.0.0.0/8"])).toBe("198.51.100.1");
    expect(clientIp("172.16.0.1", "198.51.100.1", ["10.0.0.0/8"])).toBe("172.16.0.1");
    expect(clientIp("fd00::1", "2001:db8::7", ["fd00::/8"])).toBe("2001:db8::7");
    expect(clientIp("10.0.0.2", "not an address", ["10.0.0.2"])).toBe("10.0.0.2");
  });

  it("reads the trusted proxies of the environment, and says which entries it left out", () => {
    expect(parseProxies("10.0.0.0/8, 192.168.1.1 fd00::/8,bogus,10.0.0.0/33")).toEqual({
      proxies: ["10.0.0.0/8", "192.168.1.1", "fd00::/8"],
      invalid: ["bogus", "10.0.0.0/33"],
    });
  });
});
