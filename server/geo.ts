// Where a visit is, from its IP address, with a local copy of the DB-IP Lite city database (CC BY 4.0, MMDB). The
// address is looked up once, when a visit starts, and then forgotten: it is never stored, logged or sent anywhere.
//
// The database is downloaded into the data volume on first start and again each month, when DB-IP publishes a new one.
// The sites file's `geoip:` (or ANALYTICS_GEOIP) can point at an .mmdb file of the install's own, DB-IP or GeoLite2
// City, used as it is, or turn lookups off.
import { BlockList, isIP } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Reader, type CityResponse } from "mmdb-lib";
import { isRange, type FileSettings, type Precision } from "./config.ts";

export interface Place {
  /** ISO 3166-1 alpha-2, such as DE. */
  country: string | null;
  /** The region or state, in English, such as Bavaria. */
  region: string | null;
  city: string | null;
}

export const ATTRIBUTION = "IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0.";
export const DBIP_URL = "https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz";
export const GEOIP_FILE = "dbip-city-lite.mmdb";
/** A downloaded database is at most this large unpacked; DB-IP's city file is about 130 MB. */
const MAX_SIZE = 512 * 1024 * 1024;

/** Keeps only what the site's precision allows. */
export function placeAt(place: Place | null, precision: Precision): Place | null {
  if (!place || precision === "off") return null;
  if (precision === "country") return { country: place.country, region: null, city: null };
  if (precision === "region") return { ...place, city: null };
  return place;
}

/** What a record of the database says, in English. */
export function placeOf(record: CityResponse | null): Place | null {
  if (!record) return null;
  const country = record.country?.iso_code ?? null;
  const region = record.subdivisions?.[0]?.names?.en ?? null;
  const city = record.city?.names?.en ?? null;
  if (!country && !region && !city) return null;
  return { country: country?.toUpperCase().slice(0, 2) ?? null, region: region?.slice(0, 100) ?? null, city: city?.slice(0, 100) ?? null };
}

export interface GeoState {
  /** Whether lookups are made at all. */
  enabled: boolean;
  /** The .mmdb file, and whether DB-IP Lite city is downloaded into it monthly. */
  file: string;
  update: boolean;
  /** The database in use, such as DB-IP Lite city 2026-11, or null before one is loaded. */
  database: string | null;
  /** The month of the database, as YYYY-MM, when it was downloaded. */
  month: string | null;
  updatedAt: string | null;
  attribution: string;
  /** Why the database could not be loaded or refreshed, the last time. */
  error: string | null;
}

export interface GeoOptions {
  /** No lookups at all. */
  off?: boolean;
  /** The .mmdb file. */
  file: string;
  /** Download DB-IP Lite city into the file each month; false uses the file as it is. */
  update: boolean;
  /** The address to download from, with {month} for YYYY-MM. */
  url?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  log?: (level: "info" | "warn", msg: string, data?: Record<string, unknown>) => void;
}

/**
 * The GeoIP settings in force: the sites file's geoip: first, then ANALYTICS_GEOIP (off, or the path of a file used as
 * it is), else DB-IP Lite city downloaded monthly into the data volume.
 */
export function geoSettings(file: FileSettings["geoip"], env: string | undefined, dataDir: string): Pick<GeoOptions, "off" | "file" | "update"> {
  const fallback = join(dataDir, "geoip", GEOIP_FILE);
  if (file === false) return { off: true, file: fallback, update: false };
  if (file) return { file: file.database ?? fallback, update: file.update === "monthly" };
  const v = env?.trim();
  if (v && /^(off|false)$/i.test(v)) return { off: true, file: fallback, update: false };
  if (v) return { file: v, update: false };
  return { file: fallback, update: true };
}

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
function previousMonth(t: number) {
  const d = new Date(t);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthOf(d.getTime());
}

