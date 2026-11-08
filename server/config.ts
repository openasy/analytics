// The sites Analytics measures, from one YAML file (ANALYTICS_CONFIG). As with the install's endpoints file, the file
// is the only way in: no screen or API route adds, changes or removes a site. It is applied whole or not at all, read
// again within a minute of a change, and a file with a mistake leaves the last good version in place.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { parse } from "yaml";
import { CHANNELS, channelId, type OwnChannels } from "./channels.ts";

export interface Goal {
  name: string;
  /** A path pattern, `*` matching any characters, such as /checkout/done or /blog/*. */
  path: string | null;
  /** The name of an event sent with openasy.track(). */
  event: string | null;
  /** A file downloaded from a link, by its path or address pattern, such as /files/guide.pdf or *.pdf. */
  download: string | null;
  /**
   * What a conversion is worth: a fixed amount, or a number property of the goal's event (`value` is an ecommerce
   * event's order value). Null when the goal has no value.
   */
  value: { amount: number } | { prop: string } | null;
}

/** One step of a funnel: a page view whose path matches, or one of the site's own events. */
export interface FunnelStep {
  name: string;
  path: string | null;
  event: string | null;
}

/** Steps a visit takes in order, such as pricing, the sign-up form and signing up. */
export interface Funnel {
  name: string;
  steps: FunnelStep[];
}

export interface Site {
  /** Unique in the file; the script is served at /s/<name>.js. */
  name: string;
  /** The origins the script may send from, such as https://www.example.com. */
  domains: string[];
  /** none: measure from the first page. required: nothing is sent or stored until the site calls openasy.consent(true). */
  consent: "none" | "required";
  goals: Goal[];
  /** Query parameters kept besides utm_*. Every other one is dropped before anything is stored. */
  query: string[];
  /** Path patterns that are not recorded at all. */
  ignore: string[];
  /** Days events and visits are kept, and days the daily totals are kept. */
  keep: { events: number; days: number };
  /** Events a minute the site may send, or null for the install's default. */
  rateLimit: number | null;
  /** The environment variable holding the key for events sent from the site's servers; never the key itself. */
  serverKey: string | null;
  funnels: Funnel[];
  /** Whether the script reports which form fields are entered and left: their names and types, never what they hold. */
  forms: boolean;
  /** Session replays, recorded for this share of visits (0 to 100) and kept this many days; null when off. */
  replays: { sample: number; keep: number } | null;
  /**
   * The site's own search: the query parameters that hold what was searched, such as q, on the pages that match path
   * (any page when it is not set). The term is kept, masked, as the page's search.
   */
  search: { path: string | null; params: string[] } | null;
  /** How a page that was not found is told, besides <meta name="analytics" content="404">: its title. */
  notFound: { title: string } | null;
  /** The site's own sources put in a channel before the rules, such as { email: [partner-bulten] }. */
  channels: OwnChannels;
  /** Whether the script measures Core Web Vitals (LCP, INP, CLS) of each page. */
  vitals: boolean;
  /** File endings a click on a link counts as a download for, such as pdf or zip. */
  downloads: string[];
  /** How precisely a visit's place is worked out from its IP address, which is never kept. */
  location: Precision;
  /** ISO 4217 code of the site's money, such as TRY; orders and goal values are in it. */
  currency: string | null;
  /** Whether the site sends openasy.ecommerce() calls: product views, carts, checkouts, orders and refunds. */
  ecommerce: boolean;
  /** The site's property in each search engine's tools; their keys are in the environment, never in the file. */
  searchConsole: SearchConsole;
}

export interface SearchConsole {
  /** A Search Console property: sc-domain:example.com or https://www.example.com/. */
  google: string | null;
  /** A site in Bing Webmaster Tools, by its address: https://www.example.com/. */
  bing: string | null;
  /** A host in Yandex Webmaster, by its id: https:www.example.com:443. */
  yandex: string | null;
}

export const PRECISIONS = ["city", "region", "country", "off"] as const;
export type Precision = (typeof PRECISIONS)[number];

/** The file endings GA4 counts as downloads, used when a site does not list its own. */
export const DOWNLOADS = [
  "pdf",
  "xls",
  "xlsx",
  "doc",
  "docx",
  "txt",
  "rtf",
  "csv",
  "exe",
  "key",
  "pps",
  "ppt",
  "pptx",
  "7z",
  "pkg",
  "rar",
  "gz",
  "zip",
  "avi",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "wmv",
  "mid",
  "midi",
  "mp3",
  "wav",
  "wma",
  "dmg",
  "msi",
  "deb",
  "rpm",
  "apk",
  "iso",
  "epub",
  "odt",
  "ods",
  "odp",
];

