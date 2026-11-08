import { timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { channelOf } from "./channels.ts";
import { pathPattern, type ConfigFileState, type FileSettings, type Site } from "./config.ts";
import { placeAt, type GeoState, type Place } from "./geo.ts";
import {
  compareWindow,
  goalSql,
  scopeOf,
  SESSION_DIMENSIONS,
  sessionConditions,
  windowOf,
  type Compare,
  type Filter,
  type Scope,
  type SessionDimension,
  type Window,
} from "./query.ts";
import { attributionOf, commerceOf, type AttributeBy } from "./commerce.ts";
import { pathsOf, retentionOf, siteSearchOf } from "./journeys.ts";
import { ENGINES, searchReportOf, type Engine, type EngineId } from "./searchconsole.ts";
import { agentOf, cleanPath, cleanReferrer, ignored, isBot, mask, parseBatch, sourceOf, VisitError, type Batch } from "./visit.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "invalid-batch"
  | "forbidden-origin"
  | "not-found"
  | "rate-limited"
  | "payload-too-large"
  | "internal-error";

export class AnalyticsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, detail: string, retryAfter?: number) {
    super(detail);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const bad = (detail: string) => new AnalyticsError(422, "invalid-body", detail);
const notFound = (what: string) => new AnalyticsError(404, "not-found", `${what} does not exist.`);

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

/** The periods a report covers: today, or the last 7, 30 or 90 days, today included. */
export const RANGES = [1, 7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export function parseRange(value: string | null): Range {
  const n = value === null ? 7 : Number(value);
  if (!RANGES.includes(n as Range)) throw bad(`days is one of ${RANGES.join(", ")}.`);
  return n as Range;
}

const DAY = 86_400_000;

/** The dates (UTC) of the last n days, today last. */
export function lastDays(n: number, now: number): string[] {
  const today = Math.floor(now / DAY) * DAY;
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10));
}

export interface AnalyticsOptions {
  /** Events a minute a site may send when the file gives it no limit. */
  defaultRate?: number;
  /** The key of each environment variable a site's serverKey names; process.env in production. */
  env?: Record<string, string | undefined>;
  /** The state of the sites file, for the pages that show it. */
  fileState?: () => ConfigFileState | null;
  /** The text of the sites file as it was last applied, for the Settings page. */
  fileText?: () => string | null;
  /** The place of an IP address, from the GeoIP database; the address is not kept. */
  geo?: { lookup(ip: string | undefined): Place | null; state?: GeoState };
  /** The search engines' APIs, to say which keys are set. */
  searchEngines?: Partial<Record<EngineId, Pick<Engine, "missing">>>;
  /** For tests. */
  clock?: () => number;
}

/** What a report is asked for besides its site: the period, the filters and the period to compare with. */
export interface ReportQuery {
  range: Range;
  filters?: Filter[];
  compare?: Compare | null;
  /** The report as of this time instead of now, such as the end of yesterday for an email report. */
  at?: number;
}

/** The median of a list of numbers, or null when it is empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** A replay chunk is at most this large as the page sends it, gzipped, and the replay of one visit at most REPLAY_MAX. */
export const CHUNK_LIMIT = 2 * 1024 * 1024;
const CHUNK_RAW_LIMIT = 24 * 1024 * 1024;
const REPLAY_MAX = 32 * 1024 * 1024;
/** Three clicks on the same element within a second are a rage click: someone expected something to happen. */
const RAGE_CLICKS = 3;
const RAGE_MS = 1000;

export interface ReplayChunk {
  site: string;
  visitor: string;
  session: string;
  seq: number;
  /** The rrweb events of this chunk as a gzipped JSON array, as the page sent them. */
  data: Buffer;
  origin?: string;
  userAgent?: string;
}

export interface Ingest {
  body: unknown;
  /** The Origin header of a request from a page. */
  origin?: string;
  /** The x-analytics-key header of a request from a site's servers. */
  key?: string;
  userAgent?: string;
  /** The visitor's IP address, for its place when a visit starts. Never stored. */
  ip?: string;
}

/** What a breakdown can group by: a dimension of a visit, or pages, events, site searches, pages not found, links out and downloads. */
export const BREAKDOWNS = [...(Object.keys(SESSION_DIMENSIONS) as SessionDimension[]), "page", "event", "search", "notFound", "outbound", "download"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];

/** A visit is engaged, as GA4 counts it, when it lasted longer than 10 seconds, viewed two pages or reached a goal. */
export const ENGAGED_SECONDS = 10;
/** Thresholds of good and poor Core Web Vitals, as web.dev gives them: LCP and INP in milliseconds, CLS as a score. */
export const VITALS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] } as const;
export type Vital = keyof typeof VITALS;

/** The value at the 75th percentile, by nearest rank, of numbers sorted in order. */
export function p75(sorted: number[]): number | null {
  if (!sorted.length) return null;
  return sorted[Math.ceil(sorted.length * 0.75) - 1]!;
}

type Row = Record<string, any>;

