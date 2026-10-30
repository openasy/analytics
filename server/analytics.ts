import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ConfigFileState, Site } from "./config.ts";
import { agentOf, ignored, isBot, parseBatch, sourceOf, VisitError, type Batch } from "./visit.ts";

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

/** A path pattern as a GLOB: `*` is the only wildcard, so `?` and `[` stand for themselves. */
const glob = (pattern: string) => pattern.replace(/[[?]/g, (c) => `[${c}]`);

export interface AnalyticsOptions {
  /** Events a minute a site may send when the file gives it no limit. */
  defaultRate?: number;
  /** The key of each environment variable a site's serverKey names; process.env in production. */
  env?: Record<string, string | undefined>;
  /** The state of the sites file, for the pages that show it. */
  fileState?: () => ConfigFileState | null;
  /** For tests. */
  clock?: () => number;
}

export interface Ingest {
  body: unknown;
  /** The Origin header of a request from a page. */
  origin?: string;
  /** The x-analytics-key header of a request from a site's servers. */
  key?: string;
  userAgent?: string;
}

type Row = Record<string, any>;

export function createAnalytics(db: DatabaseSync, { defaultRate = 6000, env = process.env, fileState = () => null, clock = Date.now }: AnalyticsOptions = {}) {
  let sites = new Map<string, Site>();
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
      utm: { source: s.utm_source ?? null, medium: s.utm_medium ?? null, campaign: s.utm_campaign ?? null } as Record<
        "source" | "medium" | "campaign",
        string | null
      >,
      browser: s.browser as string,
      os: s.os as string,
      device: s.device as string,
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
    };
  }

  /** Removes everything kept about one visitor of a site; the daily totals, which name nobody, stay. */
  function forget(site: string, visitor: string): number {
    const n = db.prepare("DELETE FROM sessions WHERE site = ? AND visitor = ?").run(site, visitor).changes;
    db.prepare("DELETE FROM events WHERE site = ? AND visitor = ?").run(site, visitor);
    db.prepare("DELETE FROM visitor_days WHERE site = ? AND visitor = ?").run(site, visitor);
    return Number(n);
  }

  function store(site: Site, batch: Batch, userAgent: string, trusted: boolean): { accepted: number; dropped: number } {
    let accepted = 0;
    let dropped = 0;
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
        if (!s) {
          const agent = agentOf(userAgent);
          db.prepare("INSERT INTO sessions (site, id, visitor, user_id, started_at, last_at, browser, os, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            site.name,
            batch.session,
            batch.visitor,
            batch.user,
            e.at,
            e.at,
            agent.browser,
            agent.os,
            agent.device,
          );
          db.prepare("INSERT INTO days (site, day, visits) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET visits = visits + 1").run(site.name, day);
          s = db.prepare("SELECT * FROM sessions WHERE site = ? AND id = ?").get(site.name, batch.session) as Row;
        }
        if (e.type === "pageview") {
          // The first page of a visit says where it came from; later pages only move its exit.
          if (s.pageviews === 0) {
            db.prepare(
              "UPDATE sessions SET entry_path = ?, source = ?, referrer = ?, utm_source = ?, utm_medium = ?, utm_campaign = ? WHERE site = ? AND id = ?",
            ).run(
              a.path,
              sourceOf(e.referrer, site),
              sourceOf(e.referrer, site) && e.referrer ? (URL.parse(e.referrer)?.origin ?? null) : null,
              a.utm.source,
              a.utm.medium,
              a.utm.campaign,
              site.name,
              batch.session,
            );
          }
          db.prepare("UPDATE sessions SET pageviews = pageviews + 1, exit_path = ? WHERE site = ? AND id = ?").run(a.path, site.name, batch.session);
          db.prepare("INSERT INTO days (site, day, pageviews) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET pageviews = pageviews + 1").run(
            site.name,
            day,
          );
          s.pageviews = (s.pageviews as number) + 1;
        } else if (e.type !== "leave") {
          db.prepare("UPDATE sessions SET events = events + 1 WHERE site = ? AND id = ?").run(site.name, batch.session);
        }
        db.prepare(
          "UPDATE sessions SET last_at = MAX(last_at, ?), started_at = MIN(started_at, ?), user_id = COALESCE(user_id, ?) WHERE site = ? AND id = ?",
        ).run(e.at, e.at, batch.user, site.name, batch.session);
        if (db.prepare("INSERT OR IGNORE INTO visitor_days (site, day, visitor) VALUES (?, ?, ?)").run(site.name, day, batch.visitor).changes)
          db.prepare("INSERT INTO days (site, day, visitors) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET visitors = visitors + 1").run(
            site.name,
            day,
          );
        db.prepare(
          "INSERT INTO events (site, session, visitor, at, type, path, query, title, target, text, href, name, props, duration, scroll) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          e.href ? cleanHref(e.href, site) : null,
          e.name,
          e.props ? JSON.stringify(e.props) : null,
          e.duration,
          e.scroll,
        );
        accepted++;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { accepted, dropped };
  }

  /** A link that was clicked: the site's own as a path, another site's as its address without a query. */
  function cleanHref(href: string, site: Site): string | null {
    const url = URL.parse(href);
    if (!url) return null;
    if (url.protocol === "mailto:" || url.protocol === "tel:") return `${url.protocol}***`;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return (site.domains.includes(url.origin) ? url.pathname : url.origin + url.pathname).slice(0, 512);
  }

  /** The start of the period a report covers, as an ISO date, and its days. */
  function period(range: Range) {
    const days = lastDays(range, clock());
    return { from: `${days[0]}T00:00:00.000Z`, days };
  }

  const all = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];

  return {
    /** Takes the sites from the file. Returns warnings that did not stop it from being applied. */
    setSites(list: Site[]): string[] {
      sites = new Map(list.map((s) => [s.name, s]));
      for (const name of windows.keys()) if (!sites.has(name)) windows.delete(name);
      return list
        .filter((s) => s.serverKey && !env[s.serverKey])
        .map((s) => `${s.name}: serverKey names ${s.serverKey}, which is not set, so the site cannot send events from its servers.`);
    },
    sites: () => [...sites.values()],
    site: (name: string) => siteOf(name),

    /** Takes a batch from a page or from a site's servers. */
    ingest({ body, origin, key, userAgent = "" }: Ingest): { accepted: number; dropped: number } {
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
        batch = parseBatch(body, clock, (s) => sites.get(s)?.query ?? []);
      } catch (err) {
        if (err instanceof VisitError) throw new AnalyticsError(422, "invalid-batch", err.message);
        throw err;
      }
      // Consent withdrawn on the page: everything about this visitor goes.
      if (batch.events.some((e) => e.type === "forget")) {
        forget(site.name, batch.visitor);
        return { accepted: 0, dropped: batch.events.length };
      }
      return store(site, batch, userAgent, trusted);
    },

    /** Everything a report page draws for one site over a period. */
    report(name: string, range: Range) {
      const site = siteOf(name);
      const { from, days } = period(range);
      const s = site.name;
      const t = db
        .prepare(
          `SELECT COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS visits, COALESCE(SUM(pageviews), 0) AS pageviews,
             COALESCE(SUM(pageviews <= 1), 0) AS bounces,
             COALESCE(AVG((julianday(last_at) - julianday(started_at)) * 86400), 0) AS duration
           FROM sessions WHERE site = ? AND started_at >= ?`,
        )
        .get(s, from) as Row;
      const byDay = new Map(all<Row>("SELECT * FROM days WHERE site = ? AND day >= ?", s, days[0]!).map((d) => [d.day as string, d]));
      const series = days.map((day) => ({
        day,
        visitors: (byDay.get(day)?.visitors as number) ?? 0,
        visits: (byDay.get(day)?.visits as number) ?? 0,
        pageviews: (byDay.get(day)?.pageviews as number) ?? 0,
      }));
      const leave = new Map(
        all<Row>(
          "SELECT path, AVG(duration) AS duration, AVG(scroll) AS scroll FROM events WHERE site = ? AND at >= ? AND type = 'leave' GROUP BY path",
          s,
          from,
        ).map((r) => [r.path as string, r]),
      );
      const pages = all<Row>(
        `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors, MAX(title) AS title
         FROM events WHERE site = ? AND at >= ? AND type = 'pageview' GROUP BY path ORDER BY views DESC, path LIMIT 50`,
        s,
        from,
      ).map((r) => ({
        path: r.path as string,
        title: (r.title as string | null) ?? null,
        views: r.views as number,
        visitors: r.visitors as number,
        time: leave.get(r.path)?.duration == null ? null : Math.round(leave.get(r.path)!.duration / 1000),
        scroll: leave.get(r.path)?.scroll == null ? null : Math.round(leave.get(r.path)!.scroll),
      }));
      const count = (column: string, max = 20) =>
        all<Row>(
          `SELECT ${column} AS value, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM sessions
           WHERE site = ? AND started_at >= ? GROUP BY ${column} ORDER BY visits DESC, value LIMIT ?`,
          s,
          from,
          max,
        ).map((r) => ({ value: (r.value as string | null) ?? null, visits: r.visits as number, visitors: r.visitors as number }));
      const campaigns = all<Row>(
        `SELECT utm_source, utm_medium, utm_campaign, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM sessions
         WHERE site = ? AND started_at >= ? AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
         GROUP BY utm_source, utm_medium, utm_campaign ORDER BY visits DESC LIMIT 20`,
        s,
        from,
      ).map((r) => ({ source: r.utm_source ?? null, medium: r.utm_medium ?? null, campaign: r.utm_campaign ?? null, visits: r.visits, visitors: r.visitors }));
      const events = all<Row>(
        `SELECT name, COUNT(*) AS count, COUNT(DISTINCT visitor) AS visitors FROM events
         WHERE site = ? AND at >= ? AND type = 'event' GROUP BY name ORDER BY count DESC, name LIMIT 50`,
        s,
        from,
      ).map((r) => ({ name: r.name as string, count: r.count as number, visitors: r.visitors as number }));
      const clicks = all<Row>(
        `SELECT target, text, href, COUNT(*) AS count, COUNT(DISTINCT visitor) AS visitors FROM events
         WHERE site = ? AND at >= ? AND type = 'click' GROUP BY target, text, href ORDER BY count DESC LIMIT 50`,
        s,
        from,
      ).map((r) => ({ target: r.target ?? null, text: r.text ?? null, href: r.href ?? null, count: r.count as number, visitors: r.visitors as number }));
      const visits = t.visits as number;
      const goals = site.goals.map((g) => {
        const n = (
          g.path
            ? db
                .prepare("SELECT COUNT(DISTINCT session) AS n FROM events WHERE site = ? AND at >= ? AND type = 'pageview' AND path GLOB ?")
                .get(s, from, glob(g.path))
            : db.prepare("SELECT COUNT(DISTINCT session) AS n FROM events WHERE site = ? AND at >= ? AND type = 'event' AND name = ?").get(s, from, g.event)
        ) as { n: number };
        return { name: g.name, path: g.path, event: g.event, visits: n.n, rate: visits ? n.n / visits : 0 };
      });
      return {
        site: s,
        days: range,
        from,
        totals: {
          visitors: t.visitors as number,
          visits,
          pageviews: t.pageviews as number,
          bounceRate: visits ? (t.bounces as number) / visits : 0,
          duration: Math.round(t.duration as number),
        },
        series,
        pages,
        entries: count("entry_path").map((r) => ({ path: r.value, visits: r.visits, visitors: r.visitors })),
        exits: count("exit_path").map((r) => ({ path: r.value, visits: r.visits, visitors: r.visitors })),
        sources: count("source").map((r) => ({ source: r.value, visits: r.visits, visitors: r.visitors })),
        campaigns,
        browsers: count("browser", 10).map((r) => ({ name: r.value ?? "Other", visits: r.visits, visitors: r.visitors })),
        systems: count("os", 10).map((r) => ({ name: r.value ?? "Other", visits: r.visits, visitors: r.visitors })),
        devices: count("device", 3).map((r) => ({ name: r.value ?? "desktop", visits: r.visits, visitors: r.visitors })),
        events,
        clicks,
        goals,
      };
    },

    /** Visits of a site, newest first, of one visitor or one user of the site if asked. */
    visits(filter: { site: string; visitor?: string; user?: string }, cursor: string | undefined, max: number): Page<ReturnType<typeof presentSession>> {
      siteOf(filter.site);
      const where = ["site = ?"];
      const args: SQLInputValue[] = [filter.site];
      if (filter.visitor) (where.push("visitor = ?"), args.push(filter.visitor));
      if (filter.user) (where.push("user_id = ?"), args.push(filter.user));
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
      };
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
        db.prepare("DELETE FROM days WHERE site = ? AND day < ?").run(name, new Date(clock() - keep.days * DAY).toISOString().slice(0, 10));
      }
    },
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;