/** What the file sets for the whole install, besides the sites. */
export interface FileSettings {
  /** Proxies whose X-Forwarded-For is believed: addresses or ranges such as 10.0.0.0/8. */
  trustedProxies: string[];
  /**
   * The GeoIP database: the file, and whether DB-IP Lite city is downloaded into it monthly (update: monthly) or it is
   * used as it is (never); null to leave it to ANALYTICS_GEOIP, false when the file says geoip: off.
   */
  geoip: { database: string | null; update: "monthly" | "never" } | false | null;
  /** The mail server email reports and alerts are sent through; the password is in ANALYTICS_SMTP_PASSWORD. Null: no mail. */
  smtp: Smtp | null;
}

export interface Smtp {
  host: string;
  port: number;
  security: "none" | "starttls" | "tls";
  user: string | null;
  /** The sender, such as Analytics <analytics@example.com>. */
  from: string;
  /** The time zone reports are scheduled in, such as Europe/Istanbul. */
  timeZone: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const PARAM = /^[A-Za-z0-9_.-]{1,64}$/;
const PATTERN = /^\/[^\s]{0,255}$/;
const KEYS = [
  "name",
  "domains",
  "consent",
  "goals",
  "query",
  "ignore",
  "keep",
  "rateLimit",
  "serverKey",
  "funnels",
  "forms",
  "replays",
  "search",
  "notFound",
  "channels",
  "vitals",
  "downloads",
  "location",
  "currency",
  "ecommerce",
  "searchConsole",
];
const TOP = ["sites", "trustedProxies", "geoip", "smtp"];
const EXTENSION = /^[a-z0-9]{1,10}$/;
/** A referring host, such as news.example.com, or a utm_source value, such as partner-bulten. */
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,252}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "90d" or a number of days. */
function days(v: unknown, at: string, min: number, max: number): number {
  const m = typeof v === "number" ? [String(v), String(v)] : typeof v === "string" ? /^(\d+)\s*d?$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${at} is ${min} to ${max} days, such as ${min === 1 ? "90d" : "730d"}.`);
  return n;
}

function origin(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is an origin with https://, such as https://www.example.com (http:// only for localhost).`);
  return url.origin;
}

function list(v: unknown, at: string, max: number, ok: (s: string) => boolean, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((s) => typeof s !== "string" || !ok(s))) throw new Error(`${at} is a list of up to ${max} ${what}.`);
  return [...new Set(v as string[])];
}

/** An address or a range of addresses such as 10.0.0.0/8 or fd00::/8. */
export function isRange(v: string): boolean {
  const [ip, bits, ...rest] = v.split("/");
  const family = isIP(ip ?? "");
  if (!family || rest.length) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d{1,3}$/.test(bits) && n >= 0 && n <= (family === 4 ? 32 : 128);
}

/** Reads the file's text: the sites and the install's own settings. Throws with the field at fault. */
export function parseFile(text: string): { sites: Site[]; settings: FileSettings } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  const settings: FileSettings = { trustedProxies: [], geoip: null, smtp: null };
  if (doc === null || doc === undefined) return { sites: [], settings };
  if (!isObj(doc) || Object.keys(doc).some((k) => !TOP.includes(k)))
    throw new Error("The file holds the list sites:, and optionally trustedProxies:, geoip: and smtp:, and nothing else.");
  settings.smtp = smtpOf(doc.smtp);
  settings.trustedProxies = list(doc.trustedProxies, "trustedProxies", 50, isRange, "addresses or ranges, such as 10.0.0.0/8");
  if (doc.geoip === false || doc.geoip === "off") settings.geoip = false;
  else if (doc.geoip !== undefined && doc.geoip !== null) {
    const g = doc.geoip;
    if (!isObj(g) || Object.keys(g).some((k) => k !== "database" && k !== "update")) throw new Error("geoip is off, or a map with database and update.");
    if (g.database !== undefined && (typeof g.database !== "string" || !/^\/\S{1,511}\.mmdb$/.test(g.database)))
      throw new Error("geoip.database is the path of an .mmdb file, such as /data/geoip/dbip-city-lite.mmdb.");
    if (g.update !== undefined && g.update !== "monthly" && g.update !== "never")
      throw new Error("geoip.update is monthly (DB-IP Lite city is downloaded into the file each month) or never (the file is used as it is).");
    settings.geoip = { database: (g.database as string | undefined) ?? null, update: (g.update as "monthly" | "never" | undefined) ?? "monthly" };
  }
  return { sites: parseSites(doc.sites), settings };
}