export function createAnalytics(
  db: DatabaseSync,
  { defaultRate = 6000, env = process.env, fileState = () => null, fileText = () => null, geo, searchEngines = {}, clock = Date.now }: AnalyticsOptions = {},
) {
  let sites = new Map<string, Site>();
  let settings: FileSettings = { trustedProxies: [], geoip: null, smtp: null };
  // Events seen in the current minute, by site. Memory only: a restart gives every site a fresh minute.
  const windows = new Map<string, { start: number; count: number }>();

  const siteOf = (name: string | null | undefined) => {
    const s = name ? sites.get(name) : undefined;
    if (!s) throw notFound("The site");
    return s;
  };

  function keyMatches(site: Site, key: string): boolean {
    const expected = site.serverKey ? env[site.serverKey] : undefined;
    if (!expected) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function limit(site: Site, n: number) {
    const t = clock();
    const rate = site.rateLimit ?? defaultRate;
    const w = windows.get(site.name);
    if (!w || t - w.start >= 60_000) windows.set(site.name, { start: t, count: n });
    else if (w.count + n > rate)
      throw new AnalyticsError(429, "rate-limited", `This site may send ${rate} events a minute.`, Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000)));
    else w.count += n;
  }

  function presentSession(s: Row) {
    return {
      id: s.id as string,
      site: s.site as string,
      visitor: s.visitor as string,
      user: (s.user_id as string | null) ?? null,
      startedAt: s.started_at as string,
      lastAt: s.last_at as string,
      duration: Math.round((Date.parse(s.last_at) - Date.parse(s.started_at)) / 1000),
      pageviews: s.pageviews as number,
      events: s.events as number,
      entry: (s.entry_path as string | null) ?? null,
      exit: (s.exit_path as string | null) ?? null,
      source: (s.source as string | null) ?? null,
      referrer: (s.referrer as string | null) ?? null,
      referrerUrl: (s.referrer_url as string | null) ?? null,
      utm: {
        source: s.utm_source ?? null,
        medium: s.utm_medium ?? null,
        campaign: s.utm_campaign ?? null,
        term: s.utm_term ?? null,
        content: s.utm_content ?? null,
      } as Record<"source" | "medium" | "campaign" | "term" | "content", string | null>,
      channel: (s.channel as string | null) ?? null,
      browser: s.browser as string,
      browserVersion: (s.browser_version as string | null) ?? null,
      os: s.os as string,
      osVersion: (s.os_version as string | null) ?? null,
      device: s.device as string,
      language: (s.language as string | null) ?? null,
      timezone: (s.timezone as string | null) ?? null,
      screen: (s.screen as string | null) ?? null,
      country: (s.country as string | null) ?? null,
      region: (s.region as string | null) ?? null,
      city: (s.city as string | null) ?? null,
      returning: s.is_returning == null ? null : s.is_returning === 1,
      engaged: s.engaged === 1,
      replay: s.replay === 1,
      rage: (s.rage as number) ?? 0,
    };
  }

  function presentEvent(e: Row) {
    return {
      type: e.type as string,
      at: e.at as string,
      path: (e.path as string | null) ?? null,
      query: (e.query as string | null) ?? null,
      title: (e.title as string | null) ?? null,
      target: (e.target as string | null) ?? null,
      text: (e.text as string | null) ?? null,
      href: (e.href as string | null) ?? null,
      name: (e.name as string | null) ?? null,
      props: e.props ? (JSON.parse(e.props) as Record<string, string | number | boolean>) : null,
      duration: (e.duration as number | null) ?? null,
      scroll: (e.scroll as number | null) ?? null,
      x: (e.x as number | null) ?? null,
      y: (e.y as number | null) ?? null,
      form: (e.form as string | null) ?? null,
      field: (e.field as string | null) ?? null,
      kind: (e.kind as string | null) ?? null,
      action: (e.action as string | null) ?? null,
      filled: e.filled == null ? null : e.filled === 1,
      again: e.again == null ? null : e.again === 1,
      search: (e.search as string | null) ?? null,
      notFound: e.not_found === 1,
      referrer: (e.ref as string | null) ?? null,
      link: (e.link as string | null) ?? null,
      rage: e.rage === 1,
      dead: e.dead === 1,
      lcp: (e.lcp as number | null) ?? null,
      inp: (e.inp as number | null) ?? null,
      cls: (e.cls as number | null) ?? null,
      noResults: e.no_results === 1,
      value: (e.amount as number | null) ?? null,
      order: (e.order_id as string | null) ?? null,
    };
  }

  /** Removes everything kept about one visitor of a site; the daily totals, which name nobody, stay. */
  function forget(site: string, visitor: string): number {
    const n = db.prepare("DELETE FROM sessions WHERE site = ? AND visitor = ?").run(site, visitor).changes;
    db.prepare("DELETE FROM events WHERE site = ? AND visitor = ?").run(site, visitor);
    db.prepare("DELETE FROM visitor_days WHERE site = ? AND visitor = ?").run(site, visitor);
    db.prepare("DELETE FROM replay_chunks WHERE site = ? AND visitor = ?").run(site, visitor);
    db.prepare("DELETE FROM orders WHERE site = ? AND visitor = ?").run(site, visitor);
    db.prepare("DELETE FROM items WHERE site = ? AND visitor = ?").run(site, visitor);
    return Number(n);
  }

  /** Whether an event reaches one of the site's goals. */
  const goalHit = (site: Site, type: string, path: string, name: string | null, download: string | null) =>
    site.goals.some((g) =>
      g.path
        ? type === "pageview" && pathPattern(g.path).test(path)
        : g.download
          ? download !== null && pathPattern(g.download).test(download)
          : type === "event" && g.event === name,
    );

  function store(site: Site, batch: Batch, userAgent: string, trusted: boolean, ip?: string): { accepted: number; dropped: number } {
    let accepted = 0;
    let dropped = 0;
    let engaged = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      let s = db.prepare("SELECT * FROM sessions WHERE site = ? AND id = ?").get(site.name, batch.session) as Row | undefined;
      // A session belongs to the visitor that started it; another visitor's events under its id are not theirs.
      if (s && s.visitor !== batch.visitor) {
        db.exec("COMMIT");
        return { accepted: 0, dropped: batch.events.length };
      }
      for (const e of batch.events) {
        const a = e.address;
        if (!a || (!trusted && !site.domains.includes(a.origin)) || ignored(site, a.path)) {
          dropped++;
          continue;
        }
        const day = e.at.slice(0, 10);
        if (e.commerce) {
          // Ecommerce only on sites that say so, in the site's currency, and each order once.
          if (!site.ecommerce || (e.commerce.currency && e.commerce.currency !== site.currency)) {
            dropped++;
            continue;
          }
          if (e.name === "refund") {
            if (refund(site, batch, e, trusted)) accepted++;
            else dropped++;
            continue;
          }
          if (e.name === "purchase" && db.prepare("SELECT 1 FROM orders WHERE site = ? AND id = ?").get(site.name, e.commerce.order)) {
            dropped++;
            continue;
          }
        }
        // A click the page sent before it knew the click was dead, sent again marked: the first one is marked instead.
        if (s && e.type === "click" && e.dead) {
          const sent = db
            .prepare("SELECT id FROM events WHERE site = ? AND session = ? AND type = 'click' AND at = ? AND target IS ? LIMIT 1")
            .get(site.name, batch.session, e.at, e.target) as Row | undefined;
          if (sent) {
            db.prepare("UPDATE events SET dead = 1 WHERE id = ?").run(sent.id as number);
            accepted++;
            continue;
          }
        }
        if (!s) {
          const agent = agentOf(userAgent);
          // The place is worked out from the address now, to the site's precision; the address itself is not kept.
          // Events from a site's servers come from the servers' address, so they have none.
          const place = trusted ? null : placeAt(geo?.lookup(ip) ?? null, site.location);
          const before = db.prepare("SELECT 1 FROM sessions WHERE site = ? AND visitor = ? LIMIT 1").get(site.name, batch.visitor);
          db.prepare(
            `INSERT INTO sessions (site, id, visitor, user_id, started_at, last_at, browser, os, device, browser_version, os_version, country, region, city, is_returning, channel)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'direct')`,
          ).run(
            site.name,
            batch.session,
            batch.visitor,
            batch.user,
            e.at,
            e.at,
            agent.browser,
            agent.os,
            agent.device,
            agent.browserVersion,
            agent.osVersion,
            place?.country ?? null,
            place?.region ?? null,
            place?.city ?? null,
            before ? 1 : 0,
          );
          db.prepare("INSERT INTO days (site, day, visits) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET visits = visits + 1").run(site.name, day);
          s = db.prepare("SELECT * FROM sessions WHERE site = ? AND id = ?").get(site.name, batch.session) as Row;
        }
        let notFoundRef: string | null = null;
        if (e.type === "pageview") {
          // The first page of a visit says where it came from; later pages only move its exit.
          if (s.pageviews === 0) {
            const source = sourceOf(e.referrer, site);
            const channel = channelOf({ source, utm: a.utm, paidClick: a.paidClick }, site.channels);
            db.prepare(
              `UPDATE sessions SET entry_path = ?, source = ?, referrer = ?, referrer_url = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?,
                 utm_term = ?, utm_content = ?, paid_click = ?, channel = ?, language = ?, timezone = ?, screen = ? WHERE site = ? AND id = ?`,
            ).run(
              a.path,
              source,
              source && e.referrer ? (URL.parse(e.referrer)?.origin ?? null) : null,
              source ? cleanReferrer(e.referrer) : null,
              a.utm.source,
              a.utm.medium,
              a.utm.campaign,
              a.utm.term,
              a.utm.content,
              a.paidClick ? 1 : 0,
              channel,
              e.language,
              e.timezone,
              e.screen,
              site.name,
              batch.session,
            );
          }
          // Not found: the page says so with its meta tag or openasy.notFound(), or has the title the file names.
          if (site.notFound && e.title && e.title.trim().toLowerCase() === site.notFound.title.toLowerCase()) e.notFound = true;
          if (e.notFound) notFoundRef = linkedFrom(e.referrer, site);
          db.prepare("UPDATE sessions SET pageviews = pageviews + 1, exit_path = ? WHERE site = ? AND id = ?").run(a.path, site.name, batch.session);
          db.prepare("INSERT INTO days (site, day, pageviews) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET pageviews = pageviews + 1").run(
            site.name,
            day,
          );
          s.pageviews = (s.pageviews as number) + 1;
        } else if (e.type !== "leave") {
          db.prepare("UPDATE sessions SET events = events + 1 WHERE site = ? AND id = ?").run(site.name, batch.session);
        } else if (e.notFound || e.noResults) {
          // openasy.notFound() or noResults() was called after the page view was sent: the leave of the page marks it.
          db.prepare(
            `UPDATE events SET not_found = COALESCE(?, not_found), no_results = COALESCE(?, no_results)
             WHERE id = (SELECT MAX(id) FROM events WHERE site = ? AND session = ? AND type = 'pageview' AND path = ?)`,
          ).run(e.notFound ? 1 : null, e.noResults ? 1 : null, site.name, batch.session, a.path);
        }
        const href = e.href ? cleanHref(e.href, site) : null;
        const link = e.type === "click" && e.href ? linkKind(e.href, site) : null;
        if (goalHit(site, e.type, a.path, e.name, link === "download" ? href : null)) engaged = true;
        db.prepare(
          "UPDATE sessions SET last_at = MAX(last_at, ?), started_at = MIN(started_at, ?), user_id = COALESCE(user_id, ?) WHERE site = ? AND id = ?",
        ).run(e.at, e.at, batch.user, site.name, batch.session);
        if (db.prepare("INSERT OR IGNORE INTO visitor_days (site, day, visitor) VALUES (?, ?, ?)").run(site.name, day, batch.visitor).changes)
          db.prepare("INSERT INTO days (site, day, visitors) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET visitors = visitors + 1").run(
            site.name,
            day,
          );
        let rage = false;
        if (e.type === "click" && e.target) {
          const recent = db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE site = ? AND session = ? AND type = 'click' AND target = ? AND at >= ? AND at <= ?")
            .get(site.name, batch.session, e.target, new Date(Date.parse(e.at) - RAGE_MS).toISOString(), e.at) as { n: number };
          // Counted once per burst: when the third quick click arrives.
          if (recent.n === RAGE_CLICKS - 1) {
            rage = true;
            db.prepare("UPDATE sessions SET rage = rage + 1 WHERE site = ? AND id = ?").run(site.name, batch.session);
          }
        }
        db.prepare(
          `INSERT INTO events (site, session, visitor, at, type, path, query, title, target, text, href, name, props, duration, scroll, x, y, form, field, kind, action, filled, again,
             search, not_found, ref, link, rage, dead, lcp, inp, cls, no_results, amount, order_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          site.name,
          batch.session,
          batch.visitor,
          e.at,
          e.type,
          a.path,
          a.query,
          e.title,
          e.target,
          e.text,
          href,
          e.name,
          e.props ? JSON.stringify(e.props) : null,
          e.duration,
          e.scroll,
          e.x,
          e.y,
          e.form,
          e.field,
          e.kind,
          e.action,
          e.filled === null ? null : e.filled ? 1 : 0,
          e.again === null ? null : e.again ? 1 : 0,
          e.type === "pageview" ? a.search : null,
          e.type === "pageview" && e.notFound ? 1 : null,
          notFoundRef,
          link,
          rage ? 1 : null,
          e.type === "click" && e.dead ? 1 : null,
          e.lcp,
          e.inp,
          e.cls,
          e.type === "pageview" && e.noResults ? 1 : null,
          e.commerce?.value ?? null,
          e.commerce?.order ?? null,
        );
        if (e.commerce) {
          const c = e.commerce;
          const item = db.prepare(
            "INSERT INTO items (site, session, visitor, at, action, order_id, sku, name, category, price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          );
          for (const x of c.items) item.run(site.name, batch.session, batch.visitor, e.at, e.name, c.order, x.sku, x.name, x.category, x.price, x.quantity);
          if (e.name === "purchase")
            db.prepare("INSERT INTO orders (site, id, session, visitor, at, value, items) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              site.name,
              c.order,
              batch.session,
              batch.visitor,
              e.at,
              c.value ?? 0,
              c.items.reduce((n, x) => n + x.quantity, 0),
            );
        }
        accepted++;
      }
      // Engaged as GA4 counts it: longer than 10 seconds, two page views or more, or a goal reached.
      if (s)
        db.prepare(
          `UPDATE sessions SET engaged = 1 WHERE site = ? AND id = ? AND engaged = 0
             AND (? OR pageviews >= 2 OR (julianday(last_at) - julianday(started_at)) * 86400 > ${ENGAGED_SECONDS})`,
        ).run(site.name, batch.session, engaged ? 1 : 0);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { accepted, dropped };
  }

  /**
   * A refund of an order, whole or in part: the order is marked, and its products are counted as refunded. From a page,
   * only the visitor who bought may refund; from the site's servers, any order of the site. It starts no visit.
   */
  function refund(site: Site, batch: Batch, e: Batch["events"][number], trusted: boolean): boolean {
    const c = e.commerce!;
    const o = db.prepare("SELECT * FROM orders WHERE site = ? AND id = ?").get(site.name, c.order) as Row | undefined;
    if (!o || (!trusted && o.visitor !== batch.visitor)) return false;
    const amount = Math.min(o.value as number, (c.value ?? (o.value as number)) + ((o.refunded as number | null) ?? 0));
    db.prepare("UPDATE orders SET refunded_at = ?, refunded = ? WHERE site = ? AND id = ?").run(e.at, amount, site.name, c.order);
    const item = db.prepare(
      "INSERT INTO items (site, session, visitor, at, action, order_id, sku, name, category, price, quantity) VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?)",
    );
    for (const x of c.items) item.run(site.name, o.session, o.visitor, e.at, c.order, x.sku, x.name, x.category, x.price, x.quantity);
    return true;
  }

  /** Where a page that was not found was linked from: a page of the site by its path, another site by its address. */
  function linkedFrom(referrer: string | null, site: Site): string | null {
    const url = referrer ? URL.parse(referrer) : null;
    if (!url) return null;
    if (site.domains.includes(url.origin)) return cleanPath(url.pathname);
    return cleanReferrer(referrer);
  }

  /** A click on a link that downloads a file (by its ending, as the site lists them) or leaves for another site. */
  function linkKind(href: string, site: Site): "download" | "outbound" | null {
    const url = URL.parse(href);
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
    const ext = /\.([A-Za-z0-9]{1,10})$/.exec(url.pathname)?.[1]?.toLowerCase();
    if (ext && site.downloads.includes(ext)) return "download";
    return site.domains.includes(url.origin) ? null : "outbound";
  }

  /** A link that was clicked: the site's own as a path, another site's as its address without a query. */
  function cleanHref(href: string, site: Site): string | null {
    const url = URL.parse(href);
    if (!url) return null;
    if (url.protocol === "mailto:" || url.protocol === "tel:") return `${url.protocol}***`;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return (site.domains.includes(url.origin) ? url.pathname : url.origin + url.pathname).slice(0, 512);
  }

  const all = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];
  const get = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T;
  const and = (c: { sql: string }) => (c.sql ? ` AND ${c.sql}` : "");
  const DURATION = "(julianday(last_at) - julianday(started_at)) * 86400";

  /**
   * Runs a report over the period and, when asked, over the period to compare with, the same way: the answer holds
   * the period's report and, under compare, the other period's.
   */
  function compared<T extends object>(site: Site, q: ReportQuery, run: (w: Window, scope: Scope) => T) {
    const w = windowOf(q.range, q.at ?? clock());
    const filters = q.filters ?? [];
    const current = scoped(site, w, filters, run);
    const head = { site: site.name, days: q.range, from: w.from, to: w.to };
    if (!q.compare) return { ...head, ...current } as typeof head & T & { compare?: { period: Compare; from: string; to: string } & T };
    const cw = compareWindow(w, q.compare);
    return { ...head, ...current, compare: { period: q.compare, from: cw.from, to: cw.to, ...scoped(site, cw, filters, run) } };
  }

  /**
   * Runs a report on the visits the filters keep. With filters, those visits are worked out once into a temporary
   * table, so each of the report's queries reads the table instead of filtering again.
   */
  let scopes = 0;
  function scoped<T>(site: Site, w: Window, filters: Filter[], run: (w: Window, scope: Scope) => T): T {
    const plain = scopeOf(site.name, w, filters, site.goals);
    if (!filters.length) return run(w, plain);
    const table = `temp.scope_${++scopes}`;
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY) WITHOUT ROWID`);
    try {
      db.prepare(`INSERT INTO ${table} SELECT id FROM sessions WHERE ${plain.sessions.sql}`).run(...plain.sessions.args);
      return run(w, scopeOf(site.name, w, filters, site.goals, table));
    } finally {
      db.exec(`DROP TABLE ${table}`);
    }
  }

  /** Visitors, visits and page views of each day of the window. */
  function seriesOf(site: Site, w: Window, sc: Scope) {
    const rows = sc.filtered
      ? all<Row>(
          `SELECT substr(started_at, 1, 10) AS day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS visits, COALESCE(SUM(pageviews), 0) AS pageviews
           FROM sessions WHERE ${sc.sessions.sql} GROUP BY day`,
          ...sc.sessions.args,
        )
      : all<Row>("SELECT * FROM days WHERE site = ? AND day >= ? AND day <= ?", site.name, w.days[0]!, w.days.at(-1)!);
    const byDay = new Map(rows.map((d) => [d.day as string, d]));
    return w.days.map((day) => ({
      day,
      visitors: (byDay.get(day)?.visitors as number) ?? 0,
      visits: (byDay.get(day)?.visits as number) ?? 0,
      pageviews: (byDay.get(day)?.pageviews as number) ?? 0,
    }));
  }

  function annotationsOf(site: string, w?: Window) {
    return all<Row>(
      `SELECT * FROM annotations WHERE site = ?${w ? " AND day >= ? AND day <= ?" : ""} ORDER BY day, id`,
      site,
      ...(w ? [w.days[0]!, w.days.at(-1)!] : []),
    ).map((a) => ({
      id: a.id as number,
      site: a.site as string,
      date: a.day as string,
      text: a.text as string,
      createdAt: a.created_at as string,
      createdBy: (a.created_by as string | null) ?? null,
    }));
  }

  function reportOf(site: Site, w: Window, sc: Scope) {
    const e = sc.events();
    const p = and(sc.paths());
    const pa = sc.paths().args;
    const leave = new Map(
      all<Row>(
        `SELECT path, AVG(duration) AS duration, AVG(scroll) AS scroll FROM events WHERE ${e.sql} AND type = 'leave'${p} GROUP BY path`,
        ...e.args,
        ...pa,
      ).map((r) => [r.path as string, r]),
    );
    const top = all<Row>(
      `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
       FROM events WHERE ${e.sql} AND type = 'pageview'${p} GROUP BY path ORDER BY views DESC, path LIMIT 50`,
      ...e.args,
      ...pa,
    );
    // Titles of the pages listed only: the counting above reads the index alone.
    const titles = new Map(
      top.length
        ? all<Row>(
            `SELECT path, MAX(title) AS title FROM events WHERE ${e.sql} AND type = 'pageview' AND path IN (${top.map(() => "?").join(", ")}) GROUP BY path`,
            ...e.args,
            ...top.map((r) => r.path as string),
          ).map((r) => [r.path as string, (r.title as string | null) ?? null])
        : [],
    );
    const pages = top.map((r) => ({
      path: r.path as string,
      title: titles.get(r.path as string) ?? null,
      views: r.views as number,
      visitors: r.visitors as number,
      time: leave.get(r.path)?.duration == null ? null : Math.round(leave.get(r.path)!.duration / 1000),
      scroll: leave.get(r.path)?.scroll == null ? null : Math.round(leave.get(r.path)!.scroll),
    }));
    const events = all<Row>(
      `SELECT name, COUNT(*) AS count, COUNT(DISTINCT visitor) AS visitors FROM events
       WHERE ${e.sql} AND type = 'event' GROUP BY name ORDER BY count DESC, name LIMIT 50`,
      ...e.args,
    ).map((r) => ({ name: r.name as string, count: r.count as number, visitors: r.visitors as number }));
    const clicks = all<Row>(
      `SELECT target, text, href, COUNT(*) AS count, COUNT(DISTINCT visitor) AS visitors FROM events
       WHERE ${e.sql} AND type = 'click'${p} GROUP BY target, text, href ORDER BY count DESC LIMIT 50`,
      ...e.args,
      ...pa,
    ).map((r) => ({ target: r.target ?? null, text: r.text ?? null, href: r.href ?? null, count: r.count as number, visitors: r.visitors as number }));
    const v = visitsOf(site, w, sc);
    // Every goal in one pass: the visits that reached each.
    const terms = site.goals.map(goalSql);
    // A goal whose value comes from its event sums that property of each of its events.
    const worth = site.goals.map((g, i) =>
      g.value && "prop" in g.value
        ? {
            sql: `, SUM(CASE WHEN ${terms[i]!.sql} THEN COALESCE(json_extract(props, ?), CASE WHEN ? = 'value' THEN amount END) END) AS v${i}`,
            args: [...terms[i]!.args, `$."${g.value.prop}"`, g.value.prop],
          }
        : { sql: "", args: [] },
    );
    const reached = terms.length
      ? get<Row>(
          `SELECT ${terms.map((t, i) => `COUNT(DISTINCT CASE WHEN ${t.sql} THEN session END) AS g${i}`).join(", ")}${worth.map((w) => w.sql).join("")}
           FROM events WHERE ${e.sql} AND type IN ('pageview', 'event', 'click')`,
          ...terms.flatMap((t) => t.args),
          ...worth.flatMap((w) => w.args),
          ...e.args,
        )
      : {};
    const goals = site.goals.map((g, i) => {
      const n = (reached[`g${i}`] as number) ?? 0;
      const value = !g.value ? null : "amount" in g.value ? g.value.amount * n : Math.round(((reached[`v${i}`] as number | null) ?? 0) * 100) / 100;
      return {
        name: g.name,
        path: g.path,
        event: g.event,
        download: g.download,
        visits: n,
        rate: v.totals.visits ? n / v.totals.visits : 0,
        /** What the conversions were worth, in the site's currency; null for a goal without a value. */
        value,
      };
    });
    return { ...v, pages, events, clicks, goals, annotations: annotationsOf(site.name, w) };
  }

  /**
   * Everything a report says about the visits themselves, from one pass over them: the totals, the days when filtered,
   * and the top values of where they came from and what they ran on.
   */
  function visitsOf(site: Site, w: Window, sc: Scope) {
    const rows = db
      .prepare(
        `SELECT visitor, substr(started_at, 1, 10) AS day, ${DURATION} AS duration, pageviews, engaged, is_returning,
           entry_path, exit_path, source, channel, browser, os, device, utm_source, utm_medium, utm_campaign
         FROM sessions WHERE ${sc.sessions.sql}`,
      )
      .iterate(...sc.sessions.args) as Iterable<Row>;
    type Tally = { visits: number; visitors: Set<string> };
    const keys = ["entry_path", "exit_path", "source", "channel", "browser", "os", "device", "campaign"] as const;
    const by = Object.fromEntries(keys.map((k) => [k, new Map<string | null, Tally>()])) as Record<(typeof keys)[number], Map<string | null, Tally>>;
    const days = new Map<string, { visits: number; pageviews: number; visitors: Set<string> }>();
    const visitors = new Set<string>();
    const fresh = new Set<string>();
    const back = new Set<string>();
    let visits = 0;
    let pageviews = 0;
    let engaged = 0;
    let duration = 0;
    const add = (m: Map<string | null, Tally>, key: string | null, visitor: string) => {
      let t = m.get(key);
      if (!t) m.set(key, (t = { visits: 0, visitors: new Set() }));
      t.visits++;
      t.visitors.add(visitor);
    };
    for (const r of rows) {
      const visitor = r.visitor as string;
      visits++;
      pageviews += r.pageviews as number;
      engaged += r.engaged as number;
      duration += r.duration as number;
      visitors.add(visitor);
      if (r.is_returning === 0) fresh.add(visitor);
      if (r.is_returning === 1) back.add(visitor);
      for (const k of keys.slice(0, 7)) add(by[k], (r[k] as string | null) ?? null, visitor);
      if (r.utm_source != null || r.utm_medium != null || r.utm_campaign != null)
        add(by.campaign, JSON.stringify([r.utm_source ?? null, r.utm_medium ?? null, r.utm_campaign ?? null]), visitor);
      if (sc.filtered) {
        let d = days.get(r.day as string);
        if (!d) days.set(r.day as string, (d = { visits: 0, pageviews: 0, visitors: new Set() }));
        d.visits++;
        d.pageviews += r.pageviews as number;
        d.visitors.add(visitor);
      }
    }
    const top = (k: (typeof keys)[number], max: number) =>
      [...by[k]]
        .map(([value, t]) => ({ value, visits: t.visits, visitors: t.visitors.size }))
        .sort((a, b) => b.visits - a.visits || String(a.value ?? "").localeCompare(String(b.value ?? "")))
        .slice(0, max);
    const series = sc.filtered
      ? w.days.map((day) => ({
          day,
          visitors: days.get(day)?.visitors.size ?? 0,
          visits: days.get(day)?.visits ?? 0,
          pageviews: days.get(day)?.pageviews ?? 0,
        }))
      : seriesOf(site, w, sc);
    return {
      totals: {
        visitors: visitors.size,
        visits,
        pageviews,
        /** GA4's: the share of visits that were not engaged. */
        bounceRate: visits ? (visits - engaged) / visits : 0,
        duration: visits ? Math.round(duration / visits) : 0,
        engagedVisits: engaged,
        engagementRate: visits ? engaged / visits : 0,
        newVisitors: fresh.size,
        returningVisitors: back.size,
      },
      series,
      entries: top("entry_path", 20).map((r) => ({ path: r.value, visits: r.visits, visitors: r.visitors })),
      exits: top("exit_path", 20).map((r) => ({ path: r.value, visits: r.visits, visitors: r.visitors })),
      sources: top("source", 20).map((r) => ({ source: r.value, visits: r.visits, visitors: r.visitors })),
      channels: top("channel", 20).map((r) => ({ channel: r.value, visits: r.visits, visitors: r.visitors })),
      campaigns: top("campaign", 20).map((r) => {
        const [source, medium, campaign] = JSON.parse(r.value!) as Array<string | null>;
        return { source: source ?? null, medium: medium ?? null, campaign: campaign ?? null, visits: r.visits, visitors: r.visitors };
      }),
      browsers: top("browser", 10).map((r) => ({ name: r.value ?? "Other", visits: r.visits, visitors: r.visitors })),
      systems: top("os", 10).map((r) => ({ name: r.value ?? "Other", visits: r.visits, visitors: r.visitors })),
      devices: top("device", 3).map((r) => ({ name: r.value ?? "desktop", visits: r.visits, visitors: r.visitors })),
    };
  }

  /** The value a breakdown groups by, and the one it belongs to, such as a browser version's browser. */
  const GROUPS: Partial<Record<SessionDimension, string>> = {
    browserVersion: "browser",
    osVersion: "os",
    region: "country",
    city: "COALESCE(region || ', ', '') || COALESCE(country, '')",
  };

  function breakdownOf(sc: Scope, dimension: Breakdown, max: number) {
    const e = sc.events();
    const p = and(sc.paths());
    const pa = sc.paths().args;
    if (dimension in SESSION_DIMENSIONS) {
      const col = SESSION_DIMENSIONS[dimension as SessionDimension];
      const group = GROUPS[dimension as SessionDimension] ?? "NULL";
      return all<Row>(
        `SELECT ${col} AS value, ${group} AS grp, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS visits, COALESCE(SUM(pageviews), 0) AS count,
           AVG(engaged) AS engagement, AVG(${DURATION}) AS duration
         FROM sessions WHERE ${sc.sessions.sql} GROUP BY value, grp ORDER BY visitors DESC, visits DESC, value LIMIT ?`,
        ...sc.sessions.args,
        max,
      ).map((r) => ({
        value: (r.value as string | null) ?? null,
        group: (r.grp as string | null) || null,
        visitors: r.visitors as number,
        visits: r.visits as number,
        count: r.count as number,
        engagementRate: r.engagement as number,
        duration: Math.round(r.duration as number),
      }));
    }
    const of: Record<Exclude<Breakdown, SessionDimension>, { value: string; group: string; where: string; paths: boolean }> = {
      page: { value: "path", group: "NULL", where: "type = 'pageview'", paths: true },
      event: { value: "name", group: "NULL", where: "type = 'event'", paths: false },
      search: { value: "search", group: "NULL", where: "type = 'pageview' AND search IS NOT NULL", paths: true },
      notFound: { value: "path", group: "ref", where: "type = 'pageview' AND not_found = 1", paths: true },
      outbound: { value: "href", group: "NULL", where: "type = 'click' AND link = 'outbound'", paths: true },
      download: { value: "href", group: "NULL", where: "type = 'click' AND link = 'download'", paths: true },
    };
    const d = of[dimension as Exclude<Breakdown, SessionDimension>];
    return all<Row>(
      `SELECT ${d.value} AS value, ${d.group} AS grp, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT session) AS visits, COUNT(*) AS count
       FROM events WHERE ${e.sql} AND ${d.where}${d.paths ? p : ""} GROUP BY value, grp ORDER BY count DESC, value LIMIT ?`,
      ...e.args,
      ...(d.paths ? pa : []),
      max,
    ).map((r) => ({
      value: (r.value as string | null) ?? null,
      group: (r.grp as string | null) ?? null,
      visitors: r.visitors as number,
      visits: r.visits as number,
      count: r.count as number,
      engagementRate: null,
      duration: null,
    }));
  }

  /** Core Web Vitals at the 75th percentile, of all pages and of each page on each kind of device. */
  function vitalsOf(w: Window, sc: Scope) {
    const e = sc.events("e");
    const rows = all<Row>(
      `SELECT e.path, s.device, substr(e.at, 1, 10) AS day, e.lcp, e.inp, e.cls FROM events e JOIN sessions s ON s.site = e.site AND s.id = e.session
       WHERE ${e.sql} AND e.type = 'leave' AND (e.lcp IS NOT NULL OR e.inp IS NOT NULL OR e.cls IS NOT NULL)${and(sc.paths("e"))}`,
      ...e.args,
      ...sc.paths("e").args,
    );
    const metrics = Object.keys(VITALS) as Vital[];
    type Bucket = { samples: number } & Record<Vital, number[]>;
    const bucket = (): Bucket => ({ samples: 0, lcp: [], inp: [], cls: [] });
    const total = bucket();
    const byDevice = new Map<string, Bucket>();
    const byPage = new Map<string, Bucket & { path: string; device: string }>();
    const byDay = new Map<string, Bucket>();
    for (const r of rows) {
      const device = r.device as string;
      const key = `${r.path}\n${device}`;
      if (!byDevice.has(device)) byDevice.set(device, bucket());
      if (!byPage.has(key)) byPage.set(key, { ...bucket(), path: r.path as string, device });
      if (!byDay.has(r.day as string)) byDay.set(r.day as string, bucket());
      for (const b of [total, byDevice.get(device)!, byPage.get(key)!, byDay.get(r.day as string)!]) {
        b.samples++;
        for (const m of metrics) if (r[m] != null) b[m].push(r[m] as number);
      }
    }
    const summary = (b: Bucket) =>
      Object.fromEntries(
        metrics.map((m) => {
          const v = b[m].sort((x, y) => x - y);
          const [good, poor] = VITALS[m];
          return [
            m,
            {
              p75: p75(v),
              samples: v.length,
              good: v.length ? v.filter((x) => x <= good).length / v.length : 0,
              poor: v.length ? v.filter((x) => x > poor).length / v.length : 0,
            },
          ];
        }),
      ) as Record<Vital, { p75: number | null; samples: number; good: number; poor: number }>;
    const brief = (b: Bucket) => Object.fromEntries(metrics.map((m) => [m, p75(b[m].sort((x, y) => x - y))])) as Record<Vital, number | null>;
    return {
      totals: { samples: total.samples, ...summary(total) },
      devices: [...byDevice].map(([device, b]) => ({ device, samples: b.samples, ...summary(b) })).sort((a, b) => b.samples - a.samples),
      pages: [...byPage.values()]
        .sort((a, b) => b.samples - a.samples || a.path.localeCompare(b.path))
        .slice(0, 100)
        .map((b) => ({ path: b.path, device: b.device, samples: b.samples, ...brief(b) })),
      // The 75th percentile of each day, all devices.
      series: w.days.map((day) => {
        const b = byDay.get(day);
        return { day, samples: b?.samples ?? 0, ...(b ? brief(b) : { lcp: null, inp: null, cls: null }) };
      }),
    };
  }

  /** Rage clicks (three or more on one element within a second) and dead clicks (nothing changed), by page and element. */
  function frustrationOf(sc: Scope) {
    const e = sc.events();
    const p = and(sc.paths());
    const pa = sc.paths().args;
    const t = get<Row>(
      `SELECT COUNT(*) AS clicks, COALESCE(SUM(rage), 0) AS rage, COALESCE(SUM(dead), 0) AS dead,
         COUNT(DISTINCT CASE WHEN rage = 1 THEN session END) AS rageVisits, COUNT(DISTINCT CASE WHEN dead = 1 THEN session END) AS deadVisits
       FROM events WHERE ${e.sql} AND type = 'click'${p}`,
      ...e.args,
      ...pa,
    );
    const pages = all<Row>(
      `SELECT path, COUNT(*) AS clicks, COALESCE(SUM(rage), 0) AS rage, COALESCE(SUM(dead), 0) AS dead,
         COUNT(DISTINCT CASE WHEN rage = 1 OR dead = 1 THEN session END) AS visits
       FROM events WHERE ${e.sql} AND type = 'click'${p} GROUP BY path HAVING SUM(rage) > 0 OR SUM(dead) > 0 ORDER BY COALESCE(SUM(rage), 0) + COALESCE(SUM(dead), 0) DESC, path LIMIT 50`,
      ...e.args,
      ...pa,
    ).map((r) => ({ path: r.path as string, clicks: r.clicks as number, rage: r.rage as number, dead: r.dead as number, visits: r.visits as number }));
    const elements = all<Row>(
      `SELECT path, target, MAX(text) AS text, COUNT(*) AS clicks, COALESCE(SUM(rage), 0) AS rage, COALESCE(SUM(dead), 0) AS dead,
         COUNT(DISTINCT CASE WHEN rage = 1 OR dead = 1 THEN visitor END) AS visitors
       FROM events WHERE ${e.sql} AND type = 'click' AND (rage = 1 OR dead = 1)${p} GROUP BY path, target ORDER BY COALESCE(SUM(rage), 0) + COALESCE(SUM(dead), 0) DESC, path, target LIMIT 100`,
      ...e.args,
      ...pa,
    ).map((r) => ({
      path: r.path as string,
      target: (r.target as string | null) ?? null,
      text: (r.text as string | null) ?? null,
      // Clicks on the element that were part of a rage or a dead click; the element's other clicks are not counted here.
      rage: r.rage as number,
      dead: r.dead as number,
      visitors: r.visitors as number,
    }));
    return {
      totals: {
        clicks: t.clicks as number,
        rage: t.rage as number,
        dead: t.dead as number,
        rageVisits: t.rageVisits as number,
        deadVisits: t.deadVisits as number,
      },
      pages,
      elements,
    };
  }

  function funnelsOf(site: Site, sc: Scope) {
    const funnels = site.funnels.map((f) => ({
      f,
      match: f.steps.map((st) => (st.path ? { type: "pageview", re: pathPattern(st.path) } : { type: "event", name: st.event! })),
      reached: f.steps.map(() => 0),
      waits: f.steps.map(() => [] as number[]),
      sources: new Map<string, { entered: number; finished: number }>(),
    }));
    if (!funnels.length) return { funnels: [] };
    const sources = new Map(
      all<Row>(`SELECT id, source FROM sessions WHERE ${sc.sessions.sql}`, ...sc.sessions.args).map((r) => [r.id as string, r.source ?? null]),
    );
    // One pass over the visits' page views and events, in order: each funnel moves a pointer along its steps.
    let current = "";
    let state = funnels.map(() => ({ step: 0, at: 0 }));
    const close = () => {
      if (!current) return;
      funnels.forEach((x, i) => {
        const done = state[i]!.step;
        if (!done) return;
        const src = (sources.get(current) as string | null | undefined) ?? "Direct";
        const b = x.sources.get(src) ?? { entered: 0, finished: 0 };
        b.entered++;
        if (done === x.f.steps.length) b.finished++;
        x.sources.set(src, b);
      });
    };
    const e = sc.events();
    const rows = db
      .prepare(`SELECT session, at, type, path, name FROM events WHERE ${e.sql} AND type IN ('pageview', 'event') ORDER BY session, at, id`)
      .iterate(...e.args) as Iterable<Row>;
    for (const r of rows) {
      if (r.session !== current) {
        close();
        current = r.session as string;
        state = funnels.map(() => ({ step: 0, at: 0 }));
      }
      const t = Date.parse(r.at as string);
      funnels.forEach((x, i) => {
        const st = state[i]!;
        if (st.step === x.f.steps.length) return;
        const m = x.match[st.step]!;
        const hit = m.type === r.type && ("re" in m ? m.re!.test(r.path as string) : m.name === r.name);
        if (!hit) return;
        if (st.step > 0) x.waits[st.step]!.push((t - st.at) / 1000);
        x.reached[st.step]!++;
        st.step++;
        st.at = t;
      });
    }
    close();
    return {
      funnels: funnels.map((x) => ({
        name: x.f.name,
        steps: x.f.steps.map((st, i) => ({ ...st, visits: x.reached[i]!, median: i ? median(x.waits[i]!) : null })),
        sources: [...x.sources]
          .map(([source, b]) => ({ source, ...b }))
          .sort((a, b) => b.entered - a.entered || a.source.localeCompare(b.source))
          .slice(0, 10),
      })),
    };
  }

  function formsOf(site: Site, sc: Scope) {
    const e = sc.events();
    const forms = all<Row>(
      `SELECT form, COUNT(DISTINCT CASE WHEN action = 'start' THEN session END) AS starts,
         COUNT(DISTINCT CASE WHEN action = 'submit' THEN session END) AS submits
       FROM events WHERE ${e.sql} AND type = 'form' GROUP BY form ORDER BY starts DESC, form LIMIT 50`,
      ...e.args,
    );
    return {
      enabled: site.forms,
      forms: forms.map((f) => {
        const page = get<Row | undefined>(
          `SELECT path, COUNT(*) AS n FROM events WHERE ${e.sql} AND type = 'form' AND form = ? GROUP BY path ORDER BY n DESC LIMIT 1`,
          ...e.args,
          f.form,
        );
        const times = all<Row>(
          `SELECT (julianday(MIN(CASE WHEN action = 'submit' THEN at END)) - julianday(MIN(CASE WHEN action = 'start' THEN at END))) * 86400 AS t
           FROM events WHERE ${e.sql} AND type = 'form' AND form = ? GROUP BY session`,
          ...e.args,
          f.form,
        )
          .map((r) => r.t as number | null)
          .filter((t): t is number => t !== null && t >= 0);
        const fields = all<Row>(
          `SELECT field, MAX(kind) AS kind, COUNT(DISTINCT session) AS reached,
             COUNT(DISTINCT CASE WHEN again = 1 THEN session END) AS again
           FROM events WHERE ${e.sql} AND type = 'form' AND form = ? AND action = 'leave' AND field IS NOT NULL
           GROUP BY field ORDER BY reached DESC, MIN(at) LIMIT 50`,
          ...e.args,
          f.form,
        );
        const left = new Map(
          all<Row>(
            `SELECT field, COUNT(DISTINCT session) AS n FROM events WHERE ${e.sql} AND type = 'form' AND form = ? AND action = 'abandon' GROUP BY field`,
            ...e.args,
            f.form,
          ).map((r) => [r.field as string, r.n as number]),
        );
        return {
          form: f.form as string,
          page: (page?.path as string | undefined) ?? null,
          starts: f.starts as number,
          submits: f.submits as number,
          median: median(times),
          fields: fields.map((x) => {
            const durations = all<{ d: number }>(
              `SELECT duration AS d FROM events WHERE ${e.sql} AND type = 'form' AND form = ? AND action = 'leave' AND field = ? AND duration IS NOT NULL`,
              ...e.args,
              f.form,
              x.field,
            ).map((r) => r.d / 1000);
            return {
              field: x.field as string,
              kind: (x.kind as string | null) ?? null,
              reached: x.reached as number,
              left: left.get(x.field as string) ?? 0,
              time: median(durations),
              again: x.reached ? (x.again as number) / (x.reached as number) : 0,
            };
          }),
        };
      }),
    };
  }

  function heatmapOf(site: Site, sc: Scope, path: string, device?: string) {
    const e = sc.events("e");
    const join = device ? "JOIN sessions s ON s.site = e.site AND s.id = e.session AND s.device = ?" : "";
    const args: SQLInputValue[] = device ? [device, ...e.args, path] : [...e.args, path];
    const points = all<Row>(
      `SELECT e.target, MIN(25 + (e.x / 50) * 50, 975) AS x, MIN(25 + (e.y / 50) * 50, 975) AS y, COUNT(*) AS count FROM events e ${join}
       WHERE ${e.sql} AND e.type = 'click' AND e.path = ? AND e.target IS NOT NULL AND e.x IS NOT NULL AND e.y IS NOT NULL
       GROUP BY e.target, e.x / 50, e.y / 50 ORDER BY count DESC LIMIT 5000`,
      ...args,
    ).map((r) => ({ target: r.target as string, x: r.x as number, y: r.y as number, count: r.count as number }));
    const elements = all<Row>(
      `SELECT e.target, MAX(e.text) AS text, COUNT(*) AS count, COUNT(DISTINCT e.visitor) AS visitors FROM events e ${join}
       WHERE ${e.sql} AND e.type = 'click' AND e.path = ? AND e.target IS NOT NULL GROUP BY e.target ORDER BY count DESC LIMIT 100`,
      ...args,
    ).map((r) => ({ target: r.target as string, text: (r.text as string | null) ?? null, count: r.count as number, visitors: r.visitors as number }));
    const depth = all<Row>(`SELECT e.scroll FROM events e ${join} WHERE ${e.sql} AND e.type = 'leave' AND e.path = ? AND e.scroll IS NOT NULL`, ...args).map(
      (r) => r.scroll as number,
    );
    const views = get<{ n: number }>(`SELECT COUNT(*) AS n FROM events e ${join} WHERE ${e.sql} AND e.type = 'pageview' AND e.path = ?`, ...args).n;
    const pe = sc.events();
    const pages = all<Row>(
      `SELECT path, COUNT(*) AS views FROM events WHERE ${pe.sql} AND type = 'pageview' GROUP BY path ORDER BY views DESC, path LIMIT 50`,
      ...pe.args,
    ).map((r) => ({ path: r.path as string, views: r.views as number }));
    return {
      path,
      device: device ?? null,
      url: site.domains[0]! + path,
      views,
      clicks: elements.reduce((n, x) => n + x.count, 0),
      elements,
      points,
      scroll: Array.from({ length: 10 }, (_, i) => ({
        depth: (i + 1) * 10,
        share: depth.length ? depth.filter((d) => d >= (i + 1) * 10 - 5).length / depth.length : 0,
      })),
      pages,
    };
  }

  return {
    /** Takes the sites from the file. Returns warnings that did not stop it from being applied. */
    setSites(list: Site[], fileSettings?: FileSettings): string[] {
      sites = new Map(list.map((s) => [s.name, s]));
      if (fileSettings) settings = fileSettings;
      for (const name of windows.keys()) if (!sites.has(name)) windows.delete(name);
      return list
        .filter((s) => s.serverKey && !env[s.serverKey])
        .map((s) => `${s.name}: serverKey names ${s.serverKey}, which is not set, so the site cannot send events from its servers.`);
    },
    sites: () => [...sites.values()],
    site: (name: string) => siteOf(name),
    /** The proxies whose X-Forwarded-For is believed, from the file. */
    trustedProxies: () => settings.trustedProxies,
    /** The mail server the file names, for email reports and alerts. */
    smtp: () => settings.smtp,

    /** Takes a batch from a page or from a site's servers. */
    ingest({ body, origin, key, userAgent = "", ip }: Ingest): { accepted: number; dropped: number } {
      const name = body && typeof body === "object" && !Array.isArray(body) ? (body as { site?: unknown }).site : undefined;
      const site = siteOf(typeof name === "string" ? name : undefined);
      const trusted = key !== undefined;
      if (trusted && !keyMatches(site, key)) throw new AnalyticsError(401, "invalid-token", "The key is not this site's server key.");
      if (!trusted && (!origin || !site.domains.includes(origin)))
        throw new AnalyticsError(403, "forbidden-origin", "Events from a page are taken only from the site's domains in the sites file.");
      const count = Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events.length || 1 : 1;
      limit(site, count);
      // Crawlers and scripts are not visitors; their batches are acknowledged and dropped.
      if (!trusted && isBot(userAgent)) return { accepted: 0, dropped: count };
      let batch: Batch;
      try {
        batch = parseBatch(body, clock, (s) => ({ query: sites.get(s)?.query ?? [], search: sites.get(s)?.search ?? null }));
      } catch (err) {
        if (err instanceof VisitError) throw new AnalyticsError(422, "invalid-batch", err.message);
        throw err;
      }
      // Consent withdrawn on the page: everything about this visitor goes.
      if (batch.events.some((e) => e.type === "forget")) {
        forget(site.name, batch.visitor);
        return { accepted: 0, dropped: batch.events.length };
      }
      return store(site, batch, userAgent, trusted, ip);
    },

    /** Everything a report page draws for one site over a period, of the visits the filters keep. */
    report(name: string, q: ReportQuery | Range) {
      const site = siteOf(name);
      return compared(site, typeof q === "number" ? { range: q } : q, (w, sc) => reportOf(site, w, sc));
    },

    /** Visits, visitors and page views by one dimension, such as country, channel or browser version. */
    breakdown(name: string, dimension: Breakdown, q: ReportQuery, max = 50) {
      const site = siteOf(name);
      return { dimension, ...compared(site, q, (_w, sc) => ({ rows: breakdownOf(sc, dimension, max) })) };
    },

    /** Core Web Vitals (LCP, INP, CLS) at the 75th percentile, overall, by kind of device and by page and device. */
    vitals(name: string, q: ReportQuery) {
      const site = siteOf(name);
      return { thresholds: VITALS, ...compared(site, q, (w, sc) => vitalsOf(w, sc)) };
    },

    /** Rage and dead clicks, by page and element. */
    frustration(name: string, q: ReportQuery) {
      const site = siteOf(name);
      return compared(site, q, (_w, sc) => frustrationOf(sc));
    },

    /**
     * Each funnel of the file over a period: how many visits reached each step, having done every step before it in
     * order, the median time from the step before, and the first to last step's conversion by source.
     */
    funnels(name: string, q: ReportQuery | Range) {
      const site = siteOf(name);
      return compared(site, typeof q === "number" ? { range: q } : q, (_w, sc) => funnelsOf(site, sc));
    },

    /**
     * Forms on a site's pages over a period: visits that started each (entered a field) and sent it, the median time
     * between, and for each field how many reached it, left the form at it, the time in it and how often it was filled
     * again. Field names and kinds only; values are never sent.
     */
    forms(name: string, q: ReportQuery | Range) {
      const site = siteOf(name);
      return compared(site, typeof q === "number" ? { range: q } : q, (_w, sc) => formsOf(site, sc));
    },

    /**
     * Where people clicked on one page and how far they read it, for the heatmap the site's script draws on the page:
     * clicks by element, each with where in it they landed on a 20 by 20 grid, and the share of views read to each
     * tenth of the page.
     */
    heatmap(name: string, path: string, q: ReportQuery | Range, device?: string) {
      const site = siteOf(name);
      return compared(site, typeof q === "number" ? { range: q } : q, (_w, sc) => heatmapOf(site, sc, path, device));
    },

    /** Orders, revenue, the purchase funnel, products and revenue by source, campaign and channel. */
    ecommerce(name: string, q: ReportQuery) {
      const site = siteOf(name);
      return compared(site, q, (w, sc) => commerceOf(db, site, w, sc));
    },

    /** Credit for a goal's conversions by first touch, last touch and linear, over each visitor's kept visits. */
    attribution(name: string, goalName: string, q: ReportQuery, lookback = 30, by: AttributeBy = "channel") {
      const site = siteOf(name);
      const goal = site.goals.find((g) => g.name === goalName);
      if (!goal) throw notFound("The goal");
      return compared(site, q, (_w, sc) => attributionOf(db, site, sc, goal, lookback, by));
    },

    /** Where visits went on from a page, or how they reached it, step by step. */
    paths(name: string, page: string, direction: "from" | "to", steps: number, q: ReportQuery) {
      const site = siteOf(name);
      return compared(site, q, (_w, sc) => pathsOf(db, sc, page, direction, steps));
    },

    /** Weekly cohorts, stickiness and new, returning and resurrected visitors. */
    retention(name: string, weeks: number, days: Range, filters: Filter[] = []) {
      const site = siteOf(name);
      return retentionOf(db, site, filters, clock(), weeks, days);
    },

    /** Site search with what came after each search: a result clicked, another search, or leaving. */
    siteSearch(name: string, q: ReportQuery) {
      const site = siteOf(name);
      return { enabled: !!site.search, ...compared(site, q, (_w, sc) => siteSearchOf(db, sc)) };
    },

    /**
     * What people searched before they came, from one search engine's tools, as imported daily: totals, queries with
     * their page and pages, and the bounce rate of the visits that entered on each page. Filters do not apply: the
     * engines know nothing of the visits.
     */
    searchConsole(name: string, engine: EngineId, q: ReportQuery) {
      const site = siteOf(name);
      const status = ENGINES.map((id) => {
        const imp = db.prepare("SELECT * FROM search_console_imports WHERE site = ? AND engine = ?").get(site.name, id) as Row | undefined;
        return {
          engine: id,
          property: site.searchConsole[id],
          missing: site.searchConsole[id] ? (searchEngines[id]?.missing() ?? null) : null,
          importedUntil: (imp?.last_day as string | null) ?? null,
          importedAt: (imp?.last_at as string | null) ?? null,
          error: (imp?.error as string | null) ?? null,
        };
      });
      const w = windowOf(q.range, q.at ?? clock());
      const run = (win: Window) => {
        const r = searchReportOf(db, site, engine, win.days[0]!, win.days.at(-1)!);
        // Search figures beside what the visits that entered on each page did: the share that were not engaged.
        const paths = r.pages.map((p) => URL.parse(p.page as string)?.pathname ?? (p.page as string));
        const bounce = new Map(
          paths.length
            ? all<Row>(
                `SELECT entry_path, AVG(1 - engaged) AS bounce, COUNT(*) AS visits FROM sessions WHERE site = ? AND started_at >= ? AND started_at < ?
                   AND entry_path IN (${paths.map(() => "?").join(", ")}) GROUP BY entry_path`,
                site.name,
                win.from,
                win.to,
                ...paths,
              ).map((x) => [x.entry_path as string, x])
            : [],
        );
        return {
          ...r,
          pages: r.pages.map((p, i) => ({
            ...p,
            path: paths[i]!,
            entries: (bounce.get(paths[i]!)?.visits as number) ?? 0,
            bounceRate: (bounce.get(paths[i]!)?.bounce as number | undefined) ?? null,
          })),
        };
      };
      const head = { site: site.name, engine, days: q.range, from: w.from, to: w.to, engines: status, ...run(w) };
      if (!q.compare) return head;
      const cw = compareWindow(w, q.compare);
      const c = run(cw);
      return { ...head, compare: { period: q.compare, from: cw.from, to: cw.to, totals: c.totals, hidden: c.hidden } };
    },

    /** Who is on the site now: visits active in the last five minutes, the page each is on, and where they came from. */
    realtime(name: string, filters: Filter[] = []) {
      const site = siteOf(name);
      const now = clock();
      const since = new Date(now - 5 * 60_000).toISOString();
      // Visits started within the day before, so the filters' window is bounded; a visit ends after 30 idle minutes.
      const w: Window = { from: new Date(now - DAY).toISOString(), to: new Date(now + DAY).toISOString(), days: [] };
      const sc = scopeOf(site.name, w, filters, site.goals);
      const active = { sql: `${sc.sessions.sql} AND last_at >= ?`, args: [...sc.sessions.args, since] };
      const t = get<Row>(`SELECT COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS visits FROM sessions WHERE ${active.sql}`, ...active.args);
      const by = (column: string, max = 20) =>
        all<Row>(
          `SELECT ${column} AS value, COUNT(DISTINCT visitor) AS visitors FROM sessions WHERE ${active.sql} GROUP BY value ORDER BY visitors DESC, value LIMIT ?`,
          ...active.args,
          max,
        ).map((r) => ({ value: (r.value as string | null) ?? null, visitors: r.visitors as number }));
      const e = sc.events();
      const minutes = new Map(
        all<Row>(
          `SELECT substr(at, 1, 16) AS minute, COUNT(*) AS n FROM events WHERE ${e.sql} AND type = 'pageview' AND at >= ? GROUP BY minute`,
          ...e.args,
          new Date(now - 30 * 60_000).toISOString(),
        ).map((r) => [r.minute as string, r.n as number]),
      );
      const pageviews = get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${e.sql} AND type = 'pageview' AND at >= ?`, ...e.args, since).n;
      const half = new Date(now - 30 * 60_000).toISOString();
      const terms = site.goals.map(goalSql);
      const reached = terms.length
        ? get<Row>(
            `SELECT ${terms.map((t, i) => `COUNT(DISTINCT CASE WHEN ${t.sql} THEN session END) AS g${i}`).join(", ")}
             FROM events WHERE ${e.sql} AND type IN ('pageview', 'event', 'click') AND at >= ?`,
            ...terms.flatMap((t) => t.args),
            ...e.args,
            half,
          )
        : {};
      // The latest of what happened, newest first: visits arriving, pages, the site's events, downloads and goals.
      const ea = sc.events("e");
      const feed = all<Row>(
        `SELECT e.session, e.at, e.type, e.path, e.name, e.href, e.link, e.amount, s.started_at, s.entry_path, s.source, s.country, s.city
         FROM events e JOIN sessions s ON s.site = e.site AND s.id = e.session
         WHERE ${ea.sql} AND e.at >= ? AND (e.type IN ('pageview', 'event') OR (e.type = 'click' AND e.link = 'download'))
         ORDER BY e.at DESC, e.id DESC LIMIT 40`,
        ...ea.args,
        half,
      ).map((r) => {
        const download = r.type === "click" ? (r.href as string | null) : null;
        const goal = site.goals.find((g) => goalHit({ ...site, goals: [g] }, r.type as string, r.path as string, r.name as string | null, download));
        const arrived = r.type === "pageview" && r.at === r.started_at;
        return {
          at: r.at as string,
          kind: goal ? "goal" : arrived ? "visit" : r.type === "pageview" ? "page" : download ? "download" : "event",
          visit: r.session as string,
          path: (r.path as string | null) ?? null,
          name: goal?.name ?? (r.type === "event" ? (r.name as string) : null),
          file: download,
          value: (r.amount as number | null) ?? null,
          source: (r.source as string | null) ?? null,
          country: (r.country as string | null) ?? null,
          city: (r.city as string | null) ?? null,
        };
      });
      return {
        site: site.name,
        at: new Date(now).toISOString(),
        visitors: t.visitors as number,
        visits: t.visits as number,
        pageviews,
        // The page each visit is on now: the last it viewed.
        pages: by("exit_path", 50).map((r) => ({ path: r.value, visitors: r.visitors })),
        channels: by("channel").map((r) => ({ channel: r.value, visitors: r.visitors })),
        sources: by("source").map((r) => ({ source: r.value, visitors: r.visitors })),
        countries: by("country").map((r) => ({ country: r.value, visitors: r.visitors })),
        devices: by("device", 3).map((r) => ({ device: r.value ?? "desktop", visitors: r.visitors })),
        // Visits that reached each goal in the last 30 minutes.
        goals: site.goals.map((g, i) => ({ name: g.name, visits: (reached[`g${i}`] as number) ?? 0 })),
        feed,
        // Page views in each of the last 30 minutes, oldest first.
        minutes: Array.from({ length: 30 }, (_, i) => {
          const minute = new Date(now - (29 - i) * 60_000).toISOString().slice(0, 16);
          return { minute: `${minute}:00.000Z`, pageviews: minutes.get(minute) ?? 0 };
        }),
      };
    },

    /** Notes on a site's timeline, of the period or all of them. */
    annotations(name: string, range?: Range) {
      const site = siteOf(name);
      return { site: site.name, annotations: annotationsOf(site.name, range ? windowOf(range, clock()) : undefined) };
    },

    addAnnotation(name: string, body: unknown, by: string | null) {
      const site = siteOf(name);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("The body is { date, text }.");
      const { date, text, ...rest } = body as Record<string, unknown>;
      if (Object.keys(rest).length) throw bad(`${Object.keys(rest).join(", ")} is not part of an annotation; it takes date and text.`);
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
        throw bad("date is a day, such as 2026-11-08.");
      if (typeof text !== "string" || !text.trim() || text.trim().length > 280) throw bad("text is 1 to 280 characters.");
      if (get<{ n: number }>("SELECT COUNT(*) AS n FROM annotations WHERE site = ?", site.name).n >= 5000)
        throw bad("A site keeps at most 5000 annotations; delete some first.");
      const id = Number(
        db
          .prepare("INSERT INTO annotations (site, day, text, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
          .run(site.name, date, text.trim(), new Date(clock()).toISOString(), by).lastInsertRowid,
      );
      return annotationsOf(site.name).find((a) => a.id === id)!;
    },

    deleteAnnotation(name: string, id: string) {
      const site = siteOf(name);
      if (!/^\d{1,15}$/.test(id) || !db.prepare("DELETE FROM annotations WHERE site = ? AND id = ?").run(site.name, Number(id)).changes)
        throw notFound("The annotation");
    },

    /** Takes a chunk of a visit's replay from the page; its text is masked before it is kept, as a batch's is. */
    replay({ site: name, visitor, session, seq, data, origin, userAgent = "" }: ReplayChunk): { accepted: boolean } {
      const site = siteOf(name);
      if (!origin || !site.domains.includes(origin))
        throw new AnalyticsError(403, "forbidden-origin", "Replays are taken only from the site's domains in the sites file.");
      if (!site.replays) throw new AnalyticsError(403, "forbidden-origin", "This site does not record replays: set replays in the sites file.");
      if (isBot(userAgent)) return { accepted: false };
      limit(site, 1);
      let text: string;
      try {
        text = gunzipSync(data, { maxOutputLength: CHUNK_RAW_LIMIT }).toString("utf8");
      } catch {
        throw new AnalyticsError(422, "invalid-batch", "A replay chunk is a gzipped JSON array of rrweb events, at most 24 MiB unpacked.");
      }
      let events: unknown;
      try {
        events = JSON.parse(text);
      } catch {
        events = null;
      }
      if (
        !Array.isArray(events) ||
        !events.length ||
        events.some((e) => !e || typeof e !== "object" || typeof e.type !== "number" || typeof e.timestamp !== "number")
      )
        throw new AnalyticsError(422, "invalid-batch", "A replay chunk is a JSON array of rrweb events, each with a type and a timestamp.");
      const used = db
        .prepare("SELECT COALESCE(SUM(size), 0) AS n, MAX(visitor) AS visitor FROM replay_chunks WHERE site = ? AND session = ?")
        .get(site.name, session) as Row;
      // A visit belongs to the visitor that started it.
      if (used.visitor && used.visitor !== visitor) return { accepted: false };
      if ((used.n as number) + data.length > REPLAY_MAX) return { accepted: false };
      // Emails, tokens and keys anywhere in the page's text or attributes are masked here too.
      const kept = gzipSync(mask(text));
      const at = new Date(Math.min(clock(), Math.max(...events.map((e) => (e as { timestamp: number }).timestamp)))).toISOString();
      db.prepare("INSERT OR IGNORE INTO replay_chunks (site, session, visitor, seq, at, size, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        site.name,
        session,
        visitor,
        seq,
        at,
        kept.length,
        kept,
      );
      db.prepare("UPDATE sessions SET replay = 1 WHERE site = ? AND id = ? AND visitor = ?").run(site.name, session, visitor);
      return { accepted: true };
    },

    /** Visits with a replay, newest first. */
    replays(name: string, range: Range, cursor: string | undefined, max: number, filters: Filter[] = []): Page<ReturnType<typeof presentSession>> {
      const site = siteOf(name);
      const w = windowOf(range, clock());
      const cond = sessionConditions(site.name, w, filters, site.goals);
      const offset = decodeCursor(cursor);
      const rows = all<Row>(
        `SELECT * FROM sessions WHERE site = ? AND replay = 1 AND last_at >= ?${and(cond)} ORDER BY last_at DESC, id LIMIT ? OFFSET ?`,
        site.name,
        w.from,
        ...cond.args,
        max + 1,
        offset,
      );
      return { items: rows.slice(0, max).map(presentSession), ...(rows.length > max && { nextCursor: encodeCursor(offset + max) }) };
    },

    /** One visit's replay: its rrweb events in order, for the player. */
    recording(name: string, id: string) {
      const site = siteOf(name);
      const s = db.prepare("SELECT * FROM sessions WHERE site = ? AND id = ?").get(site.name, id) as Row | undefined;
      const chunks = all<Row>("SELECT data FROM replay_chunks WHERE site = ? AND session = ? ORDER BY seq", site.name, id);
      if (!s || !chunks.length) throw notFound("The replay");
      const events = chunks.flatMap((c) => JSON.parse(gunzipSync(c.data as Uint8Array).toString("utf8")) as unknown[]);
      return { visit: presentSession(s), events };
    },

    /** Visits of a site, newest first, of one visitor or one user of the site if asked. */
    visits(
      filter: { site: string; visitor?: string; user?: string; range?: Range; filters?: Filter[] },
      cursor: string | undefined,
      max: number,
    ): Page<ReturnType<typeof presentSession>> {
      const site = siteOf(filter.site);
      const where = ["site = ?"];
      const args: SQLInputValue[] = [filter.site];
      if (filter.visitor) (where.push("visitor = ?"), args.push(filter.visitor));
      if (filter.user) (where.push("user_id = ?"), args.push(filter.user));
      // Without days, the filters look at everything that is kept.
      const w = filter.range ? windowOf(filter.range, clock()) : { from: "0000", to: "9999", days: [] };
      if (filter.range) (where.push("last_at >= ?"), args.push(w.from));
      const cond = sessionConditions(site.name, w, filter.filters ?? [], site.goals);
      if (cond.sql) (where.push(cond.sql), args.push(...cond.args));
      const offset = decodeCursor(cursor);
      const rows = all<Row>(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY last_at DESC, id LIMIT ? OFFSET ?`, ...args, max + 1, offset);
      return { items: rows.slice(0, max).map(presentSession), ...(rows.length > max && { nextCursor: encodeCursor(offset + max) }) };
    },

    /** One visit with everything it sent, in order. */
    visit(name: string, id: string) {
      const site = siteOf(name);
      const s = db.prepare("SELECT * FROM sessions WHERE site = ? AND id = ?").get(site.name, id) as Row | undefined;
      if (!s) throw notFound("The visit");
      return {
        ...presentSession(s),
        timeline: all<Row>("SELECT * FROM events WHERE site = ? AND session = ? ORDER BY at, id LIMIT 2000", site.name, id).map(presentEvent),
      };
    },

    /** Everything kept about a visitor, for a request under GDPR Art. 15 or KVKK Art. 11. */
    visitor(name: string, visitor: string) {
      const site = siteOf(name);
      const sessions = all<Row>("SELECT * FROM sessions WHERE site = ? AND visitor = ? ORDER BY started_at", site.name, visitor);
      if (!sessions.length) throw notFound("The visitor");
      return {
        site: site.name,
        visitor,
        exportedAt: new Date(clock()).toISOString(),
        visits: sessions.map((s) => ({
          ...presentSession(s),
          timeline: all<Row>("SELECT * FROM events WHERE site = ? AND session = ? ORDER BY at, id", site.name, s.id).map(presentEvent),
          orders: all<Row>("SELECT id, at, value, items, refunded_at, refunded FROM orders WHERE site = ? AND session = ?", site.name, s.id).map((o) => ({
            order: o.id as string,
            at: o.at as string,
            value: o.value as number,
            items: o.items as number,
            refundedAt: (o.refunded_at as string | null) ?? null,
            refunded: (o.refunded as number | null) ?? null,
          })),
          recording: all<Row>("SELECT data FROM replay_chunks WHERE site = ? AND session = ? ORDER BY seq", site.name, s.id).flatMap(
            (c) => JSON.parse(gunzipSync(c.data as Uint8Array).toString("utf8")) as unknown[],
          ),
        })),
      };
    },

    /** Deletes a visitor's visits and events, for a request under GDPR Art. 17 or KVKK Art. 11. */
    deleteVisitor(name: string, visitor: string) {
      const site = siteOf(name);
      if (!forget(site.name, visitor)) throw notFound("The visitor");
    },

    summary() {
      const day = new Date(clock() - DAY).toISOString();
      const live = new Date(clock() - 5 * 60_000).toISOString();
      const one = (sql: string, ...args: SQLInputValue[]) => (db.prepare(sql).get(...args) as { n: number | null }).n ?? 0;
      return {
        sites: sites.size,
        file: fileState(),
        visitors24h: one("SELECT COUNT(DISTINCT site || ' ' || visitor) AS n FROM sessions WHERE last_at > ?", day),
        visits24h: one("SELECT COUNT(*) AS n FROM sessions WHERE last_at > ?", day),
        pageviews24h: one("SELECT COUNT(*) AS n FROM events WHERE type = 'pageview' AND at > ?", day),
        live: one("SELECT COUNT(DISTINCT site || ' ' || visitor) AS n FROM sessions WHERE last_at > ?", live),
        lastEventAt: (db.prepare("SELECT MAX(last_at) AS t FROM sessions").get() as { t: string | null }).t,
        // The GeoIP database places come from, with the attribution its licence asks for.
        location: geo?.state ?? null,
      };
    },

    /**
     * The sites file as it was last applied, read-only, with its state. It holds no secrets: a site's serverKey names
     * the variable that holds its key, never the key.
     */
    settingsFile() {
      return { file: fileState(), yaml: fileText() };
    },

    /** The sites in the file, with what they sent today. */
    siteList(publicUrl: string) {
      const today = lastDays(1, clock())[0]!;
      return [...sites.values()].map((s) => {
        const d = db.prepare("SELECT visitors, pageviews FROM days WHERE site = ? AND day = ?").get(s.name, today) as Row | undefined;
        return {
          name: s.name,
          domains: s.domains,
          consent: s.consent,
          script: `${publicUrl}/s/${s.name}.js`,
          goals: s.goals,
          query: s.query,
          ignore: s.ignore,
          keep: s.keep,
          rateLimit: s.rateLimit ?? defaultRate,
          serverKey: s.serverKey ? { variable: s.serverKey, set: !!env[s.serverKey] } : null,
          funnels: s.funnels,
          forms: s.forms,
          replays: s.replays,
          search: s.search,
          notFound: s.notFound,
          channels: s.channels,
          vitals: s.vitals,
          downloads: s.downloads,
          location: s.location,
          currency: s.currency,
          ecommerce: s.ecommerce,
          searchConsole: s.searchConsole,
          today: { visitors: (d?.visitors as number) ?? 0, pageviews: (d?.pageviews as number) ?? 0 },
          lastEventAt: (db.prepare("SELECT MAX(last_at) AS t FROM sessions WHERE site = ?").get(s.name) as { t: string | null }).t,
        };
      });
    },

    gauges() {
      const counts = all<{ site: string; n: number }>("SELECT site, COUNT(*) AS n FROM events GROUP BY site");
      return { sites: sites.size, events: Object.fromEntries(counts.map((c) => [c.site, c.n])) };
    },

    /** Deletes what is older than each site keeps it; sites no longer in the file keep the defaults. */
    purge() {
      const names = all<{ site: string }>("SELECT DISTINCT site FROM days").map((r) => r.site);
      for (const name of names) {
        const keep = sites.get(name)?.keep ?? { events: 90, days: 730 };
        const before = new Date(clock() - keep.events * DAY).toISOString();
        db.prepare("DELETE FROM events WHERE site = ? AND at < ?").run(name, before);
        db.prepare("DELETE FROM sessions WHERE site = ? AND last_at < ?").run(name, before);
        db.prepare("DELETE FROM visitor_days WHERE site = ? AND day < ?").run(name, before.slice(0, 10));
        db.prepare("DELETE FROM orders WHERE site = ? AND at < ?").run(name, before);
        db.prepare("DELETE FROM items WHERE site = ? AND at < ?").run(name, before);
        db.prepare("DELETE FROM search_console WHERE site = ? AND day < ?").run(name, new Date(clock() - keep.days * DAY).toISOString().slice(0, 10));
        db.prepare("DELETE FROM days WHERE site = ? AND day < ?").run(name, new Date(clock() - keep.days * DAY).toISOString().slice(0, 10));
      }
      // Replays go after their own days, and with the site when it records them no longer.
      for (const { site: name } of all<{ site: string }>("SELECT DISTINCT site FROM replay_chunks")) {
        const keep = sites.get(name)?.replays?.keep ?? 0;
        const before = new Date(clock() - keep * DAY).toISOString();
        db.prepare("DELETE FROM replay_chunks WHERE site = ? AND at < ?").run(name, before);
        db.prepare("UPDATE sessions SET replay = 0 WHERE site = ? AND replay = 1 AND id NOT IN (SELECT session FROM replay_chunks WHERE site = ?)").run(
          name,
          name,
        );
      }
    },
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;