export function createGeo({ off = false, file, update, url = DBIP_URL, fetch: get = fetch, clock = Date.now, log = () => {} }: GeoOptions) {
  const own = !update;
  const dir = dirname(file);
  const meta = join(dir, `${basename(file, ".mmdb")}.json`);
  const state: GeoState = { enabled: !off, file, update: update && !off, database: null, month: null, updatedAt: null, attribution: ATTRIBUTION, error: null };
  let reader: Reader<CityResponse> | null = null;

  function open(path: string) {
    const r = new Reader<CityResponse>(readFileSync(path));
    if (!/city/i.test(r.metadata.databaseType)) throw new Error(`${path} is a ${r.metadata.databaseType} database; a city database is needed.`);
    return r;
  }

  /** Opens the file that is there, if any. */
  function load() {
    if (off || !existsSync(file)) return;
    try {
      reader = open(file);
      const m = own || !existsSync(meta) ? null : (JSON.parse(readFileSync(meta, "utf8")) as { month?: string; updatedAt?: string } | null);
      Object.assign(state, {
        database: own ? reader.metadata.databaseType : `DB-IP Lite city ${m?.month ?? ""}`.trim(),
        month: m?.month ?? null,
        updatedAt: m?.updatedAt ?? statSync(file).mtime.toISOString(),
        error: null,
      });
    } catch (err) {
      reader = null;
      state.error = `Cannot read ${file}: ${(err as Error).message}`;
      log("warn", "geoip database not loaded: visits are kept without a place", { file, error: state.error });
    }
  }

  async function download(month: string): Promise<boolean> {
    const res = await get(url.replace("{month}", month));
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`${url.replace("{month}", month)} answered ${res.status}`);
    const data = gunzipSync(Buffer.from(await res.arrayBuffer()), { maxOutputLength: MAX_SIZE });
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.download`;
    writeFileSync(tmp, data);
    try {
      // A file that does not open is not put in place; the last good one stays.
      open(tmp);
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    writeFileSync(meta, JSON.stringify({ month, updatedAt: new Date(clock()).toISOString() }));
    return true;
  }

  /**
   * Downloads this month's database when the one kept is older, or last month's when this month's is not out yet.
   * Safe to call daily: it does nothing until a new month's file is due.
   */
  async function refresh() {
    if (off || own) return;
    const now = clock();
    const month = monthOf(now);
    if (reader && state.month === month) return;
    try {
      let got = await download(month);
      if (!got && !reader) got = await download(previousMonth(now));
      if (got) {
        load();
        log("info", "geoip database updated", { database: state.database });
      }
    } catch (err) {
      state.error = `Cannot download the DB-IP database: ${(err as Error).message}`;
      log("warn", "geoip database not updated: the last one stays in use", { error: state.error });
    }
  }

  load();
  return {
    state,
    load,
    refresh,
    /** The place of an address, or null. The address is not kept. */
    lookup(ip: string | undefined): Place | null {
      if (!reader || !ip || !isIP(ip)) return null;
      try {
        return placeOf(reader.get(ip));
      } catch {
        return null;
      }
    },
  };
}

export type Geo = ReturnType<typeof createGeo>;

/** `::ffff:203.0.113.9` as 203.0.113.9. */
const plain = (ip: string) => (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

let cached: { key: string; list: BlockList } | null = null;
function blockList(trusted: string[]): BlockList {
  const key = trusted.join(",");
  if (cached?.key === key) return cached.list;
  const list = new BlockList();
  for (const t of trusted) {
    const [ip, bits] = t.split("/");
    const type = isIP(ip!) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(ip!, type);
    else list.addSubnet(ip!, Number(bits), type);
  }
  cached = { key, list };
  return list;
}

/**
 * The visitor's address: the connection's, or when that is one of the trusted proxies, the last address in
 * X-Forwarded-For that is not a trusted proxy. Without trusted proxies the header is ignored, so a page cannot claim
 * to be somewhere else.
 */
export function clientIp(remote: string | undefined, forwarded: string | string[] | undefined, trusted: string[]): string | undefined {
  if (!remote) return undefined;
  const addr = plain(remote);
  if (!trusted.length) return addr;
  const list = blockList(trusted);
  const isTrusted = (ip: string) => {
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? "ipv6" : "ipv4");
  };
  if (!isTrusted(addr)) return addr;
  const hops = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
    .split(",")
    .map((h) => plain(h.trim()))
    .filter((h) => isIP(h));
  for (let i = hops.length - 1; i >= 0; i--) if (!isTrusted(hops[i]!)) return hops[i];
  return hops[0] ?? addr;
}

/** ANALYTICS_TRUSTED_PROXIES: addresses and ranges separated by commas or spaces. */
export function parseProxies(value: string | undefined): { proxies: string[]; invalid: string[] } {
  const items = (value ?? "").split(/[\s,]+/).filter(Boolean);
  return { proxies: items.filter(isRange), invalid: items.filter((v) => !isRange(v)) };
}