/** Reads the file's sites. Throws with the site and field at fault, so one message says what to fix. */
export function parseConfig(text: string): Site[] {
  return parseFile(text).sites;
}

function parseSites(raw: unknown): Site[] {
  const sites = raw ?? [];
  if (!Array.isArray(sites)) throw new Error("sites must be a list.");
  if (sites.length > 200) throw new Error("sites holds at most 200 entries.");
  const seen = new Set<string>();
  return sites.map((s, i) => {
    const at = `sites[${i}]`;
    if (!isObj(s)) throw new Error(`${at} must be a map with at least name and domains.`);
    const extra = Object.keys(s).filter((k) => !KEYS.includes(k));
    if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; a site takes ${KEYS.join(", ")}.`);
    if (typeof s.name !== "string" || !NAME.test(s.name)) throw new Error(`${at}.name is required: up to 32 lowercase letters, digits and -.`);
    const name = s.name;
    // /s/replay.js and /s/heatmap.js are the product's own scripts.
    if (name === "replay" || name === "heatmap") throw new Error(`${at}.name: ${name} is taken by the product's own /s/${name}.js; pick another name.`);
    if (seen.has(name)) throw new Error(`${at}.name: ${name} is in the file twice.`);
    seen.add(name);
    const where = `${at} (${name})`;
    if (!Array.isArray(s.domains) || s.domains.length < 1 || s.domains.length > 20) throw new Error(`${where}.domains is a list of 1 to 20 origins.`);
    const domains = [...new Set(s.domains.map((d, n) => origin(d, `${where}.domains[${n}]`)))];
    if (s.consent !== undefined && s.consent !== "none" && s.consent !== "required") throw new Error(`${where}.consent is none or required.`);

    const goals: Goal[] = [];
    if (s.goals !== undefined) {
      if (!Array.isArray(s.goals) || s.goals.length > 50) throw new Error(`${where}.goals is a list of up to 50 goals.`);
      const names = new Set<string>();
      s.goals.forEach((g, n) => {
        const gat = `${where}.goals[${n}]`;
        if (!isObj(g) || Object.keys(g).some((k) => !["name", "path", "event", "download", "value"].includes(k)))
          throw new Error(`${gat} takes name, and path, event or download, and value.`);
        if (typeof g.name !== "string" || !g.name.trim() || g.name.length > 64) throw new Error(`${gat}.name is up to 64 characters.`);
        if (names.has(g.name)) throw new Error(`${gat}.name: ${g.name} is a goal twice.`);
        names.add(g.name);
        const kinds = (["path", "event", "download"] as const).filter((k) => g[k] !== undefined);
        if (kinds.length !== 1) throw new Error(`${gat} has a path, an event or a download, one of them.`);
        const kind = kinds[0]!;
        if (kind === "path" && (typeof g.path !== "string" || !PATTERN.test(g.path)))
          throw new Error(`${gat}.path starts with /, such as /checkout/done or /blog/*.`);
        if (kind === "event" && (typeof g.event !== "string" || !PARAM.test(g.event)))
          throw new Error(`${gat}.event is an event name of up to 64 letters, digits and _ . -.`);
        if (kind === "download" && (typeof g.download !== "string" || !/^(\/|\*|https:\/\/)\S{0,511}$/.test(g.download)))
          throw new Error(`${gat}.download is a file's path or address, such as /files/guide.pdf, https://cdn.example.com/app.zip or *.pdf.`);
        let value: Goal["value"] = null;
        if (typeof g.value === "number") {
          if (!Number.isFinite(g.value) || g.value < 0 || g.value > 1e9)
            throw new Error(`${gat}.value is an amount from 0 to 1000000000, or a property of its event.`);
          value = { amount: g.value };
        } else if (g.value !== undefined) {
          if (typeof g.value !== "string" || !PARAM.test(g.value))
            throw new Error(`${gat}.value is an amount, such as 150, or the name of its event's property, such as total.`);
          if (kind !== "event") throw new Error(`${gat}.value: only a goal with an event can take its value from the event; give an amount, such as 150.`);
          value = { prop: g.value };
        }
        goals.push({
          name: g.name.trim(),
          path: kind === "path" ? (g.path as string) : null,
          event: kind === "event" ? (g.event as string) : null,
          download: kind === "download" ? (g.download as string) : null,
          value,
        });
      });
    }

    let keep = { events: 90, days: 730 };
    if (s.keep !== undefined) {
      if (!isObj(s.keep) || Object.keys(s.keep).some((k) => k !== "events" && k !== "days")) throw new Error(`${where}.keep takes events and days.`);
      keep = {
        events: s.keep.events === undefined ? 90 : days(s.keep.events, `${where}.keep.events`, 1, 3650),
        days: s.keep.days === undefined ? 730 : days(s.keep.days, `${where}.keep.days`, 30, 3650),
      };
    }
    if (s.rateLimit !== undefined && (!Number.isInteger(s.rateLimit) || (s.rateLimit as number) < 1 || (s.rateLimit as number) > 1_000_000))
      throw new Error(`${where}.rateLimit is events a minute, 1 to 1000000.`);
    if (s.serverKey !== undefined && (typeof s.serverKey !== "string" || !ENV.test(s.serverKey)))
      throw new Error(`${where}.serverKey is the name of an environment variable, such as ANALYTICS_SHOP_KEY, never the key itself.`);

    const funnels: Funnel[] = [];
    if (s.funnels !== undefined) {
      if (!Array.isArray(s.funnels) || s.funnels.length > 20) throw new Error(`${where}.funnels is a list of up to 20 funnels.`);
      const names = new Set<string>();
      s.funnels.forEach((f, n) => {
        const fat = `${where}.funnels[${n}]`;
        if (!isObj(f) || Object.keys(f).some((k) => k !== "name" && k !== "steps")) throw new Error(`${fat} takes name and steps.`);
        if (typeof f.name !== "string" || !f.name.trim() || f.name.length > 64) throw new Error(`${fat}.name is up to 64 characters.`);
        if (names.has(f.name)) throw new Error(`${fat}.name: ${f.name} is a funnel twice.`);
        names.add(f.name);
        if (!Array.isArray(f.steps) || f.steps.length < 2 || f.steps.length > 10) throw new Error(`${fat}.steps is a list of 2 to 10 steps.`);
        const steps = f.steps.map((st, k) => {
          const sat = `${fat}.steps[${k}]`;
          if (!isObj(st) || Object.keys(st).some((x) => !["name", "path", "event"].includes(x)))
            throw new Error(`${sat} takes a path or an event, and a name.`);
          const hasPath = st.path !== undefined;
          if (hasPath === (st.event !== undefined)) throw new Error(`${sat} has a path or an event, not both.`);
          if (hasPath && (typeof st.path !== "string" || !PATTERN.test(st.path))) throw new Error(`${sat}.path starts with /, such as /pricing or /blog/*.`);
          if (!hasPath && (typeof st.event !== "string" || !PARAM.test(st.event)))
            throw new Error(`${sat}.event is an event name of up to 64 letters, digits and _ . -.`);
          if (st.name !== undefined && (typeof st.name !== "string" || !st.name.trim() || st.name.length > 64))
            throw new Error(`${sat}.name is up to 64 characters.`);
          const rule = (hasPath ? st.path : st.event) as string;
          return { name: typeof st.name === "string" ? st.name.trim() : rule, path: hasPath ? rule : null, event: hasPath ? null : rule };
        });
        funnels.push({ name: f.name.trim(), steps });
      });
    }
    if (s.forms !== undefined && typeof s.forms !== "boolean") throw new Error(`${where}.forms is true or false.`);
    let replays: Site["replays"] = null;
    if (s.replays !== undefined && s.replays !== false) {
      const r = s.replays === true ? {} : s.replays;
      if (!isObj(r) || Object.keys(r).some((k) => k !== "sample" && k !== "keep"))
        throw new Error(`${where}.replays is true, false, or a map with sample and keep.`);
      const m =
        typeof r.sample === "number"
          ? [String(r.sample), String(r.sample)]
          : typeof r.sample === "string"
            ? /^(\d+(?:\.\d+)?)\s*%?$/.exec(r.sample.trim())
            : null;
      const sample = r.sample === undefined ? 100 : m ? Number(m[1]) : NaN;
      if (!(sample > 0 && sample <= 100)) throw new Error(`${where}.replays.sample is the share of visits recorded, more than 0% up to 100%, such as 10%.`);
      replays = { sample, keep: r.keep === undefined ? 30 : days(r.keep, `${where}.replays.keep`, 1, 365) };
    }

    return {
      name,
      domains,
      consent: (s.consent as Site["consent"] | undefined) ?? "none",
      goals,
      query: list(s.query, `${where}.query`, 20, (q) => PARAM.test(q), "parameter names"),
      ignore: list(s.ignore, `${where}.ignore`, 50, (p) => PATTERN.test(p), "path patterns starting with /"),
      keep,
      rateLimit: (s.rateLimit as number | undefined) ?? null,
      serverKey: (s.serverKey as string | undefined) ?? null,
      funnels,
      forms: s.forms === true,
      replays,
      search: siteSearch(s.search, where),
      notFound: notFound(s.notFound, where),
      channels: ownChannels(s.channels, where),
      vitals: flag(s.vitals, `${where}.vitals`),
      downloads:
        s.downloads === false
          ? []
          : s.downloads === undefined || s.downloads === true
            ? DOWNLOADS
            : list(s.downloads, `${where}.downloads`, 100, (x) => EXTENSION.test(x.replace(/^\./, "").toLowerCase()), "file endings, such as pdf").map((x) =>
                x.replace(/^\./, "").toLowerCase(),
              ),
      location: precision(s.location, where),
      ...commerce(s, where),
      searchConsole: searchConsole(s.searchConsole, where),
    };
  });
}

/** `currency: TRY` and `ecommerce: true`; a site with ecommerce names its currency. */
function commerce(s: Record<string, unknown>, where: string): Pick<Site, "currency" | "ecommerce"> {
  if (s.currency !== undefined && (typeof s.currency !== "string" || !/^[A-Z]{3}$/.test(s.currency)))
    throw new Error(`${where}.currency is an ISO 4217 code in capitals, such as TRY, EUR or USD.`);
  const ecommerce = flag(s.ecommerce, `${where}.ecommerce`);
  if (ecommerce && !s.currency) throw new Error(`${where}.ecommerce: name the site's currency too, such as currency: TRY.`);
  return { currency: (s.currency as string | undefined) ?? null, ecommerce };
}

/** `searchConsole: { google: sc-domain:example.com, bing: https://www.example.com/, yandex: https:www.example.com:443 }`. */
function searchConsole(v: unknown, where: string): SearchConsole {
  const out: SearchConsole = { google: null, bing: null, yandex: null };
  if (v === undefined || v === null) return out;
  const at = `${where}.searchConsole`;
  if (!isObj(v) || Object.keys(v).some((k) => !["google", "bing", "yandex"].includes(k))) throw new Error(`${at} is a map with google, bing and yandex.`);
  const url = (x: unknown) => typeof x === "string" && /^https?:\/\/[a-z0-9.-]+(:\d+)?\/(\S{0,200})$/i.test(x);
  if (v.google !== undefined) {
    if (!(typeof v.google === "string" && (/^sc-domain:[a-z0-9.-]{1,253}$/i.test(v.google) || url(v.google))))
      throw new Error(`${at}.google is a Search Console property: sc-domain:example.com, or an address with its last /, such as https://www.example.com/.`);
    out.google = v.google;
  }
  if (v.bing !== undefined) {
    if (!url(v.bing)) throw new Error(`${at}.bing is the site's address in Bing Webmaster Tools, such as https://www.example.com/.`);
    out.bing = v.bing as string;
  }
  if (v.yandex !== undefined) {
    if (typeof v.yandex !== "string" || !/^https?:[a-z0-9.-]{1,253}:\d{1,5}$/i.test(v.yandex))
      throw new Error(`${at}.yandex is the host's id in Yandex Webmaster, such as https:www.example.com:443.`);
    out.yandex = v.yandex;
  }
  return out;
}

/** `smtp: { host, port, security, user, from, timeZone }`, for email reports and alerts. */
function smtpOf(v: unknown): Smtp | null {
  if (v === undefined || v === null || v === false) return null;
  const keys = ["host", "port", "security", "user", "from", "timeZone"];
  if (!isObj(v) || Object.keys(v).some((k) => !keys.includes(k))) throw new Error(`smtp is a map with ${keys.join(", ")}.`);
  if (typeof v.host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(v.host)) throw new Error("smtp.host is the mail server's name, such as mail.example.com.");
  const security = v.security ?? "starttls";
  if (security !== "none" && security !== "starttls" && security !== "tls") throw new Error("smtp.security is starttls, tls or none.");
  const port = v.port ?? (security === "tls" ? 465 : 587);
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error("smtp.port is a port, such as 587.");
  if (v.user !== undefined && (typeof v.user !== "string" || !v.user.trim() || v.user.length > 254)) throw new Error("smtp.user is the name to sign in with.");
  if (typeof v.from !== "string" || !/^[^<>\r\n]{0,100}<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v.from.trim()))
    throw new Error("smtp.from is the sender, such as Analytics <analytics@example.com>.");
  const timeZone = v.timeZone ?? "UTC";
  try {
    if (typeof timeZone !== "string") throw new Error();
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error("smtp.timeZone is a time zone, such as Europe/Istanbul.");
  }
  return {
    host: v.host,
    port: port as number,
    security,
    user: (v.user as string | undefined)?.trim() ?? null,
    from: v.from.trim(),
    timeZone: timeZone as string,
  };
}

function flag(v: unknown, at: string): boolean {
  if (v !== undefined && typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v === true;
}

/** `search: q`, `search: [q, s]` or `search: { path: /search, param: q }`. */
function siteSearch(v: unknown, where: string): Site["search"] {
  if (v === undefined || v === null || v === false) return null;
  const at = `${where}.search`;
  const m = isObj(v) ? v : { param: v };
  if (Object.keys(m).some((k) => k !== "path" && k !== "param")) throw new Error(`${at} is a parameter, a list of them, or a map with path and param.`);
  const params = typeof m.param === "string" ? [m.param] : m.param;
  const list_ = list(params, `${at}.param`, 10, (q) => PARAM.test(q), "parameter names, such as q");
  if (!list_.length) throw new Error(`${at}.param names the query parameter that holds the search, such as q.`);
  if (m.path !== undefined && (typeof m.path !== "string" || !PATTERN.test(m.path))) throw new Error(`${at}.path starts with /, such as /search.`);
  return { path: (m.path as string | undefined) ?? null, params: list_ };
}

/** `notFound: { title: Page not found }`. */
function notFound(v: unknown, where: string): Site["notFound"] {
  if (v === undefined || v === null || v === false) return null;
  const at = `${where}.notFound`;
  if (!isObj(v) || Object.keys(v).some((k) => k !== "title") || typeof v.title !== "string" || !v.title.trim() || v.title.length > 300)
    throw new Error(`${at} is a map with the title a page not found has, such as { title: Page not found }.`);
  return { title: v.title.trim() };
}

/** `channels: { email: [partner-bulten], ai: [assistant.example.com] }`. */
function ownChannels(v: unknown, where: string): OwnChannels {
  if (v === undefined || v === null) return {};
  const at = `${where}.channels`;
  if (!isObj(v)) throw new Error(`${at} is a map of channels to their sources, such as email: [partner-bulten].`);
  const out: OwnChannels = {};
  for (const [name, sources] of Object.entries(v)) {
    const id = channelId(name);
    if (!id) throw new Error(`${at}: ${name} is not a channel; one of ${CHANNELS.join(", ")}.`);
    out[id] = list(sources, `${at}.${name}`, 200, (x) => SOURCE.test(x.trim().toLowerCase()), "referring hosts or utm_source values").map((x) =>
      x
        .trim()
        .toLowerCase()
        .replace(/^www\./, ""),
    );
  }
  return out;
}

function precision(v: unknown, where: string): Precision {
  if (v === undefined) return "city";
  if (v === false) return "off";
  if (!PRECISIONS.includes(v as Precision)) throw new Error(`${where}.location is ${PRECISIONS.join(", ")}.`);
  return v as Precision;
}

/** A path pattern as a regular expression: `*` matches any characters, everything else itself. */
export function pathPattern(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  sites: number;
  /** Why the file on disk is not what is applied; the last good list stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * list to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied leaves the last
 * good list in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (sites: Site[], settings: FileSettings) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, sites: 0, error: null, warnings: [] };
  let seen = "";
  // The text of the file as it was last applied, for the Settings page.
  let applied: string | null = null;
  const read = () => {
    let text: string;
    let stamp: string;
    try {
      const st = statSync(path);
      text = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(text).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const { sites, settings } = parseFile(text);
      state.warnings = apply(sites, settings);
      applied = text;
      Object.assign(state, { appliedAt: new Date().toISOString(), sites: sites.length, error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, text: () => applied, stop: () => clearInterval(timer) };
}
